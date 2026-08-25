// 协议版本：唯一的版本号来源
//
// 每次改动会影响「房主与客机之间状态结构或交互约定」的逻辑时，
// 必须把 PROTOCOL_VERSION 加一。典型场景：
//   - 改了 serializeGame / buildViewModel 的字段
//   - 改了借还筹码、结算、动作队列的处理方式
//   - 改了座位或账本的数据结构
//
// 纯样式或纯文案调整不需要改这个号（改了也只是让大家多刷一次，无害）。
//
// 同时记得把 index.html 里 main.js 的 ?v= 查询串改成同一个数字，
// 否则浏览器可能仍然从缓存里加载旧代码，版本校验就无从触发。
export const PROTOCOL_VERSION = 13;

// 构建标识：仅用于界面展示与排查问题，不参与任何校验
export const BUILD_LABEL = `v${PROTOCOL_VERSION}`;

// 从房间状态里取出协议版本。
// 早期版本的房间状态里没有这个字段，视为 0，一定低于当前版本。
export function readStateVersion(state) {
  const n = Number(state?.pv);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 比较结果：'same' | 'client-old' | 'client-new'
// client-old：本页面代码比房间旧，必须刷新
// client-new：本页面代码比房间新，说明房主还没刷新，也不该混跑
export function compareVersion(state) {
  const remote = readStateVersion(state);
  if (remote === PROTOCOL_VERSION) return 'same';
  return remote > PROTOCOL_VERSION ? 'client-old' : 'client-new';
}

// 阻塞式提示层：出现即无法关闭，只能刷新
// 用同一个容器 id，重复调用不会叠加多层遮罩
export function showVersionBlocker({ mine, remote, reason }) {
  const EXIST = 'versionBlocker';
  if (document.getElementById(EXIST)) return;

  const box = document.createElement('div');
  box.id = EXIST;
  box.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-ink/95 backdrop-blur p-4';
  box.innerHTML = `
    <div class="w-full max-w-md rounded-2xl bg-slate-900 border border-amber-400/40 p-6 text-center shadow-2xl">
      <div class="w-14 h-14 rounded-2xl bg-amber-500/20 text-amber-300 mx-auto flex items-center justify-center text-3xl mb-4">
        <i class="ri-refresh-line"></i>
      </div>
      <h3 class="text-xl font-black mb-2">页面版本不一致</h3>
      <p class="text-sm text-slate-300 leading-relaxed mb-4">${reason}</p>
      <div class="grid grid-cols-2 gap-2 text-xs mb-5">
        <div class="rounded-lg bg-white/5 p-2">
          <div class="text-slate-500 mb-0.5">你的页面</div>
          <div class="font-mono font-bold text-slate-200">v${mine}</div>
        </div>
        <div class="rounded-lg bg-white/5 p-2">
          <div class="text-slate-500 mb-0.5">房间要求</div>
          <div class="font-mono font-bold text-amber-300">v${remote || '未知'}</div>
        </div>
      </div>
      <button id="btnHardReload" class="w-full px-4 py-3 rounded-xl bg-gold text-ink font-bold hover:brightness-110 transition">
        立即刷新页面
      </button>
      <p class="text-[11px] text-slate-500 mt-3">刷新后请重新加入房间。若刷新仍提示此信息，说明房主的页面才是旧的，需要房主刷新并重建房间。</p>
    </div>`;

  document.body.appendChild(box);
  box.querySelector('#btnHardReload').addEventListener('click', hardReload);
}

// 尽力绕过缓存的刷新：先清 CacheStorage，再带一个一次性参数重载。
// location.reload(true) 已被现代浏览器忽略，所以改用换 URL 的方式。
export async function hardReload() {
  try {
    if (window.caches?.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (err) {
    console.warn('[version] 清理缓存失败，直接重载', err);
  }
  // 装成 PWA 后，光清 CacheStorage 不够：仍在运行的旧 Service Worker
  // 可能继续拦截请求。这里强制它拉一次最新的 sw.js，确保代码真的更新。
  try {
    if (navigator.serviceWorker?.getRegistrations) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.update().catch(() => null)));
    }
  } catch (err) {
    console.warn('[version] Service Worker 更新失败，直接重载', err);
  }
  const url = new URL(location.href);
  url.searchParams.set('_r', Date.now().toString(36));
  location.replace(url.toString());
}
