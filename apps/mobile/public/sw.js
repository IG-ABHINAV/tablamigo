// Tablamigo web app service worker, scope /app/.
// App shell: index.html is network-first (a deploy shows up on the next load), hashed bundles and
// assets are cache-first (their names change with their content). API, tiles and photos are other
// origins and never touched here.
const SHELL = 'tablamigo-shell-v1';
const ASSETS = 'tablamigo-assets-v1';
const INDEX = '/app/index.html';
const MAX_ASSETS = 200;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    const res = await fetch(INDEX, { cache: 'no-cache' });
    if (res.ok) {
      const html = await res.clone().text();
      await shell.put(INDEX, res);
      // Precache what this index.html loads (bundles, preloaded fonts) plus every route chunk the entry
      // bundle can import (async routes, maplibre), so the whole app opens offline right after install.
      const own = u => u.startsWith('/app/');
      const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]).filter(own);
      const preloads = [...html.matchAll(/<link[^>]+rel="preload"[^>]+href="([^"]+)"/g)].map(m => m[1]).filter(own);
      const assets = await caches.open(ASSETS);
      await assets.addAll([...scripts, ...preloads]).catch(() => {});
      const chunks = new Set();
      for (const src of scripts) {
        const js = await (await assets.match(src))?.text().catch(() => '') ?? '';
        for (const m of js.matchAll(/"(\/app\/_expo\/static\/(?:js|css)\/web\/[^"]+\.(?:js|css))"/g)) if (!scripts.includes(m[1])) chunks.add(m[1]);
      }
      await assets.addAll([...chunks]).catch(() => {});
    }
    await shell.addAll(['/app/manifest.webmanifest', '/app/icons/icon-192.png', '/app/icons/icon-512.png']).catch(() => {});
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== ASSETS) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Hashed bundles and assets, and the fonts (their names are versioned by hand, see index.html).
const hashed = path => path.startsWith('/app/_expo/static/') || path.startsWith('/app/assets/') || path.startsWith('/app/fonts/');

async function networkFirstIndex(req) {
  const shell = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    // nginx answers every app route with index.html, so any good navigation response is the shell.
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) shell.put(INDEX, res.clone());
    return res;
  } catch {
    return (await shell.match(INDEX)) || Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    // Old deploys' files pile up; keys come back oldest first.
    const keys = await cache.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(k);
  }
  return res;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/app/') || url.pathname === '/app/sw.js') return;
  if (req.mode === 'navigate') event.respondWith(networkFirstIndex(req));
  else if (hashed(url.pathname)) event.respondWith(cacheFirst(req));
});

// ---------------------------------------------------------------------------------------------
// Web push (server: apps/api/src/lib/push.ts; client: src/lib/push.web.ts). The API sends
// {title, body, data, tag}; data.chatId opens that chat. ICON must be one of the manifest icons.
// ---------------------------------------------------------------------------------------------
const ICON = '/app/icons/icon-192.png';

function onPush(event) {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch { p = { body: event.data ? event.data.text() : '' }; }
  const data = p.data || {};
  event.waitUntil((async () => {
    // The chat is already on screen and focused: the message shows up there, no banner.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (data.chatId && wins.some(w => w.focused && new URL(w.url).pathname === `/app/chat/${data.chatId}`)) return;
    await self.registration.showNotification(p.title || 'Tablamigo', { body: p.body || '', tag: p.tag, renotify: !!p.tag, icon: ICON, badge: ICON, data });
  })());
}

function onNotificationClick(event) {
  event.notification.close();
  const data = event.notification.data || {};
  const chatId = data.chatId;
  // A person (trip match), a plan (plan views) or a chat; the same order as src/lib/app-links.ts routeForPush.
  const path = data.userId ? `/app/user/${data.userId}` : data.activityId ? `/app/activity/${data.activityId}` : chatId ? `/app/chat/${chatId}` : '/app/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => new URL(w.url).pathname.startsWith('/app'));
    // An open app routes itself and reports the open (lib/push.web.ts listens for this message); otherwise a new window
    // opens there and reports it from the query string.
    if (win) { await win.focus(); win.postMessage({ type: 'open', chatId, data }); return; }
    const q = data.nkind && data.nref ? `?nkind=${encodeURIComponent(data.nkind)}&nref=${encodeURIComponent(data.nref)}` : '';
    await self.clients.openWindow(path + q);
  })());
}

self.addEventListener('push', event => onPush(event));
self.addEventListener('notificationclick', event => onNotificationClick(event));
