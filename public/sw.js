// Service worker: lets the app open offline and load fast. Personal data (login, orders, seller pages' API) is never cached.
const V = 'pickup-shop-v1';
const SHELL = ['/', '/seller.html', '/style.css', '/common.js', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())));

const keep = async (req, res) => { if (res && res.ok) (await caches.open(V)).put(req, res.clone()); return res; };
const networkFirst = (req, fallback) => fetch(req).then(res => keep(req, res))
  .catch(async () => (await caches.match(req)) || (fallback && (await caches.match(fallback))) || Response.error());
const cacheFirst = async req => (await caches.match(req)) || fetch(req).then(res => keep(req, res));
const staleWhileRevalidate = async req => {
  const hit = await caches.match(req), net = fetch(req).then(res => keep(req, res)).catch(() => hit);
  return hit || net;
};

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url), p = url.pathname;
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (p.startsWith('/api/img/') || p === '/api/placeholder.svg') return e.respondWith(cacheFirst(req));
  if (p === '/api/items' || p === '/api/shop' || p === '/api/manifest') return e.respondWith(networkFirst(req));
  if (p.startsWith('/api/')) return;                       // auth, orders, seller data: always live
  if (req.mode === 'navigate') return e.respondWith(networkFirst(req, p === '/seller.html' ? '/seller.html' : '/'));
  e.respondWith(staleWhileRevalidate(req));
});
