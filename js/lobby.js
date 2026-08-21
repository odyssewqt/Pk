// 大厅界面：建房 / 加入房间 / 等待对手
import { makeRoomCode } from './net.js';

const AVATARS = ['🙂', '😎', '🐯', '🦊', '🐼', '🐧', '🦁', '🐵'];

export function renderLobby(root, { onCreate, onJoin, defaultName }) {
  root.innerHTML = `
    <div class="fixed inset-0 z-40 flex items-center justify-center bg-ink/95 backdrop-blur p-4 overflow-y-auto">
      <div class="w-full max-w-2xl">
        <div class="text-center mb-6">
          <div class="w-16 h-16 rounded-2xl chip-ring mx-auto flex items-center justify-center text-ink font-black text-2xl shadow-lg mb-3">♠</div>
          <h2 class="text-2xl font-black">联机德州扑克</h2>
          <p class="text-sm text-slate-400 mt-1">两人对局 · 一人建房，另一人输房间码加入</p>
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
            <p class="text-xs text-slate-400 flex-1 mb-4">你将成为房主，负责发牌与推进牌局。房间码生成后发给朋友。</p>
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

export function renderWaiting(root, { code, seats, isHost, onStart, onLeave }) {
  const filled = seats.filter(s => s.type === 'human' && s.owner).length;
  root.innerHTML = `
    <div class="fixed inset-0 z-40 flex items-center justify-center bg-ink/95 backdrop-blur p-4">
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

          <div class="space-y-2 mb-5 text-left">
            ${seats.map((s, i) => `
              <div class="flex items-center gap-3 rounded-xl border ${s.owner ? 'border-emerald-400/40 bg-emerald-500/10' : 'border-white/10 bg-white/5'} p-3">
                <span class="text-xl">${s.owner ? (s.avatar || '🙂') : '⬜'}</span>
                <span class="flex-1 font-bold text-sm">${s.owner ? s.name : '等待加入…'}</span>
                <span class="text-xs ${s.owner ? 'text-emerald-300' : 'text-slate-500'}">${i === 0 ? '房主' : '座位 2'}</span>
              </div>`).join('')}
          </div>

          <div class="text-sm text-slate-400 mb-4">${filled}/2 人就位${filled < 2 ? '，等对方进来后即可开局' : '，可以开始了'}</div>

          ${isHost
      ? `<button id="btnStartGame" class="w-full px-4 py-3 rounded-xl font-bold transition ${filled >= 2 ? 'bg-gold text-ink hover:brightness-110' : 'bg-white/5 text-slate-500 cursor-not-allowed'}">
                ${filled >= 2 ? '开始牌局' : '等待对手加入…'}
              </button>`
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

  const startBtn = root.querySelector('#btnStartGame');
  if (startBtn && filled >= 2) startBtn.addEventListener('click', onStart);
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
