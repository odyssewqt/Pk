// 大厅界面：建房 / 加入房间 / 六人桌座位配置
import { makeRoomCode } from './net.js';

const AVATARS = ['🙂', '😎', '🐯', '🦊', '🐼', '🐧', '🦁', '🐵'];

export function renderLobby(root, { onCreate, onJoin, defaultName }) {
  root.innerHTML = `
    <div class="fixed inset-0 z-40 flex items-center justify-center bg-ink/95 backdrop-blur p-4 overflow-y-auto">
      <div class="w-full max-w-2xl">
        <div class="text-center mb-6">
          <div class="w-16 h-16 rounded-2xl chip-ring mx-auto flex items-center justify-center text-ink font-black text-2xl shadow-lg mb-3">♠</div>
          <h2 class="text-2xl font-black">联机德州扑克 · 六人桌</h2>
          <p class="text-sm text-slate-400 mt-1">最多 6 人同桌 · 人数不够由 AI 补位</p>
        </div>

        <div class="rounded-2xl bg-slate-900/80 border border-white/10 p-5 mb-4">
          <label class="block text-xs text-slate-400 mb-2">你的昵称</label>
          <input id="lobbyName" maxlength="10" value="${defaultName || ''}" placeholder="输入昵称"
            class="w-full px-4 py-3 rounded-xl bg-black/40 border border-white/15 text-white outline-none focus:border-gold transition mb-4">
          <label class="block text-xs text-slate-400 mb-2">选择头像</label>
          <div id="avatarPick" class="flex flex-wrap gap-2">
            ${AVATARS.map((a, i) => `<button data-avatar="${a}" class="w-11 h-11 rounded-xl text-xl border transition ${i === 0 ? 'border-gold bg-gold/20' : 'border-white/15 bg-black/30 hover:border-white/40'}">${a}</button>`).join('')}
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="rounded-2xl bg-slate-900/80 border border-white/10 p-5 flex flex-col">
            <h3 class="font-bold text-gold mb-2"><i class="ri-add-circle-line mr-1"></i>创建房间</h3>
            <p class="text-xs text-slate-400 flex-1 mb-4">你将成为房主，负责发牌与推进牌局。建房后可自由配置每个座位是留给真人还是交给 AI。</p>
            <button id="btnCreateRoom" class="w-full px-4 py-3 rounded-xl bg-gold text-ink font-bold hover:brightness-110 transition">
              生成房间码并建房
            </button>
          </div>

          <div class="rounded-2xl bg-slate-900/80 border border-white/10 p-5 flex flex-col">
            <h3 class="font-bold text-sky-300 mb-2"><i class="ri-login-box-line mr-1"></i>加入房间</h3>
            <input id="joinCode" maxlength="6" placeholder="输入 6 位房间码"
              class="w-full px-4 py-3 rounded-xl bg-black/40 border border-white/15 text-white uppercase tracking-[.3em] font-mono text-center outline-none focus:border-sky-400 transition mb-3">
            <button id="btnJoinRoom" class="w-full px-4 py-3 rounded-xl bg-sky-600 font-bold hover:bg-sky-500 transition mt-auto">
              加入
            </button>
          </div>
        </div>

        <div id="lobbyMsg" class="mt-4 text-center text-sm min-h-6"></div>
      </div>
    </div>`;

  let avatar = AVATARS[0];

  root.querySelector('#avatarPick').addEventListener('click', e => {
    const b = e.target.closest('[data-avatar]');
    if (!b) return;
    avatar = b.dataset.avatar;
    root.querySelectorAll('[data-avatar]').forEach(el => {
      const on = el === b;
      el.className = `w-11 h-11 rounded-xl text-xl border transition ${on ? 'border-gold bg-gold/20' : 'border-white/15 bg-black/30 hover:border-white/40'}`;
    });
  });

  const nameOf = () => (root.querySelector('#lobbyName').value || '').trim();

  root.querySelector('#btnCreateRoom').addEventListener('click', () => {
    const name = nameOf();
    if (!name) return setLobbyMsg('请先填昵称', 'error');
    onCreate({ name, avatar, code: makeRoomCode() });
  });

  root.querySelector('#btnJoinRoom').addEventListener('click', () => {
    const name = nameOf();
    const code = (root.querySelector('#joinCode').value || '').trim().toUpperCase();
    if (!name) return setLobbyMsg('请先填昵称', 'error');
    if (code.length !== 6) return setLobbyMsg('房间码是 6 位字母数字', 'error');
    onJoin({ name, avatar, code });
  });

  root.querySelector('#joinCode').addEventListener('keydown', e => {
    if (e.key === 'Enter') root.querySelector('#btnJoinRoom').click();
  });
  root.querySelector('#lobbyName').focus();
}

export function setLobbyMsg(text, type = 'info') {
  const el = document.getElementById('lobbyMsg');
  if (!el) return;
  const cls = type === 'error' ? 'text-rose-300' : type === 'ok' ? 'text-emerald-300' : 'text-slate-400';
  el.className = `mt-4 text-center text-sm min-h-6 ${cls}`;
  el.textContent = text;
}

const SEAT_ROLE = ['庄家位起点', '座位 2', '座位 3', '座位 4', '座位 5', '座位 6'];

function seatRowHTML(seat, i, isHost, mySeatId) {
  const mine = i === mySeatId;
  const isAI = seat.type === 'ai';
  const taken = seat.type === 'human' && seat.owner;

  let border, icon, label, badge, badgeCls;
  if (taken) {
    border = mine ? 'border-gold/60 bg-gold/10' : 'border-emerald-400/40 bg-emerald-500/10';
    icon = seat.avatar || '🙂';
    label = seat.name + (mine ? '（你）' : '');
    badge = i === 0 ? '房主' : '真人';
    badgeCls = mine ? 'text-gold' : 'text-emerald-300';
  } else if (isAI) {
    border = 'border-violet-400/40 bg-violet-500/10';
    icon = '🤖';
    label = 'AI 电脑玩家';
    badge = 'AI 补位';
    badgeCls = 'text-violet-300';
  } else {
    border = 'border-white/10 bg-white/5';
    icon = '⬜';
    label = '空位 · 等待加入';
    badge = SEAT_ROLE[i] || `座位 ${i + 1}`;
    badgeCls = 'text-slate-500';
  }

  // 房主可以把非真人座位在「空位 / AI」之间切换；0 号位是房主自己，不可动
  const toggle = (isHost && !taken && i !== 0)
    ? `<button data-toggle="${i}" class="px-2.5 py-1 rounded-lg text-[11px] font-bold transition ${isAI ? 'bg-violet-500/25 text-violet-200 hover:bg-violet-500/40' : 'bg-white/10 text-slate-300 hover:bg-white/20'}">
         ${isAI ? '改为空位' : '放 AI'}
       </button>`
    : '';

  return `<div class="flex items-center gap-3 rounded-xl border ${border} p-3">
      <span class="text-xl w-7 text-center shrink-0">${icon}</span>
      <span class="flex-1 font-bold text-sm truncate">${label}</span>
      <span class="text-xs ${badgeCls} shrink-0">${badge}</span>
      ${toggle}
    </div>`;
}

export function renderWaiting(root, { code, seats, isHost, mySeatId, onStart, onLeave, onToggleSeat }) {
  const humans = seats.filter(s => s.type === 'human' && s.owner).length;
  const ais = seats.filter(s => s.type === 'ai').length;
  const total = humans + ais;
  const canStart = total >= 2;

  root.innerHTML = `
    <div class="fixed inset-0 z-40 flex items-center justify-center bg-ink/95 backdrop-blur p-4 overflow-y-auto">
      <div class="w-full max-w-lg text-center">
        <div class="rounded-2xl bg-slate-900/80 border border-white/10 p-6">
          <div class="text-xs text-slate-400 mb-2">房间码 · 发给你的朋友</div>
          <div class="flex items-center justify-center gap-3 mb-1">
            <div class="text-4xl font-black tracking-[.35em] text-gold font-mono">${code}</div>
            <button id="btnCopyCode" class="px-3 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-xs transition" title="复制">
              <i class="ri-file-copy-line"></i>
            </button>
          </div>
          <div id="copyHint" class="text-xs text-emerald-300 h-4 mb-4"></div>

          <div class="space-y-2 mb-4 text-left">
            ${seats.map((s, i) => seatRowHTML(s, i, isHost, mySeatId)).join('')}
          </div>

          <div class="text-sm text-slate-400 mb-4">
            真人 <b class="text-emerald-300">${humans}</b> · AI <b class="text-violet-300">${ais}</b> · 共 <b class="text-gold">${total}</b>/6 人上桌
            ${canStart ? '' : '<div class="text-xs text-rose-300 mt-1">至少需要 2 人（可用 AI 补位）</div>'}
          </div>

          ${isHost
      ? `<button id="btnStartGame" class="w-full px-4 py-3 rounded-xl font-bold transition ${canStart ? 'bg-gold text-ink hover:brightness-110' : 'bg-white/5 text-slate-500 cursor-not-allowed'}">
                ${canStart ? '开始牌局' : '人数不足'}
              </button>
              <div class="text-[11px] text-slate-500 mt-2">开局后仍可加入，新玩家会在当前这手结束后上桌</div>`
      : `<div class="w-full px-4 py-3 rounded-xl bg-white/5 text-slate-400 text-sm">已就座，等房主开局</div>`}

          <button id="btnLeaveRoom" class="mt-3 text-xs text-slate-500 hover:text-rose-300 transition">离开房间</button>
        </div>
        <div id="netStatus" class="mt-3 text-xs text-slate-500"></div>
      </div>
    </div>`;

  root.querySelector('#btnCopyCode').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      root.querySelector('#copyHint').textContent = '已复制';
    } catch {
      root.querySelector('#copyHint').textContent = '复制失败，请手动选中';
    }
    setTimeout(() => {
      const h = root.querySelector('#copyHint');
      if (h) h.textContent = '';
    }, 1800);
  });

  if (isHost && onToggleSeat) {
    root.querySelectorAll('[data-toggle]').forEach(btn => {
      btn.addEventListener('click', () => onToggleSeat(Number(btn.dataset.toggle)));
    });
  }

  const startBtn = root.querySelector('#btnStartGame');
  if (startBtn && canStart) startBtn.addEventListener('click', onStart);
  root.querySelector('#btnLeaveRoom').addEventListener('click', onLeave);
}

export function setNetStatus(text, type = 'info') {
  const el = document.getElementById('netStatus');
  if (!el) return;
  const cls = type === 'error' ? 'text-rose-400' : type === 'ok' ? 'text-emerald-400' : 'text-slate-500';
  el.className = `mt-3 text-xs ${cls}`;
  el.textContent = text;
}

export function clearOverlay(root) { root.innerHTML = ''; }
