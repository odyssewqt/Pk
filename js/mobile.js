// 移动端底部标签栏：窄屏下把侧边栏的多个面板收进标签页切换。
//
// 设计原则：不改动任何面板内部结构与 id，只在窄屏时控制它们的显隐。
// 桌面端（xl 及以上）标签栏隐藏，侧边栏恢复为原本的竖向堆叠，
// 所有面板同时可见，与改造前完全一致。

const $ = id => document.getElementById(id);

// 标签定义：icon 存完整的 Remixicon 类名，不再二次拼接后缀
const TABS = [
  { key: 'table', label: '牌桌', icon: 'ri-gallery-view-2' },
  { key: 'info',  label: '本局', icon: 'ri-focus-3-line' },
  { key: 'bank',  label: '借贷', icon: 'ri-bank-line' },
  { key: 'chat',  label: '聊天', icon: 'ri-chat-3-line' },
  { key: 'log',   label: '日志', icon: 'ri-file-list-3-line' }
];

let current = 'table';
let onTabChange = null;
// 牌桌外壳是否可见。仅当牌局真正开始后才为 true。
// 大厅和「等待玩家进入」都是全屏覆盖层，且此时牌桌、借贷、日志都还是空的，
// 露出来只会让人以为界面坏了；顶部按钮和底部标签栏层级更高也会透出覆盖层。
let inRoom = false;

// 窄屏判定：与 Tailwind 的 xl 断点保持一致（1280px）
function isNarrow() {
  return window.matchMedia('(max-width: 1279px)').matches;
}

export function getCurrentTab() {
  return current;
}

// 由 main.js 在阶段切换时调用：lobby 传 false，waiting/playing 传 true
export function setShellVisible(visible) {
  inRoom = !!visible;
  // 回到大厅后再进房，默认落回牌桌标签，而不是上一局残留的标签
  if (!inRoom) current = 'table';

  // 顶部栏的状态条与「结算/规则/离开」只在房间里有意义。
  // 这两处原本是 flex 布局，恢复时必须显式加回 flex，否则会退化成块级排版。
  const statBar = $('statBar');
  const roomActions = $('roomActions');
  [statBar, roomActions].forEach(el => {
    if (!el) return;
    el.classList.toggle('hidden', !inRoom);
    el.classList.toggle('flex', inRoom);
  });

  apply();
}

function paneEls() {
  return {
    info: $('panelInfo'),
    bank: $('panelBank'),
    chat: $('chatPanel'),
    log:  $('panelLog')
  };
}

// 应用当前标签：窄屏才生效，宽屏一律全部显示
function apply() {
  const tableEl = $('tableSection');
  const asideEl = $('sidePanels');
  const bar = $('mobileTabs');
  const panes = paneEls();

  // 大厅 / 等待房间阶段：牌桌外壳整体隐藏，只留覆盖层。
  // 这一步与屏幕宽度无关，桌面端同样不该看到空牌桌和空借贷面板。
  if (!inRoom) {
    if (bar) bar.classList.add('hidden');
    if (tableEl) tableEl.classList.add('hidden');
    if (asideEl) asideEl.classList.add('hidden');
    document.body.classList.remove('pb-tabbar');
    return;
  }

  if (!isNarrow()) {
    // 桌面端：全部显示，清除所有内联控制
    if (bar) bar.classList.add('hidden');
    if (tableEl) tableEl.classList.remove('hidden');
    if (asideEl) asideEl.classList.remove('hidden');
    Object.values(panes).forEach(el => { if (el) el.classList.remove('hidden'); });
    document.body.classList.remove('pb-tabbar');
    return;
  }

  if (bar) bar.classList.remove('hidden');
  document.body.classList.add('pb-tabbar');

  const showTable = current === 'table';
  if (tableEl) tableEl.classList.toggle('hidden', !showTable);
  if (asideEl) asideEl.classList.toggle('hidden', showTable);

  Object.entries(panes).forEach(([key, el]) => {
    if (el) el.classList.toggle('hidden', key !== current);
  });

  // 切到聊天时把消息滚到底部，符合聊天软件直觉
  if (current === 'chat') {
    const list = $('chatList');
    if (list) list.scrollTop = list.scrollHeight;
  }

  renderTabState();
}

function renderTabState() {
  const bar = $('mobileTabs');
  if (!bar) return;
  bar.querySelectorAll('[data-tab]').forEach(btn => {
    const active = btn.dataset.tab === current;
    btn.classList.toggle('text-gold', active);
    btn.classList.toggle('text-slate-400', !active);
    const dot = btn.querySelector('[data-active-bar]');
    if (dot) dot.classList.toggle('opacity-0', !active);
  });
}

export function switchTab(key) {
  if (!TABS.some(t => t.key === key)) return;
  current = key;
  apply();
  if (onTabChange) onTabChange(key);
}

// 底部标签栏的聊天红点：与侧边栏 chatUnread 共享同一份计数
export function setTabUnread(n) {
  const dot = $('tabChatUnread');
  if (!dot) return;
  if (n > 0) {
    dot.textContent = n > 99 ? '99+' : String(n);
    dot.classList.remove('hidden');
  } else {
    dot.classList.add('hidden');
  }
}

function buildBar() {
  const bar = $('mobileTabs');
  if (!bar) return;
  bar.innerHTML = `
    <div class="grid grid-cols-5">
      ${TABS.map(t => `
        <button type="button" data-tab="${t.key}"
          class="relative flex flex-col items-center gap-0.5 py-2 text-slate-400 active:bg-white/5 transition">
          <span data-active-bar class="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-gold opacity-0 transition-opacity"></span>
          <span class="relative text-xl leading-none">
            <i class="${t.icon}"></i>
            ${t.key === 'chat'
              ? '<span id="tabChatUnread" class="hidden absolute -top-1 -right-2 min-w-[16px] px-1 rounded-full bg-rose-500 text-white text-[10px] leading-4 text-center"></span>'
              : ''}
          </span>
          <span class="text-[10px] font-medium">${t.label}</span>
        </button>`).join('')}
    </div>`;

  bar.addEventListener('click', ev => {
    const btn = ev.target.closest('[data-tab]');
    if (btn) switchTab(btn.dataset.tab);
  });
}

export function initMobileTabs(handler) {
  onTabChange = typeof handler === 'function' ? handler : null;
  buildBar();
  apply();

  // 断点变化时重新应用，横竖屏切换或窗口缩放都能正确响应
  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(apply, 120);
  });
}
