// PWA 装配：注册 Service Worker、处理更新、提供「添加到主屏幕」引导。
//
// 路径策略：全部用相对路径（'./sw.js'），这样无论仓库叫什么名字、
// 部署在 user.github.io/<repo>/ 还是自定义域名根目录，都无需改配置。

const $ = id => document.getElementById(id);

// 检测是否已经以独立应用形态运行
export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: fullscreen)').matches
      || window.navigator.standalone === true;
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// 注册 SW。updateViaCache:'none' 让浏览器不缓存 sw.js 本体，
// 否则改了 sw.js 也可能长时间不生效。
export function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  // file:// 协议下 SW 不可用，本地直接双击打开时静默跳过
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', {
        scope: './',
        updateViaCache: 'none'
      });

      // 发现新版本就让它立刻接管，并在接管后刷新一次。
      // 联机游戏必须尽快统一代码版本，宁可多刷一次。
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            sw.postMessage('skip-waiting');
          }
        });
      });

      let refreshed = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshed) return;
        refreshed = true;
        location.reload();
      });

      // 每次回到前台检查一次更新，朋友重开 app 就能拿到最新代码
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
    } catch (err) {
      console.warn('[pwa] Service Worker 注册失败', err);
    }
  });
}

// ============ 安装引导 ============
// Android / 桌面 Chrome 会触发 beforeinstallprompt，可直接调起原生安装弹窗。
// iOS Safari 不支持，只能图文引导用户点「分享 → 添加到主屏幕」。

let deferredPrompt = null;
const DISMISS_KEY = 'holdem_install_dismissed';

function dismissed() {
  try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}

function markDismissed() {
  try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* 隐私模式忽略 */ }
}

function hideBar() {
  const bar = $('installBar');
  if (bar) bar.classList.add('hidden');
}

function showBar(text, actionLabel) {
  const bar = $('installBar');
  if (!bar) return;
  const label = $('installText');
  const btn = $('btnInstall');
  if (label) label.textContent = text;
  if (btn) btn.textContent = actionLabel;
  bar.classList.remove('hidden');
}

function showIOSGuide() {
  const box = $('iosGuide');
  if (box) box.classList.remove('hidden');
}

export function initInstallPrompt() {
  // 已经装好了就什么都不提示
  if (isStandalone()) { hideBar(); return; }

  window.addEventListener('beforeinstallprompt', ev => {
    ev.preventDefault();
    deferredPrompt = ev;
    if (!dismissed()) showBar('把牌桌装到桌面，像 App 一样打开', '安装');
  });

  const btn = $('btnInstall');
  if (btn) {
    btn.addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        try { await deferredPrompt.userChoice; } catch { /* 用户取消 */ }
        deferredPrompt = null;
        hideBar();
        return;
      }
      // 没有原生弹窗可用（主要是 iOS Safari）
      showIOSGuide();
    });
  }

  const close = $('btnInstallClose');
  if (close) {
    close.addEventListener('click', () => { markDismissed(); hideBar(); });
  }

  const guideClose = $('btnIosGuideClose');
  if (guideClose) {
    guideClose.addEventListener('click', () => {
      const box = $('iosGuide');
      if (box) box.classList.add('hidden');
    });
  }

  // iOS 拿不到 beforeinstallprompt，主动露出引导入口
  if (isIOS() && !dismissed()) {
    showBar('用 Safari 分享菜单可添加到主屏幕', '怎么装');
  }
}

export function initPWA() {
  registerSW();
  initInstallPrompt();
}
