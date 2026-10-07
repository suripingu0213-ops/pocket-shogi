// オフライン用 Service Worker。一度開けば以降は通信なしで起動できる。
// 通信できる時は常に最新のファイルを取りに行き（更新がすぐ反映される）、圏外ならキャッシュで動く。
// アプリを更新したら VERSION を上げる。
const VERSION = 'pocket-shogi-v9';
const APP_FILES = [
  './', './index.html', './shogi_engine.js', './ai_worker.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png',
];
const NET_TIMEOUT_MS = 3000; // 電波が弱い時はこれ以上待たずにキャッシュを使う

self.addEventListener('install', (e) => {
  // ブラウザのHTTPキャッシュ（GitHub Pages は10分）を通さず最新を取る
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(APP_FILES.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function networkFirst(req) {
  return new Promise((resolve) => {
    let settled = false;
    const fromCache = () => caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req));
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(fromCache()); } }, NET_TIMEOUT_MS);
    fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      if (!settled) { settled = true; clearTimeout(timer); resolve(res); }
    }).catch(() => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(fromCache()); }
    });
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Google Fonts: キャッシュにあればそれを使い、裏で更新
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(VERSION + '-fonts').then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(networkFirst(req));
});
