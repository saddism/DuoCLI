// DuoCLI Mobile - Service Worker

const CACHE_NAME = 'duocli-v17';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/xterm.css',
  '/xterm.js',
  '/addon-fit.js',
  '/addon-unicode11.js',
  '/android-mirror-client.js',
  '/android-pointer-helpers.js',
  '/file-preview-helpers.js',
  '/terminal-scroll-helpers.js',
  '/spinner-interceptor.js',
  '/terminal-content-helpers.js',
  '/cli-tag-colors.js',
  '/manifest.json',
];

// 安装：缓存静态资源
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// 激活：清理旧缓存
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 请求拦截：API 走网络，静态资源走缓存
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // API 请求和 SSE 不缓存
  if (url.pathname.startsWith('/api/')) return;
  // 局域网探针：永远走网络，避免 SW 缓存导致误判 + 缓存条目无限累积
  if (url.pathname === '/ping.png') return;

  // 应用外壳（HTML/JS/CSS）网络优先：联网时一次刷新即拿最新代码，断网才回退缓存。
  // 避免 stale-while-revalidate 导致改完代码要重开两次才生效。
  const isAppShell =
    e.request.mode === 'navigate' ||
    /\.(?:js|css|html)$/.test(url.pathname) ||
    url.pathname === '/';
  if (isAppShell) {
    e.respondWith(
      fetch(e.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      // 有缓存就用缓存，同时后台更新
      const fetchPromise = fetch(e.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});

// 推送通知
self.addEventListener('push', e => {
  if (!e.data) return;

  try {
    const data = e.data.json();
    e.waitUntil(
      self.registration.showNotification(data.title || 'DuoCLI', {
        body: data.body || '',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: data.sessionId || 'default',
        data: { sessionId: data.sessionId },
        requireInteraction: false,
      })
    );
  } catch {}
});

// 点击通知 → 打开应用
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // 如果已有窗口，聚焦
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          return client.focus();
        }
      }
      // 否则打开新窗口
      return self.clients.openWindow('/');
    })
  );
});
