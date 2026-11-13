// Render framed Play Store screenshots.
//   node render.cjs [config.json] [--only name1,name2] [--no-sheet]
// Reads slides from the config (default: slides.json next to this file), renders each through
// index.html in headless Chrome over a throwaway local http server, writes PNGs to <config.out>,
// checks safe zones, then builds contact sheets with ffmpeg.
const { chromium } = require(process.env.HOME + '/Desktop/hookpost/node_modules/playwright');
const http = require('http'), fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');

const HERE = __dirname;
const args = process.argv.slice(2);
const cfgPath = path.resolve(args.find(a => a.endsWith('.json')) || path.join(HERE, 'slides.json'));
const only = (args[args.indexOf('--only') + 1] || '').split(',').filter(Boolean);
const wantSheet = !args.includes('--no-sheet');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const cfgDir = path.dirname(cfgPath);
const outDir = path.resolve(cfgDir, cfg.out || 'out');
fs.mkdirSync(outDir, { recursive: true });

const MIME = { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ttf': 'font/ttf', '.js': 'text/javascript', '.json': 'application/json' };
// "/" serves this folder; "/abs/<absolute path>" serves a local file (raw screenshots can live anywhere).
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  const file = p.startsWith('/abs/') ? p.slice(4) : path.join(HERE, p === '/' ? 'index.html' : p);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }); res.end(buf);
  });
});
const url = f => '/abs' + encodeURI(path.resolve(cfgDir, f));

(async () => {
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ channel: 'chrome' });
  const D = Object.assign({}, cfg.defaults, { brandIcon: url(cfg.defaults.brandIcon) });
  const slides = [...cfg.slides, ...(cfg.feature ? [Object.assign({ layout: 'feature' }, cfg.feature)] : [])]
    .filter(s => !only.length || only.includes(s.name));
  const written = [], problems = [];
  for (const s of slides) {
    const W = s.width || D.width, H = s.height || D.height;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await page.goto(base + 'index.html');
    const m = await page.evaluate(([slide, d]) => window.build(slide, d), [Object.assign({}, s, { raw: url(s.raw), cutouts: (s.cutouts || []).map(c => c.src ? Object.assign({}, c, { src: url(c.src) }) : c) }), D]);
    await page.evaluate(() => Promise.all([...document.images].map(i => i.decode().catch(() => {}))));
    const file = path.join(outDir, s.name + '.png');
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: W, height: H } });
    await page.close();
    written.push({ file, feature: s.layout === 'feature' });

    // Safe-zone checks: text inside side margins and above the bottom 8%; nothing clipped.
    const warn = msg => problems.push(`${s.name}: ${msg}`);
    const mx = s.layout === 'feature' ? 40 : 60;
    if (m.h1Overflow) warn(`headline wider than the copy box even at ${m.headlineSize}px`);
    if (m.subOverflow) warn('sub-line wider than the copy box');
    if (m.copy.x < mx || m.copy.r > W - mx) warn('copy inside the side margin');
    if (m.copy.b > H * 0.92) warn('copy inside the bottom 8%');
    if (s.layout !== 'feature' && m.headlineSize < 88) warn(`headline ${m.headlineSize}px < 88px`);
    m.cuts.forEach((c, i) => {
      if (c.x < 12 || c.r > W - 12 || c.y < 0 || c.b > H) warn(`cutout ${i + 1} runs off the canvas`);
      if (c.y < m.copy.b && c.b > m.copy.y && c.x < m.copy.r && c.r > m.copy.x) warn(`cutout ${i + 1} overlaps the copy`);
    });
    console.log(`${s.name}.png  headline ${m.headlineSize}px x${m.headlineLines} lines${m.subSize ? `, sub ${m.subSize}px` : ''}`);
  }
  await browser.close(); server.close();

  if (wantSheet) {
    const shots = written.filter(w => !w.feature).map(w => w.file);
    const sheet = (w, name) => {
      if (!shots.length) return;
      const inputs = shots.flatMap(f => ['-i', f]);
      const scaled = shots.map((_, i) => `[${i}:v]scale=${w}:-1:flags=lanczos,pad=iw+${w / 18 | 0}:ih:color=0x16161D[v${i}]`).join(';');
      const filter = `${scaled};${shots.map((_, i) => `[v${i}]`).join('')}hstack=inputs=${shots.length}`;
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...inputs, '-filter_complex', filter, path.join(outDir, name)]);
      console.log('sheet', name);
    };
    sheet(360, '_contact-sheet.png');   // review size
    sheet(180, '_contact-thumbs.png');  // roughly how Play shows them in a listing
  }
  // Website copies (needs cwebp; brew install webp): NAME.webp at 540x960 for 2x screens and NAME-270.webp at 270x480 for 1x,
  // quality 65, method 6, sharp YUV (about 20% smaller than the old q80 at 2x with no visible difference; 11 Oct 2026).
  // Copy both into apps/web/screens/; the home page's srcset names both.
  const webDir = path.join(outDir, 'web'); fs.mkdirSync(webDir, { recursive: true });
  outer: for (const w of written.filter(w => !w.feature)) {
    for (const [width, height, suffix] of [['540', '960', ''], ['270', '480', '-270']]) {
      try { execFileSync('cwebp', ['-quiet', '-q', '65', '-m', '6', '-sharp_yuv', '-resize', width, height, w.file, '-o', path.join(webDir, path.basename(w.file, '.png') + suffix + '.webp')]); }
      catch (e) { problems.push('webp export failed: ' + e.message.split('\n')[0]); break outer; }
    }
  }
  console.log(problems.length ? '\nCHECKS FAILED\n  ' + problems.join('\n  ') : '\nall safe-zone checks passed');
  console.log('out:', outDir);
  process.exitCode = problems.length ? 2 : 0;
})().catch(e => { console.error(e); server.close(); process.exit(1); });
