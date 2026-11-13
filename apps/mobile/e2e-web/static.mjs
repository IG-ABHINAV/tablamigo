import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
// Serves out/web (the Expo web export) at /app/ like NGINX does in production: every unknown path is index.html.
// /admin serves ADMIN_HTML when set (apps/web/src/admin.html; its local copy talks to localhost:4100, which drive.mjs reroutes).
const ROOT = new URL('./out/web', import.meta.url).pathname;
const T = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/app') { res.writeHead(301, { location: '/app/' }); return res.end(); }
  if (p === '/admin' && process.env.ADMIN_HTML) { res.writeHead(200, { 'content-type': 'text/html' }); return fs.createReadStream(process.env.ADMIN_HTML).pipe(res); }
  if (!p.startsWith('/app/')) { res.writeHead(404); return res.end('not found'); }
  let f = path.join(ROOT, p.slice(5));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(ROOT, 'index.html');
  res.writeHead(200, { 'content-type': T[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(8099, '127.0.0.1', () => console.log('static on 8099'));
