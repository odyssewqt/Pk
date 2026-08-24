// 账号相关界面：登录/注册覆盖层、战绩弹窗内容
// 与 lobby.js 保持同一套视觉语言（深色卡片 + 金色主色）

const AVATARS = ['🙂', '😎', '🐯', '🦊', '🐼', '🐧', '🦁', '🐵'];

// ---------- 登录 / 注册 ----------

// mode: 'login' | 'signup'
function formHTML(mode) {
  const isSignup = mode === 'signup';
  return `
    <div class="rounded-2xl bg-slate-900/80 border border-white/10 p-5">
      <div class="grid grid-cols-2 gap-2 mb-5 p-1 rounded-xl bg-black/40">
        <button data-mode="login" class="px-3 py-2 rounded-lg text-sm font-bold transition ${isSignup ? 'text-slate-400 hover:text-white' : 'bg-gold text-ink'}">登录</button>
        <button data-mode="signup" class="px-3 py-2 rounded-lg text-sm font-bold transition ${isSignup ? 'bg-gold text-ink' : 'text-slate-400 hover:text-white'}">注册</button>
      </div>

      <label class="block text-xs text-slate-400 mb-1.5">邮箱</label>
      <input id="authEmail" type="email" autocomplete="email" placeholder="you@example.com"
        class="w-full px-4 py-3 rounded-xl bg-black/40 border border-white/15 text-white outline-none focus:border-gold transition mb-4">

      <label class="block text-xs text-slate-400 mb-1.5">密码</label>
      <input id="authPassword" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" placeholder="至少 6 位"
        class="w-full px-4 py-3 rounded-xl bg-black/40 border border-white/15 text-white outline-none focus:border-gold transition mb-4">

      ${isSignup ? `
        <label class="block text-xs text-slate-400 mb-1.5">昵称</label>
        <input id="authNickname" maxlength="10" placeholder="牌桌上显示的名字"
          class="w-full px-4 py-3 rounded-xl bg-black/40 border border-white/15 text-white outline-none focus:border-gold transition mb-4">
        <label class="block text-xs text-slate-400 mb-2">选择头像</label>
        <div id="authAvatarPick" class="flex flex-wrap gap-2 mb-2">
          ${AVATARS.map((a, i) => `<button data-avatar="${a}" class="w-11 h-11 rounded-xl text-xl border transition ${i === 0 ? 'border-gold bg-gold/20' : 'border-white/15 bg-black/30 hover:border-white/40'}">${a}</button>`).join('')}
        </div>
      ` : ''}

      <button id="btnAuthSubmit" class="w-full px-4 py-3 rounded-xl bg-gold text-ink font-bold hover:brightness-110 transition mt-2 disabled:opacity-50">
        ${isSignup ? '注册并进入' : '登录'}
      </button>

      <div id="authMsg" class="mt-3 text-center text-sm min-h-6"></div>

      <p class="mt-2 text-[11px] text-slate-500 leading-relaxed text-center">
        ${isSignup
      ? '注册后即可记录每一场的输赢，随时回看自己的历史对局。'
      : '登录后你的每场战绩都会自动保存，只有你自己能看到。'}
      </p>
    </div>`;
}

export function renderAuth(root, { onLogin, onSignup }) {
  let mode = 'login';
  let avatar = AVATARS[0];

  function paint() {
    root.innerHTML = `
      <div class="fixed inset-0 z-40 flex items-center justify-center bg-ink/95 backdrop-blur p-4 overflow-y-auto">
        <div class="w-full max-w-md">
          <div class="text-center mb-6">
            <div class="w-16 h-16 rounded-2xl chip-ring mx-auto flex items-center justify-center text-ink font-black text-2xl shadow-lg mb-3">♠</div>
            <h2 class="text-2xl font-black">德州扑克 · 账号</h2>
            <p class="text-sm text-slate-400 mt-1">登录后自动记录每场战绩</p>
          </div>
          ${formHTML(mode)}
        </div>
      </div>`;

    // 切换登录 / 注册
    root.querySelectorAll('[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.mode === mode) return;
        mode = btn.dataset.mode;
        avatar = AVATARS[0];
        paint();
      });
    });

    // 头像选择（仅注册态存在）
    const pick = root.querySelector('#authAvatarPick');
    if (pick) {
      pick.addEventListener('click', e => {
        const b = e.target.closest('[data-avatar]');
        if (!b) return;
        avatar = b.dataset.avatar;
        pick.querySelectorAll('[data-avatar]').forEach(el => {
          const on = el === b;
          el.className = `w-11 h-11 rounded-xl text-xl border transition ${on ? 'border-gold bg-gold/20' : 'border-white/15 bg-black/30 hover:border-white/40'}`;
        });
      });
    }

    const submit = root.querySelector('#btnAuthSubmit');

    async function doSubmit() {
      const email = (root.querySelector('#authEmail').value || '').trim();
      const password = root.querySelector('#authPassword').value || '';
      const nickEl = root.querySelector('#authNickname');
      const nickname = nickEl ? (nickEl.value || '').trim() : '';

      if (!email || !email.includes('@')) return setAuthMsg('请填一个正确的邮箱', 'error');
      if (password.length < 6) return setAuthMsg('密码至少 6 位', 'error');
      if (mode === 'signup' && !nickname) return setAuthMsg('请填昵称', 'error');

      submit.disabled = true;
      setAuthMsg(mode === 'signup' ? '正在注册…' : '正在登录…');
      try {
        if (mode === 'signup') await onSignup({ email, password, nickname, avatar });
        else await onLogin({ email, password });
      } catch (err) {
        setAuthMsg(err.message || '操作失败', 'error');
        submit.disabled = false;
      }
    }

    submit.addEventListener('click', doSubmit);

    // 回车提交，输密码时最顺手
    root.querySelectorAll('#authEmail, #authPassword, #authNickname').forEach(el => {
      el.addEventListener('keydown', e => { if (e.key === 'Enter') doSubmit(); });
    });

    root.querySelector('#authEmail').focus();
  }

  paint();
}

export function setAuthMsg(text, type = 'info') {
  const el = document.getElementById('authMsg');
  if (!el) return;
  const cls = type === 'error' ? 'text-rose-300' : type === 'ok' ? 'text-emerald-300' : 'text-slate-400';
  el.className = `mt-3 text-center text-sm min-h-6 ${cls}`;
  el.textContent = text;
}

// ---------- 战绩展示 ----------

function netTag(net) {
  const n = Number(net) || 0;
  if (n > 0) return `<span class="text-emerald-300 font-bold font-mono">+${n}</span>`;
  if (n < 0) return `<span class="text-rose-300 font-bold font-mono">${n}</span>`;
  return `<span class="text-slate-400 font-mono">0</span>`;
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function statCard(label, value, cls = 'text-slate-100') {
  return `<div class="rounded-xl bg-white/5 border border-white/10 p-3 text-center">
      <div class="text-[11px] text-slate-400 mb-1">${label}</div>
      <div class="font-mono font-bold text-lg ${cls}">${value}</div>
    </div>`;
}

// 单条记录卡片：起始筹码 → 结束筹码，右侧净盈亏
function recordCard(r) {
  const start = Number(r.start_chips) || 0;
  const end = Number(r.end_chips) || 0;
  const debt = Math.max(0, (Number(r.borrowed) || 0) - (Number(r.repaid) || 0));

  return `<div class="rounded-xl bg-white/5 border border-white/10 p-3">
      <div class="flex items-center gap-2 mb-2">
        <span class="px-2 py-0.5 rounded bg-black/40 font-mono text-[11px] tracking-widest text-gold">${r.room_code || '—'}</span>
        <span class="text-[11px] text-slate-500">${fmtTime(r.played_at)}</span>
        <span class="flex-1"></span>
        ${netTag(r.net)}
      </div>
      <div class="grid grid-cols-3 gap-2 text-[11px]">
        <div><span class="text-slate-500">对局数</span> <b class="font-mono text-slate-200">${Number(r.hands) || 0}</b> 手</div>
        <div><span class="text-slate-500">起始</span> <b class="font-mono text-slate-200">${start}</b></div>
        <div><span class="text-slate-500">结束</span> <b class="font-mono text-gold">${end}</b></div>
      </div>
      ${(Number(r.borrowed) || 0) > 0
      ? `<div class="mt-2 pt-2 border-t border-white/10 text-[11px] text-slate-500">
             借入 <b class="text-violet-300 font-mono">${r.borrowed}</b> ·
             归还 <b class="text-emerald-300 font-mono">${r.repaid}</b>
             ${debt > 0 ? `· 未还 <b class="text-rose-300 font-mono">${debt}</b>` : ''}
           </div>`
      : ''}
    </div>`;
}

export function recordsHTML(list, summary, email) {
  const rows = Array.isArray(list) ? list : [];

  if (!rows.length) {
    return `<div class="text-center py-8">
        <div class="text-4xl mb-3">🎴</div>
        <p class="text-sm text-slate-300 mb-1">还没有战绩记录</p>
        <p class="text-xs text-slate-500">打完一场后由房主点「结算」，成绩就会记到这里</p>
      </div>`;
  }

  const netCls = summary.net > 0 ? 'text-emerald-300' : summary.net < 0 ? 'text-rose-300' : 'text-slate-100';

  return `
    <div class="mb-3 text-[11px] text-slate-500">${email || ''} · 仅你可见</div>

    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
      ${statCard('总场次', summary.sessions)}
      ${statCard('总手数', summary.hands)}
      ${statCard('累计盈亏', summary.net > 0 ? `+${summary.net}` : summary.net, netCls)}
      ${statCard('胜率', summary.winRate + '%', 'text-gold')}
    </div>

    <div class="grid grid-cols-3 gap-2 mb-4 text-center text-[11px]">
      <div class="rounded-lg bg-emerald-500/10 border border-emerald-400/20 p-2">
        <div class="text-slate-400">赢的场次</div>
        <div class="font-mono font-bold text-emerald-300">${summary.wins}</div>
      </div>
      <div class="rounded-lg bg-rose-500/10 border border-rose-400/20 p-2">
        <div class="text-slate-400">输的场次</div>
        <div class="font-mono font-bold text-rose-300">${summary.loses}</div>
      </div>
      <div class="rounded-lg bg-white/5 border border-white/10 p-2">
        <div class="text-slate-400">单场最佳</div>
        <div class="font-mono font-bold text-gold">${summary.best > 0 ? '+' + summary.best : summary.best}</div>
      </div>
    </div>

    <div class="text-xs text-slate-400 mb-2 font-bold">历史对局（${rows.length}）</div>
    <div class="space-y-2 max-h-[46vh] overflow-y-auto scroll-thin pr-1">
      ${rows.map(recordCard).join('')}
    </div>`;
}
