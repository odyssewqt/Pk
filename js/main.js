// 主入口：大厅 → 联机对局装配
import { PokerGame, MAX_SEATS } from './engine.js';
import { renderTable, appendLog, clearLog, setTableMsg, showModal, resetEquityCache, showAmountModal, settlementHTML } from './ui.js';
import { describeEval, HAND_NAMES } from './poker.js';
import { getClientId, createRoom, fetchRoom, updateRoomState, mutateRoomState, casRoomState, RoomChannel, checkBackend } from './net.js';
import { serializeGame, buildViewModel, deriveOptions } from './sync.js';
import { renderLobby, setLobbyMsg, renderWaiting, setNetStatus, clearOverlay } from './lobby.js';
import { PROTOCOL_VERSION, BUILD_LABEL, compareVersion, readStateVersion, showVersionBlocker } from './version.js';
import { initChat, sendChat, makeMessage, MAX_CHAT } from './chat.js';
import { renderChat, bindChatUI, setChatEnabled, setChatUnread } from './chatui.js';
import { initPWA } from './pwa.js';
import { initMobileTabs, getCurrentTab, setTabUnread, setShellVisible } from './mobile.js';

const $ = id => document.getElementById(id);
const overlay = () => $('overlayRoot');

const CLIENT_ID = getClientId();

// ---------- 全局会话状态 ----------
const session = {
  code: null,
  isHost: false,
  mySeatId: null,
  myName: '',
  myAvatar: '🙂',
  seats: [],
  channel: null,
  subscribed: false,
  phase: 'lobby',
  lastVersion: 0,
  remoteState: null,
  pendingAction: null
};

let game = null;      // 房主端：真引擎；客机端：null
let viewModel = null; // 客机端：渲染用视图
let heroOpts = null;
let lastSettlementTs = 0; // 客机侧结算单去重
const handledBankReq = new Set(); // 房主侧借还请求去重

// 聊天本地镜像：远端 chat 数组 + 本地刚发出还没回环的消息。
// 先本地回显再等同步，手感上点了就有，不用等一个网络往返。
let chatLocal = [];
let chatUnread = 0;

// 合并远端聊天与本地待确认消息，按时间排序后去重
function mergeChat(remoteList) {
  const remote = Array.isArray(remoteList) ? remoteList.filter(Boolean) : [];
  const seen = new Set(remote.map(m => m.id));
  // 本地回显里凡是远端已有的就丢掉，剩下的是还在飞的
  chatLocal = chatLocal.filter(m => !seen.has(m.id));
  return [...remote, ...chatLocal]
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .slice(-MAX_CHAT);
}

// 统一刷新聊天面板
function refreshChat(remoteList) {
  const list = mergeChat(remoteList);
  renderChat(list, session.mySeatId, CLIENT_ID);
  trackUnread(list);
  return list;
}

// 已计入未读的消息 id，避免同一条消息被反复累加。
// 每次远端状态同步都会整份重刷聊天，必须按 id 去重。
const seenChatIds = new Set();
let chatSeeded = false;

// 聊天面板当前是否真的看得见：
// 窄屏下只有切到「聊天」标签才算可见；宽屏侧边栏常驻，始终算可见。
function chatVisible() {
  if (document.hidden) return false;
  const panel = document.getElementById('chatPanel');
  if (!panel || panel.classList.contains('hidden')) return false;
  const narrow = window.matchMedia('(max-width: 1279px)').matches;
  return narrow ? getCurrentTab() === 'chat' : true;
}

function applyUnread() {
  setChatUnread(chatUnread);
  setTabUnread(chatUnread);
}

// 累加未读：只统计别人发的、面板不可见时到达的新消息
function trackUnread(list) {
  const msgs = Array.isArray(list) ? list.filter(Boolean) : [];

  // 首次进房时把已有历史全部标记为已读，避免一进来就顶着一堆红点
  if (!chatSeeded) {
    msgs.forEach(m => seenChatIds.add(m.id));
    chatSeeded = true;
    return;
  }

  const visible = chatVisible();
  let added = 0;
  msgs.forEach(m => {
    if (seenChatIds.has(m.id)) return;
    seenChatIds.add(m.id);
    // 自己发的和系统提示不计未读
    if (m.owner === CLIENT_ID || m.kind === 'system') return;
    added++;
  });

  if (visible) {
    chatUnread = 0;
  } else if (added > 0) {
    chatUnread += added;
  }
  applyUnread();
}

// 面板变为可见时清空未读（切标签、切回前台都会触发）
function markChatRead() {
  if (!chatVisible()) return;
  if (chatUnread === 0) return;
  chatUnread = 0;
  applyUnread();
}

const RULES_HTML = `
<p class="text-slate-300">德州扑克使用一副 52 张牌，每位玩家发 2 张底牌，桌面依次开出 5 张公共牌，用 7 张中最好的 5 张组成牌型比大小。</p>
<div class="rounded-lg bg-white/5 p-3">
  <div class="font-bold text-gold mb-1">四个下注轮</div>
  <div>翻牌前（2 张底牌）→ 翻牌（3 张公共牌）→ 转牌（第 4 张）→ 河牌（第 5 张）</div>
</div>
<div class="rounded-lg bg-white/5 p-3">
  <div class="font-bold text-gold mb-1">牌型从大到小</div>
  <div>${Object.keys(HAND_NAMES).sort((a, b) => b - a).map(k => HAND_NAMES[k]).join(' > ')}</div>
</div>
<div class="rounded-lg bg-white/5 p-3">
  <div class="font-bold text-gold mb-1">你的操作</div>
  <div>弃牌：放弃本手牌；过牌：不下注（仅当无人加注）；跟注：补齐当前注额；加注：提高注额；All-in：押上全部筹码。</div>
</div>
<div class="rounded-lg bg-white/5 p-3">
  <div class="font-bold text-gold mb-1">联机说明</div>
  <div>房主的浏览器负责发牌与推进牌局。若房主关闭页面，本局将无法继续。这是信任局，技术上不做底牌隔离。</div>
</div>`;

// ---------- 座位工具 ----------
// 六人桌：0 号是房主，1 号默认开放给真人，其余先用 AI 占位，房主可在等待界面调整
function buildInitialSeats(name, avatar) {
  const seats = [{ type: 'human', owner: CLIENT_ID, name, avatar }];
  seats.push({ type: 'human', owner: null, name: '', avatar: '' });
  for (let i = 2; i < MAX_SEATS; i++) seats.push({ type: 'ai' });
  return seats;
}

function humanCount(seats) {
  return (seats || []).filter(s => s.type === 'human' && s.owner).length;
}

// 找一个可坐的位置：优先空着的真人位，其次把 AI 位挤掉
function findOpenSeat(seats) {
  let idx = seats.findIndex(s => s.type === 'human' && !s.owner);
  if (idx >= 0) return idx;
  return seats.findIndex(s => s.type === 'ai');
}

// ---------- 当前渲染对象 ----------
// 开牌停顿倒计时：让玩家清楚还有多久公布结果，避免以为卡住了
let showdownTimer = null;

function stopShowdownCountdown() {
  if (showdownTimer) clearInterval(showdownTimer);
  showdownTimer = null;
}

function startShowdownCountdown(ms) {
  stopShowdownCountdown();
  let left = Math.ceil(ms / 1000);
  setTableMsg(`开牌！比较牌型… ${left}s`);
  showdownTimer = setInterval(() => {
    left--;
    if (left <= 0) { stopShowdownCountdown(); return; }
    setTableMsg(`开牌！比较牌型… ${left}s`);
  }, 1000);
}

function currentGame() {
  return session.isHost ? game : viewModel;
}

function refresh() {
  const g = currentGame();
  if (g) renderTable(g);
}

// ================= 大厅流程 =================

function showLobby() {
  session.phase = 'lobby';
  // 大厅只留覆盖层，牌桌 / 借贷 / 日志 / 标签栏全部收起
  setShellVisible(false);
  renderLobby(overlay(), {
    defaultName: localStorage.getItem('poker_name') || '',
    onCreate: handleCreate,
    onJoin: handleJoin
  });
}

async function handleCreate({ name, avatar, code }) {
  localStorage.setItem('poker_name', name);
  setLobbyMsg('正在创建房间…');
  session.isHost = true;
  session.mySeatId = 0;
  session.myName = name;
  session.myAvatar = avatar;
  session.code = code;
  session.seats = buildInitialSeats(name, avatar);

  const initial = {
    v: 1,
    pv: PROTOCOL_VERSION,
    phase: 'waiting',
    seats: session.seats,
    hostId: CLIENT_ID,
    action: null,
    ts: Date.now()
  };

  try {
    await createRoom(code, CLIENT_ID, initial);
  } catch (err) {
    console.error(err);
    setLobbyMsg(`建房失败：${err.message}`, 'error');
    return;
  }

  session.lastVersion = 1;
  session.remoteState = initial;
  setLobbyMsg('正在建立实时连接…');
  try {
    await openChannelAndWait();
  } catch (err) {
    console.error(err);
    setLobbyMsg(`实时连接失败：${err.message}`, 'error');
    return;
  }
  showWaiting();
}

async function handleJoin({ name, avatar, code }) {
  localStorage.setItem('poker_name', name);
  setLobbyMsg('正在查找房间…');

  let room;
  try {
    room = await fetchRoom(code);
  } catch (err) {
    console.error(err);
    setLobbyMsg(`查询失败：${err.message}`, 'error');
    return;
  }
  if (!room) {
    setLobbyMsg('房间不存在，检查房间码是否输错', 'error');
    return;
  }

  const state = room.state || {};
  const seats = state.seats || [];

  // 版本校验必须放在写入座位之前：
  // 旧页面与新页面对状态结构的理解不同，一旦混跑可能把账算错，
  // 所以宁可拦在门外，也不让它进桌。
  const cmp = compareVersion(state);
  if (cmp !== 'same') {
    const remote = readStateVersion(state);
    const reason = cmp === 'client-old'
      ? '这个房间由更新版本的页面创建，你的页面还是旧代码，直接入座可能导致筹码和账本算错。'
      : '你的页面比这个房间更新，说明房主那边还在跑旧代码。请让房主先刷新页面并重新建房。';
    setLobbyMsg('页面版本不一致，已阻止入座', 'error');
    showVersionBlocker({ mine: PROTOCOL_VERSION, remote, reason });
    return;
  }

  // 若本客户端已在座（刷新重连），直接回到原座位
  const existing = seats.findIndex(s => s.owner === CLIENT_ID);
  let seatIdx = existing;
  if (seatIdx < 0) {
    seatIdx = findOpenSeat(seats);
    if (seatIdx < 0) {
      setLobbyMsg('六个座位都坐满了，等有人离开再试', 'error');
      return;
    }
    seats[seatIdx] = { type: 'human', owner: CLIENT_ID, name, avatar };
  }

  session.isHost = false;
  session.mySeatId = seatIdx;
  session.myName = name;
  session.myAvatar = avatar;
  session.code = code;
  session.seats = seats;
  session.lastVersion = state.v || 0;

  const next = { ...state, seats, pv: PROTOCOL_VERSION, v: (state.v || 0) + 1, ts: Date.now() };

  // 先建立订阅再写入座位，否则房主可能收不到本次入座事件
  setLobbyMsg('正在建立实时连接…');
  try {
    await openChannelAndWait();
  } catch (err) {
    console.error(err);
    setLobbyMsg(`实时连接失败：${err.message}`, 'error');
    return;
  }

  session.remoteState = next;
  try {
    await updateRoomState(code, next);
  } catch (err) {
    console.error(err);
    setLobbyMsg(`入座失败：${err.message}`, 'error');
    return;
  }

  session.lastVersion = next.v;
  if (next.phase === 'playing') {
    enterGameAsClient(next);
  } else {
    showWaiting();
  }
}

// 建立通道并等到数据库订阅确认，超时则报错
function openChannelAndWait(timeout = 12000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; reject(new Error('订阅超时，请检查网络或 Realtime 配置')); }
    }, timeout);

    session.channel?.close();
    session.subscribed = false;
    session.channel = new RoomChannel(session.code, {
      onState: row => handleRemoteRow(row),
      onStatus: st => {
        if (st === 'subscribed') {
          session.subscribed = true;
          flushPendingPush();
          if (!done) { done = true; clearTimeout(timer); resolve(); }
        } else if (st === 'subscribe_failed' || st === 'system_error') {
          if (!done) { done = true; clearTimeout(timer); reject(new Error('订阅被拒绝，请检查 RLS 与 publication')); }
        } else if (st === 'closed' || st === 'error') {
          session.subscribed = false;
        }
        handleNetStatus(st);
      }
    });
    session.channel.connect();
  });
}

function showWaiting() {
  session.phase = 'waiting';
  // 等待界面同样是全屏覆盖层，此时牌桌 / 借贷 / 日志都还没有内容，
  // 外壳继续保持隐藏，直到房主真正开局才显示。
  setShellVisible(false);
  // 进了房间就能聊天，不必等开局
  setChatEnabled(!!session.code);
  renderWaiting(overlay(), {
    code: session.code,
    seats: session.seats,
    isHost: session.isHost,
    mySeatId: session.mySeatId,
    onStart: hostStartGame,
    onLeave: leaveRoom,
    onToggleSeat: hostToggleSeat
  });
  setNetStatus('实时连接中…');
}

function leaveRoom() {
  session.channel?.close();
  session.channel = null;
  game = null;
  viewModel = null;
  session.code = null;
  session.seats = [];
  session.remoteState = null;
  // 聊天记录属于房间，离开就清空，避免下一个房间串台
  chatLocal = [];
  chatUnread = 0;
  setChatUnread(0);
  setTabUnread(0);
  // 未读去重集合属于房间，一并清空并重新进入「首次填充」状态
  seenChatIds.clear();
  chatSeeded = false;
  refreshChat([]);
  setChatEnabled(false);
  clearLog();
  showLobby();
}

// 房主在等待界面切换某个座位：AI 占位 ↔ 开放给真人
async function hostToggleSeat(idx) {
  if (!session.isHost) return;
  const seats = session.seats.map(s => ({ ...s }));
  const seat = seats[idx];
  if (!seat || (seat.type === 'human' && seat.owner)) return;
  seats[idx] = seat.type === 'ai'
    ? { type: 'human', owner: null, name: '', avatar: '' }
    : { type: 'ai' };
  session.seats = seats;
  showWaiting();
  await pushSeats();
}

// 把座位表单独同步出去（等待阶段用，不含牌局数据）
async function pushSeats() {
  const state = session.remoteState || {};
  const next = { ...state, seats: session.seats, v: (session.lastVersion || 0) + 1, ts: Date.now() };
  session.lastVersion = next.v;
  session.remoteState = next;
  try {
    await updateRoomState(session.code, next);
  } catch (err) {
    console.error('[sync] 座位同步失败', err);
    setNetStatus('座位同步失败，请检查网络', 'error');
  }
}

// ================= Realtime 通道 =================

function handleNetStatus(st) {
  const map = {
    connected: ['已连接，正在订阅…', 'info'],
    joined: ['频道已加入，等待数据库订阅…', 'info'],
    subscribed: ['实时同步已就绪', 'ok'],
    subscribe_failed: ['订阅被拒绝，请检查 RLS 与 publication 设置', 'error'],
    system_error: ['服务端返回错误，详见控制台', 'error'],
    error: ['连接出错，正在重试…', 'error'],
    closed: ['连接已断开，正在重连…', 'error']
  };
  const [text, type] = map[st] || [st, 'info'];
  setNetStatus(text, type);
  const badge = $('netBadge');
  if (badge) {
    badge.textContent = text;
    badge.className = `px-2 py-1 rounded text-[11px] ${type === 'ok' ? 'bg-emerald-500/20 text-emerald-300' : type === 'error' ? 'bg-rose-500/20 text-rose-300' : 'bg-white/10 text-slate-300'}`;
  }
}

function handleRemoteRow(row) {
  const state = row.state;
  if (!state) return;

  // 运行中版本检测：房间的协议版本一旦与本页面不符，
  // 立刻停止处理任何后续状态并弹出刷新提示。
  // 放在最前面是刻意的——不能让一条不兼容的状态先把本地数据改坏。
  if (compareVersion(state) !== 'same') {
    const remote = readStateVersion(state);
    console.error('[version] 协议版本不一致，已停止同步', PROTOCOL_VERSION, 'vs', remote);
    session.channel?.close();
    session.channel = null;
    showVersionBlocker({
      mine: PROTOCOL_VERSION,
      remote,
      reason: '房间的代码版本已经变了，为避免筹码算错，本页面已停止同步。请刷新后重新加入。'
    });
    return;
  }

  // 版本回退保护：忽略比本地更旧的状态。
  // 但客机动作不参与版本自增，人多并发时可能带着相同或更小的 v 到达，
  // 房主必须先把动作收下，否则借还请求会被当成「过期状态」直接丢掉。
  const hasIncomingAction = !!(state.action || (Array.isArray(state.actionQueue) && state.actionQueue.length));
  if (state.v && state.v < session.lastVersion && !(session.isHost && hasIncomingAction)) {
    console.warn('[sync] 忽略过期状态', state.v, '<', session.lastVersion);
    return;
  }
  if ((state.v || 0) >= session.lastVersion) session.lastVersion = state.v || session.lastVersion;
  session.remoteState = state;

  // 聊天对房主与客机是同一份数据，先统一刷新再走各自分支
  refreshChat(state.chat);

  if (session.isHost) {
    // 房主：只关心座位变化与客机回传的动作
    if (state.seats) {
      session.seats = state.seats;
      if (session.phase === 'waiting') showWaiting();
      else if (session.phase === 'playing') applySeatChange();
    }
    // 借还已由客机自助写入账本，房主只需采纳差额并兑换筹码
    if (state.bank) game.adoptBank(state.bank);
    if (state.action || (Array.isArray(state.actionQueue) && state.actionQueue.length)) consumeActionQueue(state);
    return;
  }

  // 客机：座位与阶段同步
  if (state.seats) session.seats = state.seats;

  if (state.phase === 'playing') {
    enterGameAsClient(state);
  } else if (state.phase === 'waiting' && session.phase !== 'waiting') {
    showWaiting();
  } else if (session.phase === 'waiting') {
    showWaiting();
  }
}

// ================= 房主端 =================

function hostStartGame() {
  // 六人桌至少要有房主自己，人数不够由 AI 补齐
  if (humanCount(session.seats) < 1) return;

  clearOverlay(overlay());
  session.phase = 'playing';
  setShellVisible(true);
  clearLog();
  initHostGame();
}

// 座位变更只在牌局间隙生效，手牌进行中先挂起
let seatChangePending = false;

function applySeatChange() {
  if (!game || !session.isHost) return;
  const idle = game.stage === 'idle' || game.stage === 'over';
  if (!idle) {
    if (!seatChangePending) {
      seatChangePending = true;
      const waiting = humanCount(session.seats);
      game.log(`有玩家请求入座，将在本手结束后生效（当前真人 ${waiting} 位）`, 'info');
    }
    return;
  }
  seatChangePending = false;
  const before = game.players.filter(p => !p.isAI).map(p => p.seatOwner).join(',');
  if (game.applySeats(session.seats)) {
    const after = game.players.filter(p => !p.isAI).map(p => p.seatOwner).join(',');
    if (before !== after) {
      game.log(`座位已更新 · 真人 ${humanCount(session.seats)} 位，其余由 AI 补齐`, 'stage');
    }
    renderTable(game);
    pushState();
  }
}

function initHostGame() {
  game = new PokerGame({
    smallBlind: 25,
    startingStack: 2000,
    seats: session.seats,
    heroSeatId: session.mySeatId,
    isAuthority: true
  });

  game.on('log', appendLog);
  game.on('update', () => { renderTable(game); pushState(); });
  game.on('handStart', () => { resetEquityCache(); setTableMsg('新一手开始'); });
  game.on('stageChange', () => resetEquityCache());
  game.on('heroTurn', opts => {
    heroOpts = opts;
    renderHeroControls(opts);
    setTableMsg('轮到你行动');
  });
  game.on('waitRemote', p => {
    renderWaitControls(`等待 ${p.name} 行动…`);
    setTableMsg(`等待 ${p.name}`);
  });
  game.on('revealCards', () => {
    heroOpts = null;
    renderWaitControls('开牌，请比较各家牌型…');
  });
  game.on('showdownPending', ({ ms }) => startShowdownCountdown(ms));
  game.on('handEnd', res => {
    heroOpts = null;
    stopShowdownCountdown();
    renderEndControls();
    const meWin = res.winners.find(w => w.player.isHero);
    setTableMsg(meWin ? `你赢得 ${meWin.amount} 筹码！` : `${res.winners.map(w => w.player.name).join('、') || '其他玩家'} 赢下本局`);
    showResultModal(res);
    // 牌局间隙：让等待中的新玩家入座
    if (seatChangePending) setTimeout(() => applySeatChange(), 300);
  });
  game.on('bankChange', () => { renderTable(game); });
  game.on('gameOver', ({ hero }) => {
    showModal({
      title: '🏆 牌局暂停',
      body: `<p>本次共进行 <b class="text-gold">${game.record.hands}</b> 手，胜 <b class="text-emerald-300">${game.record.wins}</b> 手，当前筹码 <b class="text-gold">${hero.stack}</b>。</p>
        <p class="text-xs text-slate-400">人数不足或需要补码时，可从牌池借入筹码后继续。</p>`,
      actions: [{ label: '知道了', primary: true }]
    });
  });

  const settleBtn = $('btnSettle');
  if (settleBtn) settleBtn.classList.toggle('hidden', !session.isHost);

  renderIdleControls();
  renderTable(game);
  game.log('联机牌局已建立，点击「开始新一局」发牌。', 'stage');
  pushState();
}

let pushTimer = null;
let pushPending = false;

function flushPendingPush() {
  if (pushPending) {
    pushPending = false;
    pushState();
  }
}

function pushState() {
  if (!session.isHost || !game) return;
  // 订阅未就绪时先挂起，否则这次写入的变更事件对方收不到
  if (!session.subscribed) {
    pushPending = true;
    return;
  }
  // 合并高频 update，避免一次动作触发多次写库。
  // 延迟从 120ms 收敛到 40ms：原值在人多时会和网络往返叠加，点击后要等一会儿才有反应。
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    const state = serializeGame(game, {
      v: session.lastVersion,
      phase: 'playing',
      seats: session.seats
    });
    // 房主写整行会覆盖客机刚写的账本，这里取两边较大值合并：
    // 借还只增不减，取 max 既不丢玩家自助记账，也不会重复计数。
    const remoteBank = session.remoteState?.bank;
    if (remoteBank && state.bank) {
      Object.keys(remoteBank).forEach(k => {
        const mine = state.bank[k] || { borrowed: 0, repaid: 0, buyIn: 0 };
        const theirs = remoteBank[k] || {};
        state.bank[k] = {
          borrowed: Math.max(mine.borrowed || 0, theirs.borrowed || 0),
          repaid: Math.max(mine.repaid || 0, theirs.repaid || 0),
          buyIn: mine.buyIn || theirs.buyIn || 0
        };
      });
    }
    // 队列内的请求已被房主消费，随权威状态一并清空，
    // 否则队列会持续变大，载荷越来越沉，人多时明显卡顿。
    state.actionQueue = [];
    state.action = null;
    // 房主写整行同样会覆盖聊天记录，必须把远端最新的 chat 带上，
    // 并合入本地还没回环的消息，否则一推状态大家的发言就没了。
    state.chat = mergeChat(session.remoteState?.chat);
    session.lastVersion = state.v;
    try {
      // 房主也走 CAS：若客机在此期间写入了账本，本次写入会失败，
      // 此时重新采纳最新账本再推一次，保证谁的记账都不会丢。
      const won = await casRoomState(session.code, state, session.lastVersion - 1);
      if (!won) {
        const row = await fetchRoom(session.code);
        if (row?.state?.bank) {
          game.adoptBank(row.state.bank);
          session.remoteState = row.state;
          session.lastVersion = row.state.v || session.lastVersion;
        }
        // 重读到的行里可能有别人刚发的消息，同步进来再重推
        if (row?.state) refreshChat(row.state.chat);
        pushPending = true;
        setTimeout(flushPendingPush, 80);
        return;
      }
    } catch (err) {
      console.error('[sync] 写入失败', err);
      handleNetStatus('error');
    }
  }, 40);
}

// 房主侧：把队列里所有没处理过的请求按时间顺序全部消费掉。
// 之前只读 state.action 单个字段，人多时并发写入互相覆盖，请求会静默丢失。
function consumeActionQueue(state) {
  if (!game || !session.isHost) return;
  const queue = Array.isArray(state.actionQueue) && state.actionQueue.length
    ? state.actionQueue
    : (state.action ? [state.action] : []);
  if (!queue.length) return;

  const pending = queue
    .filter(a => a && a.seatId !== session.mySeatId)
    .filter(a => {
      const rid = a.rid || `${a.seatId}:${a.ts}`;
      if (handledBankReq.has(rid)) return false;
      handledBankReq.add(rid);
      return true;
    })
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));

  if (!pending.length) return;
  // 去重集合无上限会随对局无限增长，保留最近若干条即可
  if (handledBankReq.size > 400) {
    const keep = [...handledBankReq].slice(-200);
    handledBankReq.clear();
    keep.forEach(k => handledBankReq.add(k));
  }
  pending.forEach(consumeClientAction);
}

function consumeClientAction(action) {
  if (!game || !session.isHost) return;

  // 借还筹码请求：不属于下注轮，单独处理，不受行动顺序限制
  if (action.action === 'borrow' || action.action === 'repay') {
    if (action.seatId === session.mySeatId) return;
    // 去重已在 consumeActionQueue 统一按 rid 处理，此处不再重复拦截
    const res = action.action === 'borrow'
      ? game.borrow(action.seatId, action.amount || 0)
      : game.repay(action.seatId, action.amount || 0);
    if (!res.ok) game.log(`${game.players[action.seatId]?.name || '玩家'} 的${action.action === 'borrow' ? '借码' : '还码'}请求被拒绝：${res.msg}`, 'warn');
    // 成功时引擎会 emit('update')，已绑定 pushState，无需重复写库
    return;
  }

  if (action.seatId === session.mySeatId) return;
  if (game.activeIndex !== action.seatId) {
    console.warn('[sync] 丢弃非当前行动方的动作', action);
    return;
  }
  if (action.handNo != null && action.handNo !== game.handNo) {
    console.warn('[sync] 丢弃过期手牌的动作', action);
    return;
  }
  game.applyAction(action.seatId, action.action, action.amount || 0);
}

// ================= 牌池借贷 =================

// 取当前渲染对象里的本人座位
function mySeatPlayer() {
  const g = currentGame();
  if (!g) return null;
  return g.players.find(p => p.id === session.mySeatId) || null;
}

function bankIdle() {
  const g = currentGame();
  if (!g) return false;
  return g.stage === 'idle' || g.stage === 'over';
}

function handleBorrow() {
  const me = mySeatPlayer();
  if (!me) {
    showModal({
      title: '还没上桌',
      body: '<p>牌池借贷需要先进入房间并落座。请先建房或用房间码加入，坐下后即可向牌池借筹码。</p>',
      actions: [{ label: '知道了', primary: true }]
    });
    return;
  }
  if (!bankIdle()) {
    showModal({ title: '暂时无法借码', body: '<p>牌局进行中不能改动筹码，等本手结束后再借。</p>', actions: [{ label: '知道了', primary: true }] });
    return;
  }
  const g = currentGame();
  const bb = g ? g.bigBlind : 50;
  showAmountModal({
    title: '从牌池借筹码',
    hint: `牌池筹码<b class="text-violet-300">无上限</b>，借多少由你决定。借出的筹码会全额记账，结算时从你的盈利中扣除。<br>当前手上 <b class="text-gold">${me.stack}</b> · 已借 <b class="text-violet-300">${me.borrowed || 0}</b> · 净欠 <b class="text-rose-300">${Math.max(0, (me.borrowed || 0) - (me.repaid || 0))}</b>`,
    presets: [bb * 10, bb * 20, bb * 40, bb * 100],
    max: 0,
    confirmLabel: '确认借入',
    onConfirm: amt => {
      if (session.isHost) {
        const res = game.borrow(session.mySeatId, amt);
        if (!res.ok) showModal({ title: '借码失败', body: `<p>${res.msg}</p>`, actions: [{ label: '知道了', primary: true }] });
      } else {
        submitBankOp('borrow', amt);
      }
    }
  });
}

function handleRepay() {
  const me = mySeatPlayer();
  if (!me) {
    showModal({
      title: '还没上桌',
      body: '<p>牌池借贷需要先进入房间并落座。请先建房或用房间码加入，坐下后即可归还筹码。</p>',
      actions: [{ label: '知道了', primary: true }]
    });
    return;
  }
  if (!bankIdle()) {
    showModal({ title: '暂时无法还码', body: '<p>牌局进行中不能改动筹码，等本手结束后再还。</p>', actions: [{ label: '知道了', primary: true }] });
    return;
  }
  const debt = Math.max(0, (me.borrowed || 0) - (me.repaid || 0));
  if (debt <= 0) {
    showModal({ title: '无需归还', body: '<p>你目前没有欠牌池筹码。</p>', actions: [{ label: '知道了', primary: true }] });
    return;
  }
  const cap = Math.min(debt, me.stack);
  if (cap <= 0) {
    showModal({ title: '筹码不足', body: `<p>你净欠牌池 <b class="text-rose-300">${debt}</b>，但手上没有筹码可还。</p>`, actions: [{ label: '知道了', primary: true }] });
    return;
  }
  const presets = [Math.floor(cap / 4), Math.floor(cap / 2), Math.floor(cap * 3 / 4)].filter(v => v > 0);
  showAmountModal({
    title: '向牌池归还筹码',
    hint: `你净欠牌池 <b class="text-rose-300">${debt}</b>，手上有 <b class="text-gold">${me.stack}</b>，本次最多可还 <b class="text-emerald-300">${cap}</b>。归还多少自由决定。`,
    presets: [...new Set(presets)],
    max: cap,
    confirmLabel: '确认归还',
    onConfirm: amt => {
      if (session.isHost) {
        const res = game.repay(session.mySeatId, amt);
        if (!res.ok) showModal({ title: '还码失败', body: `<p>${res.msg}</p>`, actions: [{ label: '知道了', primary: true }] });
      } else {
        submitBankOp('repay', amt);
      }
    }
  });
}

// 客机侧：借还筹码直接写进自己的账本条目，不再经房主中转。
// 借贷本质是「改自己的两个数字」，不涉及牌桌顺序，无需权威端裁决。
// mutateRoomState 用 CAS 保证并发安全：抢输就重读最新状态再合并，
// 因此人再多也不会互相覆盖，房主掉线同样能借还。
async function submitBankOp(kind, amt) {
  const me = mySeatPlayer();
  if (!me) return;
  const key = me.ledgerKey || (me.seatOwner ? `owner:${me.seatOwner}` : `seat:${me.id}`);
  const label = kind === 'borrow' ? '借入' : '归还';
  setTableMsg(`正在${label} ${amt}…`);

  try {
    const out = await mutateRoomState(session.code, state => {
      // 牌局进行中禁止改筹码，否则破坏当前下注轮的边池计算
      if (state.stage && state.stage !== 'idle' && state.stage !== 'over') {
        throw new Error('牌局进行中无法改动筹码，请等本手结束');
      }
      const bank = { ...(state.bank || {}) };
      const rec = { ...(bank[key] || { borrowed: 0, repaid: 0 }) };
      const seat = (state.players || []).find(p => p.ledgerKey === key || p.id === me.id);
      const stack = seat ? seat.stack : me.stack;

      if (kind === 'borrow') {
        rec.borrowed += amt;
      } else {
        const debt = Math.max(0, rec.borrowed - rec.repaid);
        if (debt <= 0) throw new Error('你没有欠牌池筹码');
        if (amt > debt) throw new Error(`最多只需归还 ${debt}`);
        if (amt > stack) throw new Error(`手上只有 ${stack}，不够归还 ${amt}`);
        rec.repaid += amt;
      }
      rec.ts = Date.now();
      bank[key] = rec;
      state.bank = bank;
      // 记一笔流水，供房主与其他客机显示
      const feed = Array.isArray(state.bankFeed) ? state.bankFeed.slice(-30) : [];
      feed.push({ key, seatId: me.id, name: me.name, type: kind, amount: amt, ts: Date.now() });
      state.bankFeed = feed;
      return state;
    });

    if (!out.ok) {
      setTableMsg('');
      showModal({
        title: `${label}失败`,
        body: `<p>${out.msg}</p><p class="text-xs text-slate-400">同时操作的人较多，稍等一下再试即可。</p>`,
        actions: [{ label: '知道了', primary: true }]
      });
      return;
    }
    setTableMsg(`已${label} ${amt}`);
    setTimeout(() => setTableMsg(''), 1500);
  } catch (err) {
    setTableMsg('');
    showModal({
      title: `${label}失败`,
      body: `<p>${err.message || '写入失败，请重试'}</p>`,
      actions: [{ label: '知道了', primary: true }]
    });
  }
}

// 房主结算：算清每个人的真实输赢
function handleSettle() {
  if (!session.isHost || !game) return;
  if (!bankIdle()) {
    showModal({ title: '暂时无法结算', body: '<p>牌局进行中，请等本手结束后再结算。</p>', actions: [{ label: '知道了', primary: true }] });
    return;
  }
  const s = game.settleTable();
  showSettlementModal(s);
}

function showSettlementModal(s) {
  showModal({
    title: '💰 本场结算',
    body: settlementHTML(s),
    actions: [{ label: '关闭', primary: true }]
  });
}

// ================= 客机端 =================

function enterGameAsClient(state) {
  if (session.phase !== 'playing') {
    clearOverlay(overlay());
    session.phase = 'playing';
    // 客机可能直接从大厅跳进已开始的牌局，这里必须补一次显示
    setShellVisible(true);
    clearLog();
  }
  viewModel = buildViewModel(state, session.mySeatId, CLIENT_ID);
  renderTable(viewModel);

  // 房主发起结算后，客机也弹出同一份结算单（按时间戳去重，避免重复弹）
  const st = state.settlement;
  if (st && st.ts && st.ts !== lastSettlementTs) {
    lastSettlementTs = st.ts;
    showSettlementModal(st);
  }

  // 同步日志：只补新增部分
  syncClientLogs(state.logs || []);

  // 本手已在进行，但我的座位还没被房主纳入牌局：等下一手
  const mySeat = (state.players || []).find(p => p.id === session.mySeatId);
  const seatedIn = mySeat && mySeat.seatOwner === CLIENT_ID;
  if (!seatedIn && state.stage !== 'idle' && state.stage !== 'over') {
    heroOpts = null;
    renderWaitControls('本手进行中，你将在下一手入座…');
    setTableMsg('等待下一手入座');
    return;
  }

  const stage = state.stage;
  if (stage === 'showdown') {
    heroOpts = null;
    renderWaitControls('开牌，请比较各家牌型…');
    setTableMsg('开牌！比较牌型…');
    return;
  }
  if (stage === 'over') {
    heroOpts = null;
    renderEndControls();
    setTableMsg('本局结束，等房主开下一局');
    return;
  }
  if (stage === 'idle') {
    renderWaitControls('等房主发牌…');
    setTableMsg('等待房主开局');
    return;
  }

  if (state.activeIndex === session.mySeatId) {
    heroOpts = deriveOptions(state, session.mySeatId);
    if (heroOpts) {
      renderHeroControls(heroOpts);
      setTableMsg('轮到你行动');
    }
  } else {
    const actor = (state.players || []).find(p => p.id === state.activeIndex);
    heroOpts = null;
    renderWaitControls(`等待 ${actor ? actor.name : '其他玩家'} 行动…`);
    setTableMsg(actor ? `等待 ${actor.name}` : '等待其他玩家');
  }
}

let clientLogCount = 0;
function syncClientLogs(logs) {
  if (logs.length < clientLogCount) clientLogCount = 0;
  for (let i = clientLogCount; i < logs.length; i++) appendLog(logs[i]);
  clientLogCount = logs.length;
}

async function sendClientAction(action, amount = 0) {
  const state = session.remoteState;
  if (!state) return;
  const req = {
    seatId: session.mySeatId,
    action,
    amount,
    handNo: state.handNo,
    by: CLIENT_ID,
    ts: Date.now(),
    rid: `${CLIENT_ID}:${session.mySeatId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  };
  // 关键：动作走「追加队列」而不是单个字段。
  // 多人同时操作时，单字段写入会被后一个人覆盖，房主永远读不到被覆盖的那条，
  // 表现就是借还筹码「点了没反应」。队列保留所有未处理请求。
  const queue = Array.isArray(state.actionQueue) ? state.actionQueue.slice(-40) : [];
  queue.push(req);
  const next = {
    ...state,
    // 不再自增 v。客机各自基于陈旧 remoteState 计算会算出相同的 v，
    // 反而触发房主的版本回退保护把请求当成过期状态丢掉。
    actionQueue: queue,
    action: req,
    ts: Date.now()
  };
  try {
    await updateRoomState(session.code, next);
  } catch (err) {
    console.error('[sync] 动作发送失败', err);
    setTableMsg('操作发送失败，请重试');
    if (heroOpts) renderHeroControls(heroOpts);
  }
}

// ================= 操作区渲染 =================

function btn(id, label, cls, icon) {
  return `<button data-act="${id}" class="px-3 py-2.5 rounded-lg font-bold text-sm transition ${cls}">
    ${icon ? `<i class="${icon} mr-1"></i>` : ''}${label}</button>`;
}

function renderIdleControls() {
  $('actionHint').innerHTML = `<span class="text-gold font-bold">准备就绪</span> · 起始筹码 2000，盲注 25/50`;
  $('actionButtons').innerHTML = session.isHost
    ? btn('start', '开始新一局', 'bg-gold text-ink hover:brightness-110 col-span-2 sm:col-span-5', 'ri-play-circle-line')
    : btn('none', '等房主发牌…', 'bg-white/5 text-slate-500 cursor-not-allowed col-span-2 sm:col-span-5');
  $('quickBets').innerHTML = '';
  $('raiseSlider').disabled = true;
  $('raiseSlider').value = 0;
  $('raiseAmount').textContent = '0';
}

function renderEndControls() {
  $('actionHint').innerHTML = `<span class="text-emerald-300 font-bold">本局结束</span> · 查看日志了解详情`;
  $('actionButtons').innerHTML = session.isHost
    ? btn('start', '下一局', 'bg-gold text-ink hover:brightness-110 col-span-2 sm:col-span-5', 'ri-skip-forward-line')
    : btn('none', '等房主开下一局…', 'bg-white/5 text-slate-500 cursor-not-allowed col-span-2 sm:col-span-5');
  $('quickBets').innerHTML = '';
  $('raiseSlider').disabled = true;
}

function renderWaitControls(text) {
  $('actionHint').innerHTML = `<span class="text-slate-400">${text}</span>`;
  $('actionButtons').innerHTML = btn('none', text, 'bg-white/5 text-slate-500 cursor-not-allowed col-span-2 sm:col-span-5');
  $('quickBets').innerHTML = '';
  $('raiseSlider').disabled = true;
}

function renderHeroControls(opts) {
  const { toCall, canCheck, canRaise, minRaiseTotal, maxRaiseTotal, pot } = opts;
  const g = currentGame();
  const bb = g ? g.bigBlind : 50;

  $('actionHint').innerHTML = toCall > 0
    ? `需跟注 <b class="text-gold">${toCall}</b> · 底池 <b class="text-gold">${pot}</b>`
    : `无需跟注 · 底池 <b class="text-gold">${pot}</b>`;

  const slider = $('raiseSlider');
  if (canRaise && minRaiseTotal < maxRaiseTotal) {
    slider.disabled = false;
    slider.min = minRaiseTotal;
    slider.max = maxRaiseTotal;
    slider.step = Math.max(1, Math.round(bb / 2));
    slider.value = Math.min(maxRaiseTotal, minRaiseTotal);
  } else {
    slider.disabled = true;
    slider.min = 0; slider.max = 0; slider.value = 0;
  }
  $('raiseAmount').textContent = slider.disabled ? '—' : slider.value;

  const quick = [
    { label: '1/2 池', factor: 0.5 },
    { label: '3/4 池', factor: 0.75 },
    { label: '1 倍池', factor: 1 },
    { label: '2 倍池', factor: 2 }
  ];
  $('quickBets').innerHTML = canRaise ? quick.map(q =>
    `<button data-quick="${q.factor}" class="px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-gold hover:text-ink text-xs font-bold transition">${q.label}</button>`
  ).join('') : '';

  const buttons = [];
  buttons.push(btn('fold', '弃牌', 'bg-rose-600/80 hover:bg-rose-600', 'ri-close-circle-line'));
  if (canCheck) buttons.push(btn('check', '过牌', 'bg-slate-600 hover:bg-slate-500', 'ri-check-line'));
  else buttons.push(btn('call', `跟注 ${toCall}`, 'bg-sky-600 hover:bg-sky-500', 'ri-arrow-right-circle-line'));
  buttons.push(btn('raise', canCheck ? '下注' : '加注', canRaise ? 'bg-amber-500 text-ink hover:brightness-110' : 'bg-white/5 text-slate-500 cursor-not-allowed', 'ri-arrow-up-circle-line'));
  buttons.push(btn('allin', 'All-in', 'bg-gradient-to-r from-rose-600 to-amber-500 hover:brightness-110', 'ri-fire-line'));
  $('actionButtons').innerHTML = buttons.join('');
}

function showResultModal(res) {
  const g = currentGame();
  if (!g) return;
  const rows = g.players.filter(p => p.hole.length).map(p => {
    const win = p.winAmount > 0;
    const known = p.hole.filter(Boolean);
    return `<div class="flex items-center gap-2 rounded-lg ${win ? 'bg-emerald-500/15 border border-emerald-400/40' : 'bg-white/5'} p-2">
      <span class="text-lg">${p.avatar}</span>
      <span class="font-bold flex-1 truncate">${p.name}</span>
      <span class="font-mono text-xs text-slate-300">${known.length ? known.map(c => c.label + c.symbol).join(' ') : '未亮牌'}</span>
      <span class="text-xs ${p.folded ? 'text-rose-300' : 'text-violet-300'} w-28 text-right truncate">${p.folded ? '弃牌' : (p.eval ? (p.eval.name || describeEval(p.eval)) : '未开牌')}</span>
      <span class="font-mono font-bold w-16 text-right ${win ? 'text-emerald-300' : 'text-slate-500'}">${win ? '+' + p.winAmount : '—'}</span>
    </div>`;
  }).join('');

  const board = g.community.map(c => `<span class="font-mono">${c.label}${c.symbol}</span>`).join(' ') || '未开出公共牌';
  const iWon = res.winners.some(w => (w.player ? w.player.isHero : w.id === session.mySeatId));

  showModal({
    title: iWon ? '🎉 你赢了这一手' : '本手结算',
    body: `<div class="mb-3 text-xs text-slate-400">公共牌：${board}</div><div class="space-y-2">${rows}</div>`,
    actions: session.isHost
      ? [{ label: '关闭' }, { label: '继续下一局', primary: true, onClick: () => game.startHand() }]
      : [{ label: '知道了', primary: true }]
  });
}

// ================= 事件绑定 =================

function doAction(act, amount = 0) {
  if (session.isHost) {
    if (!game || !game.awaitingHero) return;
    game.awaitingHero = false;
    renderWaitControls('已行动');
    game.applyAction(session.mySeatId, act, amount);
  } else {
    renderWaitControls('已行动，等待同步…');
    sendClientAction(act, amount);
  }
}

function bindEvents() {
  $('actionButtons').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'none') return;
    if (act === 'start') {
      if (session.isHost && game) game.startHand();
      return;
    }
    if (!heroOpts) return;

    if (act === 'raise') {
      if ($('raiseSlider').disabled) return;
      doAction('raise', Number($('raiseSlider').value));
      return;
    }
    if (act === 'allin') { doAction('allin'); return; }
    doAction(act);
  });

  $('raiseSlider').addEventListener('input', e => {
    $('raiseAmount').textContent = e.target.value;
  });

  $('quickBets').addEventListener('click', e => {
    const b = e.target.closest('[data-quick]');
    if (!b || !heroOpts) return;
    const g = currentGame();
    if (!g) return;
    const factor = Number(b.dataset.quick);
    let target = Math.round(g.currentBet + g.pot * factor);
    target = Math.max(target, heroOpts.minRaiseTotal);
    target = Math.min(target, heroOpts.maxRaiseTotal);
    const slider = $('raiseSlider');
    if (!slider.disabled) {
      slider.value = target;
      $('raiseAmount').textContent = slider.value;
    }
  });

  $('btnRules').addEventListener('click', () => {
    showModal({ title: '德州扑克规则速览', body: RULES_HTML, actions: [{ label: '知道了', primary: true }] });
  });

  $('btnBorrow').addEventListener('click', handleBorrow);
  $('btnRepay').addEventListener('click', handleRepay);
  $('btnSettle').addEventListener('click', handleSettle);

  $('btnLeave').addEventListener('click', () => {
    showModal({
      title: '离开房间',
      body: '<p>将退出当前牌局回到大厅。若你是房主，本局将无法继续。</p>',
      actions: [{ label: '取消' }, { label: '确认离开', primary: true, onClick: leaveRoom }]
    });
  });

  $('btnClearLog').addEventListener('click', clearLog);

  // 本地回显通道：sendChat 发起前先把消息塞进本地镜像立刻渲染。
  // 必须在 bindChatUI 之前注册，否则第一条消息回显不出来。
  initChat({
    send: null,
    echo: msg => {
      chatLocal.push(msg);
      refreshChat(session.remoteState?.chat);
    }
  });

  // 聊天：房主与客机走同一条 CAS 写入路径，无需区分身份
  bindChatUI(async text => {
    if (!session.code) {
      showModal({
        title: '还没进房间',
        body: '<p>聊天需要先建房或用房间码加入。</p>',
        actions: [{ label: '知道了', primary: true }]
      });
      return;
    }
    const msg = makeMessage({
      seatId: session.mySeatId,
      name: session.myName || '玩家',
      owner: CLIENT_ID,
      text
    });
    const res = await sendChat(session.code, msg);
    if (!res.ok) {
      // 发送失败就把本地回显撤回，避免留下一条永远发不出去的消息
      chatLocal = chatLocal.filter(m => m.id !== msg.id);
      refreshChat(session.remoteState?.chat);
      setNetStatus(`消息发送失败：${res.msg}`, 'error');
    }
  });

  setChatEnabled(false);

  document.addEventListener('keydown', e => {
    if (!heroOpts) return;
    const key = e.key.toLowerCase();
    if (key === 'f') $('actionButtons').querySelector('[data-act="fold"]')?.click();
    if (key === 'c') ($('actionButtons').querySelector('[data-act="call"]') || $('actionButtons').querySelector('[data-act="check"]'))?.click();
    if (key === 'r') $('actionButtons').querySelector('[data-act="raise"]')?.click();
    if (key === 'a') $('actionButtons').querySelector('[data-act="allin"]')?.click();
  });
}

bindEvents();

// 移动端底部标签栏：切到聊天标签即视为已读
initMobileTabs(key => {
  if (key === 'chat') markChatRead();
});

// 从后台切回前台时，若聊天面板正显示着就清掉红点
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) markChatRead();
});

// 点聊天列表也算已读
const chatListEl = $('chatList');
if (chatListEl) chatListEl.addEventListener('click', markChatRead);

// PWA：注册 Service Worker + 安装引导
initPWA();

// 页脚展示版本号：出问题时让大家互相报一句版本号就能定位
const buildEl = $('buildLabel');
if (buildEl) buildEl.textContent = BUILD_LABEL;

showLobby();

// 启动自检：提前暴露后端不可达问题，而不是等到点建房才报错
checkBackend().then(ok => {
  if (!ok) {
    setLobbyMsg('联机服务当前不可达，建房/加入会失败。请检查网络代理或浏览器插件是否拦截了 supabase.co', 'error');
  }
});
