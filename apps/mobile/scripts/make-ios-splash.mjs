// Makes the iPhone launch images for the installed web app (public/splash/*.png, linked from public/index.html as
// apple-touch-startup-image). Without them iOS shows a blank white screen while the app starts. Each one is the same
// picture as the page's own first paint for a signed-in person (index.html #splash, ".shell"): the orange wordmark centred on
// white, so the launch image hands over to the page with no visible jump.
// Re-run after changing the wordmark or adding a device size:  node apps/mobile/scripts/make-ios-splash.mjs
// Playwright comes from PLAYWRIGHT_FROM (a folder with node_modules/playwright), default ~/Desktop/hookpost.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire((process.env.PLAYWRIGHT_FROM ?? process.env.HOME + '/Desktop/hookpost') + '/package.json');
const { webkit } = require('playwright');

// CSS points and pixel ratio of each iPhone screen size, portrait (several models share one).
export const SIZES = [
  [440, 956, 3], // 16 Pro Max
  [402, 874, 3], // 16 Pro
  [430, 932, 3], // 14 Pro Max, 15 Plus/Pro Max, 16 Plus
  [393, 852, 3], // 14 Pro, 15, 15 Pro, 16
  [428, 926, 3], // 12/13 Pro Max, 14 Plus
  [390, 844, 3], // 12, 12 Pro, 13, 13 Pro, 14
  [375, 812, 3], // X, XS, 11 Pro, 12/13 mini (as reported)
  [414, 896, 3], // XS Max, 11 Pro Max
  [414, 896, 2], // XR, 11
  [414, 736, 3], // 6+/7+/8 Plus
  [375, 667, 2], // 6/7/8, SE 2nd/3rd gen
  [320, 568, 2], // SE 1st gen
];
export const file = ([w, h, r]) => `splash/${w * r}x${h * r}.png`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const PUB = new URL('../public/', import.meta.url).pathname;
  fs.mkdirSync(PUB + 'splash', { recursive: true });
  const font = fs.readFileSync(PUB + 'fonts/PlusJakartaSans_800ExtraBold.latin.woff2').toString('base64');
  const html = `<style>@font-face{font-family:W;src:url(data:font/woff2;base64,${font}) format("woff2")}
    html,body{margin:0;height:100%;background:#fff}body{display:flex;align-items:center;justify-content:center}
    div{font:28px W;color:#FF5A36}</style><div>tablamigo</div>`;
  const b = await webkit.launch();
  for (const s of SIZES) {
    const [w, h, r] = s;
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: r });
    await p.setContent(html); await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: PUB + file(s) });
    await p.close();
  }
  await b.close();
  console.log(SIZES.map(s => `<link rel="apple-touch-startup-image" media="screen and (device-width: ${s[0]}px) and (device-height: ${s[1]}px) and (-webkit-device-pixel-ratio: ${s[2]}) and (orientation: portrait)" href="/app/${file(s)}" />`).join('\n'));
}
