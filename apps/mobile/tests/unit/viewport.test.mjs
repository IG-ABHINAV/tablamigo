// iPhone web layout (31 Oct 2026): the app box follows the visual viewport so the keyboard never covers the composer and
// the page never stays shifted (lib/viewport-fit.ts, lib/viewport.web.ts), bottom safe-area padding goes while the keyboard
// covers the home indicator (edgesFor), and the web shell keeps text fields at 16px on phones (Safari's focus zoom).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fitViewport, edgesFor, KEYBOARD_MIN } from '../../src/lib/viewport-fit.ts';

const base = { innerHeight: 659, vvHeight: 659, vvOffsetTop: 0, scale: 1, textFieldFocused: false };

describe('fitViewport', () => {
  test('nothing covered: no fixed height, plain 100%', () => {
    assert.deepEqual(fitViewport(base), { height: null, top: 0, keyboard: false });
  });
  test('keyboard over a focused field: the app is the visible area', () => {
    assert.deepEqual(fitViewport({ ...base, vvHeight: 323, textFieldFocused: true }), { height: 323, top: 0, keyboard: true });
  });
  test('Safari panned the visual viewport to show the field: the app follows the offset', () => {
    assert.deepEqual(fitViewport({ ...base, vvHeight: 323, vvOffsetTop: 140.4, textFieldFocused: true }), { height: 323, top: 140, keyboard: true });
  });
  test('a small difference is browser chrome, not a keyboard; still sized to what is visible', () => {
    const f = fitViewport({ ...base, vvHeight: 659 - (KEYBOARD_MIN - 1), textFieldFocused: true });
    assert.equal(f.keyboard, false); assert.equal(f.height, 659 - (KEYBOARD_MIN - 1));
  });
  test('a big difference with no field focused is not a keyboard (e.g. a find-in-page bar)', () => {
    assert.equal(fitViewport({ ...base, vvHeight: 300 }).keyboard, false);
  });
  test('after a blur the keyboard still counts while it slides away, and stops once the space is back', () => {
    assert.equal(fitViewport({ ...base, vvHeight: 400, wasKeyboard: true }).keyboard, true);
    assert.equal(fitViewport({ ...base, vvHeight: 659 - 50, wasKeyboard: true }).keyboard, false);
    assert.equal(fitViewport({ ...base, vvHeight: 659, wasKeyboard: true }).keyboard, false);
  });
  test('pinch zoom: leave the layout alone', () => {
    assert.deepEqual(fitViewport({ ...base, vvHeight: 330, scale: 2, textFieldFocused: true }), { height: null, top: 0, keyboard: false });
  });
  test('broken numbers never produce a size', () => {
    for (const bad of [{ vvHeight: 0 }, { vvHeight: NaN }, { innerHeight: 0 }, { scale: 0 }, { scale: NaN }]) {
      assert.equal(fitViewport({ ...base, ...bad }).height, null, JSON.stringify(bad));
    }
  });
  test('negative offsets (iOS overscroll) clamp to 0', () => {
    assert.equal(fitViewport({ ...base, vvHeight: 323, vvOffsetTop: -12, textFieldFocused: true }).top, 0);
  });
});

describe('edgesFor', () => {
  test('drops only the bottom edge, only while the keyboard is up', () => {
    assert.deepEqual(edgesFor(['top', 'right', 'bottom', 'left'], true), ['top', 'right', 'left']);
    assert.deepEqual(edgesFor(['top', 'bottom'], false), ['top', 'bottom']);
    assert.deepEqual(edgesFor(['top'], true), ['top']);
  });
});

describe('viewport.web.ts wiring (fake window)', () => {
  test('keyboard opens: vv-fit class + variables + keyboard flag; stays a keyboard through the blur; closes: all cleared and the document scrolled back', async () => {
    const listeners = {}, docListeners = {};
    const classes = new Set(), vars = new Map();
    const vv = { height: 659, offsetTop: 0, scale: 1, addEventListener: (t, f) => { (listeners['vv:' + t] ??= []).push(f); } };
    const input = { tagName: 'INPUT', type: 'text' };
    let scrolledTo = null;
    globalThis.window = {
      visualViewport: vv, innerHeight: 659, scrollY: 80, scrollX: 0,
      addEventListener: (t, f) => { (listeners['w:' + t] ??= []).push(f); },
      scrollTo: (x, y) => { scrolledTo = [x, y]; window.scrollY = 0; },
    };
    globalThis.document = {
      activeElement: null,
      documentElement: { classList: { add: c => classes.add(c), remove: c => classes.delete(c) }, style: { setProperty: (k, v) => vars.set(k, v), removeProperty: k => vars.delete(k) } },
      addEventListener: (t, f) => { (docListeners[t] ??= []).push(f); },
    };
    globalThis.requestAnimationFrame = f => { f(); return 1; };
    // The 300 ms follow-up checks after focus changes: run by hand below, never after this fake window is gone.
    const realSetTimeout = globalThis.setTimeout; globalThis.setTimeout = () => 0;
    const { keyboardOpenNow } = await import('../../src/lib/viewport.web.ts');
    // First run on load: nothing covered, but the document was left scrolled: put it back.
    assert.deepEqual(scrolledTo, [0, 0]); assert.equal(classes.has('vv-fit'), false); assert.equal(keyboardOpenNow(), false);

    document.activeElement = input; vv.height = 323;
    listeners['vv:resize'].forEach(f => f());
    assert.equal(classes.has('vv-fit'), true); assert.equal(keyboardOpenNow(), true);
    assert.equal(vars.get('--app-h'), '323px'); assert.equal(vars.get('--app-top'), '0px');

    vv.offsetTop = 120; listeners['vv:scroll'].forEach(f => f());
    assert.equal(vars.get('--app-top'), '120px');

    // Blur first (Send / Done), keyboard still sliding away: still a keyboard, no padding jump.
    document.activeElement = null; vv.height = 420; vv.offsetTop = 0;
    docListeners.focusout.forEach(f => f());
    assert.equal(keyboardOpenNow(), true);

    vv.height = 659; window.scrollY = 40;
    listeners['vv:resize'].forEach(f => f());
    assert.equal(keyboardOpenNow(), false);
    assert.equal(classes.has('vv-fit'), false); assert.equal(vars.has('--app-h'), false);
    assert.equal(window.scrollY, 0, 'scrolled back to the top once the keyboard closed');
    delete globalThis.window; delete globalThis.document; delete globalThis.requestAnimationFrame;
    globalThis.setTimeout = realSetTimeout;
  });
});

describe('web shell (public/index.html) and wiring', () => {
  const html = fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
  test('body is fixed and follows --app-h/--app-top under vv-fit, with a transform so modal portals follow', () => {
    assert.match(html, /body \{[^}]*position: fixed/);
    assert.match(html, /html\.vv-fit body \{[^}]*top: var\(--app-top[^}]*height: var\(--app-h[^}]*transform:/);
  });
  test('text fields are at least 16px on touch screens (no Safari focus zoom)', () => {
    assert.match(html, /@media \(pointer: coarse\) \{ input, textarea, select \{ font-size: 16px !important; \} \}/);
  });
  test('viewport-fit=cover so env(safe-area-inset-*) is reported', () => {
    assert.match(html, /<meta name="viewport" content="[^"]*viewport-fit=cover/);
  });
  test('installed app: white status bar / theme, light controls, white manifest theme', () => {
    assert.match(html, /<meta name="theme-color" content="#FFFFFF" \/>/);
    assert.match(html, /<meta name="color-scheme" content="light" \/>/);
    assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="default" \/>/);
    const m = JSON.parse(fs.readFileSync(new URL('../../public/manifest.webmanifest', import.meta.url), 'utf8'));
    assert.equal(m.display, 'standalone'); assert.equal(m.theme_color, '#FFFFFF'); assert.equal(m.background_color, '#FFFFFF');
  });
  test('every iPhone launch image link points at a PNG of exactly that screen size', () => {
    const links = [...html.matchAll(/<link rel="apple-touch-startup-image" media="screen and \(device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d)\) and \(orientation: portrait\)" href="\/app\/(splash\/[\dx]+\.png)" \/>/g)];
    assert.ok(links.length >= 10, `${links.length} launch images`);
    for (const [, w, h, r, file] of links) {
      const png = fs.readFileSync(new URL('../../public/' + file, import.meta.url));
      assert.equal(png.readUInt32BE(16), w * r, file + ' width'); assert.equal(png.readUInt32BE(20), h * r, file + ' height');
    }
  });
  test('the root layout loads lib/viewport', () => {
    assert.match(fs.readFileSync(new URL('../../src/app/_layout.tsx', import.meta.url), 'utf8'), /import '\.\.\/lib\/viewport';/);
  });
});
