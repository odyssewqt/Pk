// Service Worker：只为「能装到桌面 + 断网能打开壳」服务，绝不缓存旧版游戏代码。
//
// 核心约束（联机游戏特有）：
// 房主与客机必须跑同一份 engine / sync 代码，否则 PROTOCOL_VERSION 校验会互相
// 打脸，甚至出现两边牌局状态不一致。所以自家的 HTML / JS 一律 network-first：
// 有网必取最新，只有彻底断网才回退到缓存。CDN 依赖（Tailwind / Remixicon）是
// 带版本号的不可变资源，走 cache-first 省流量、加快冷启动。
//
// 缓存名带版本号，改这个号即可让所有旧缓存在下次激活时被清空。
const CACHE = 'holdem-shell-v4';

// 预缓存：仅壳资源，保证断网时能打开页面并看到「需要联网」的提示，
// 而不是浏览器的恐龙错误页。js 不预缓存，避免固化某个历史版本。
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './icon-maskable.svg'
];

// 判断是否本站资源（同源即为自家代码）
function isOwn(url) {
  return url.origin === self.location.origin;
}

// 判断是否可 cache-first 的第三方不可变资源
function isVendor(url) {
  return url.hostname === 'cdn.tailwindcss.com'
      || url.hostname === 'cdn.jsdelivr.net';
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll 任一失败会整体 reject，这里逐个 add 并忽略失败，
      // 避免某个 CDN 抖动导致 SW 永远装不上。
      .then(cache => Promise.all(SHELL.map(u => cache.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 页面主动要求立刻接管（配合前端检测到新版本时的自动刷新）
self.addEventListener('message', event => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;

  // 只处理 GET；POST 等一律直连，绝不能碰 Supabase 的写请求
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Supabase 等实时接口：完全不介入，避免任何缓存干扰联机同步
  if (!isOwn(url) && !isVendor(url)) return;

  // 第三方不可变资源：cache-first
  if (isVendor(url)) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }))
    );
    return;
  }

  // 自家 HTML / JS / 图标：network-first，保证永远拿到最新代码
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        // 导航请求断网兜底：回退到缓存的首页
        if (req.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        return new Response('离线状态下无法加载该资源', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      })
  );
});
