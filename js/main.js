// 主入口：大厅 → 联机对局装配
import { PokerGame, MAX_SEATS } from './engine.js';
import { renderTable, appendLog, clearLog, setTableMsg, showModal, resetEquityCache } from './ui.js';
import { estimateEquity, describeEval, HAND_NAMES } from './poker.js';
import { getClientId, createRoom, fetchRoom, updateRoomState, RoomChannel } from './net.js';
import { serializeGame, buildViewModel, deriveOptions } from './sync.js';
import { renderLobby, setLobbyMsg, renderWaiting, setNetStatus, clearOverlay } from './lobby.js';

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

  const next = { ...state, seats, v: (state.v || 0) + 1, ts: Date.now() };

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

  // 版本回退保护：忽略比本地更旧的状态
  if (state.v && state.v < session.lastVersion) {
    console.warn('[sync] 忽略过期状态', state.v, '<', session.lastVersion);
    return;
  }
  session.lastVersion = state.v || session.lastVersion;
  session.remoteState = state;

  if (session.isHost) {
    // 房主：只关心座位变化与客机回传的动作
    if (state.seats) {
      session.seats = state.seats;
      if (session.phase === 'waiting') showWaiting();
      else if (session.phase === 'playing') applySeatChange();
    }
    if (state.action) consumeClientAction(state.action);
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
  game.on('handEnd', res => {
    heroOpts = null;
    renderEndControls();
    const meWin = res.winners.find(w => w.player.isHero);
    setTableMsg(meWin ? `你赢得 ${meWin.amount} 筹码！` : `${res.winners.map(w => w.player.name).join('、') || '其他玩家'} 赢下本局`);
    showResultModal(res);
    // 牌局间隙：让等待中的新玩家入座
    if (seatChangePending) setTimeout(() => applySeatChange(), 300);
  });
  game.on('gameOver', ({ hero }) => {
    showModal({
      title: hero.stack <= 0 ? '💀 你已破产' : '🏆 牌局结束',
      body: `<p>本次共进行 <b class="text-gold">${game.record.hands}</b> 手，胜 <b class="text-emerald-300">${game.record.wins}</b> 手，最终筹码 <b class="text-gold">${hero.stack}</b>。</p>`,
      actions: [{ label: '重新开局', primary: true, onClick: () => { clearLog(); initHostGame(); } }]
    });
  });

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
  // 合并高频 update，避免一次动作触发多次写库
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    const state = serializeGame(game, {
      v: session.lastVersion,
      phase: 'playing',
      seats: session.seats
    });
    session.lastVersion = state.v;
    try {
      await updateRoomState(session.code, state);
    } catch (err) {
      console.error('[sync] 写入失败', err);
      handleNetStatus('error');
    }
  }, 120);
}

function consumeClientAction(action) {
  if (!game || !session.isHost) return;
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

// ================= 客机端 =================

function enterGameAsClient(state) {
  if (session.phase !== 'playing') {
    clearOverlay(overlay());
    session.phase = 'playing';
    clearLog();
  }
  viewModel = buildViewModel(state, session.mySeatId, CLIENT_ID);
  renderTable(viewModel);

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
  const next = {
    ...state,
    v: (state.v || 0) + 1,
    action: {
      seatId: session.mySeatId,
      action,
      amount,
      handNo: state.handNo,
      by: CLIENT_ID,
      ts: Date.now()
    },
    ts: Date.now()
  };
  session.lastVersion = next.v;
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
  buttons.push(btn('odds', '算胜率', 'bg-violet-600/80 hover:bg-violet-600', 'ri-percent-line'));
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

function showOddsModal() {
  const g = currentGame();
  if (!g) return;
  const hero = g.players.find(p => p.isHero);
  const known = hero ? hero.hole.filter(Boolean) : [];
  if (known.length < 2) {
    showModal({ title: '胜率计算', body: '<p>当前尚未发牌，无法计算胜率。</p>', actions: [{ label: '知道了', primary: true }] });
    return;
  }
  const opp = Math.max(1, g.contenders().length - 1);
  const eq = estimateEquity(known, g.community, opp, 4000);
  const pct = (eq * 100).toFixed(1);
  showModal({
    title: '蒙特卡洛胜率模拟',
    body: `<div class="space-y-3">
      <div class="rounded-lg bg-white/5 p-3">
        <div class="text-xs text-slate-400">你的手牌</div>
        <div class="font-mono text-lg">${known.map(c => c.label + c.symbol).join('  ')}</div>
      </div>
      <div class="rounded-lg bg-white/5 p-3">
        <div class="text-xs text-slate-400">公共牌</div>
        <div class="font-mono text-lg">${g.community.map(c => c.label + c.symbol).join('  ') || '—'}</div>
      </div>
      <div class="rounded-lg bg-emerald-500/15 border border-emerald-400/40 p-3 text-center">
        <div class="text-xs text-emerald-200">对抗 ${opp} 位对手，4000 次模拟</div>
        <div class="text-4xl font-black text-emerald-300 mt-1">${pct}%</div>
      </div>
    </div>`,
    actions: [{ label: '关闭', primary: true }]
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
    if (act === 'odds') { showOddsModal(); return; }
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

  $('btnOdds').addEventListener('click', showOddsModal);

  $('btnLeave').addEventListener('click', () => {
    showModal({
      title: '离开房间',
      body: '<p>将退出当前牌局回到大厅。若你是房主，本局将无法继续。</p>',
      actions: [{ label: '取消' }, { label: '确认离开', primary: true, onClick: leaveRoom }]
    });
  });

  $('btnClearLog').addEventListener('click', clearLog);

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
showLobby();
