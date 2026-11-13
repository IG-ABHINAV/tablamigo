// The layout rules iphone.mjs checks on every screen (admin-layout.mjs too). auditScript runs inside the page
// (page.evaluate), so it must not use anything from this module's scope. Returns { problems: string[], smallTargets: string[] }.
export function auditScript(ins) {
  const W = window.innerWidth, H = window.innerHeight;
  const problems = [], smallTargets = [], smallIcons = [];
  const label = el => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
  const visible = el => { const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // Inside something that scrolls sideways on purpose (carousels, chip rows) or is clipped by an ancestor.
  const clipped = el => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll|hidden)/.test(cs.overflowX)) { const r = p.getBoundingClientRect(); if (r.right <= W + 1 && r.left >= -1) return true; } } return false; };

  // 1. The page itself scrolls sideways.
  const sw = document.documentElement.scrollWidth;
  if (sw > W + 1) problems.push(`page is ${sw}px wide in a ${W}px viewport`);
  // 2. Something sticks out past the right/left edge without a clipping scroller.
  const out = [];
  for (const el of document.querySelectorAll(document.getElementById('root') ? '#root *' : 'body *')) {
    if (el.closest('.maplibregl-map')) continue;
    const r = el.getBoundingClientRect();
    if ((r.right > W + 2 || r.left < -2) && r.width < W * 3 && visible(el) && !clipped(el) && el.children.length === 0 && el.textContent.trim()) out.push(`"${label(el)}" ${Math.round(r.left)}..${Math.round(r.right)}`);
  }
  if (out.length) problems.push(`off-screen sideways: ${out.slice(0, 4).join(', ')}`);
  // 3. Text fields under 16px: Safari zooms in on focus and stays zoomed.
  for (const el of document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]), textarea, select')) {
    if (!visible(el)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 16) problems.push(`text field "${label(el)}" is ${fs}px (iOS zooms under 16px)`);
  }
  // 4. Window scrolled away from the top (iOS keeps it shifted after the keyboard) or zoomed.
  if (window.scrollY > 1 || window.scrollX > 1) problems.push(`window scrolled to ${Math.round(window.scrollX)},${Math.round(window.scrollY)}`);
  if (window.visualViewport && Math.abs(window.visualViewport.scale - 1) > 0.01) problems.push(`page zoomed to ${window.visualViewport.scale.toFixed(2)}`);
  // 4b. Unreadable text: words or numbers under 3:1 against the colour behind them (since 2 Nov 2026; the grey ink3 and the teal
  // were 2.6-2.7:1). Emoji, icon glyphs and disabled controls are skipped; text over a photo or gradient is not judged.
  const lum = c => { const m = c.match(/[\d.]+/g); if (!m) return null; const [r, g, b, a = 1] = m.map(Number); if (a < 0.05) return null; return [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0); };
  const behind = el => { for (let p = el; p; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.backgroundImage !== 'none') return null; const l = lum(cs.backgroundColor); if (l !== null) return l; } return 1; };
  const faint = [];
  for (const el of document.querySelectorAll(document.getElementById('root') ? '#root *' : 'body *')) {
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    if (!/[\p{L}\p{N}]/u.test(own) || el.closest('.maplibregl-map, [aria-disabled=true], [disabled]') || !visible(el)) continue;
    const r = el.getBoundingClientRect(); if (r.bottom < 0 || r.top > H) continue;
    const cs = getComputedStyle(el); if (Number(cs.opacity) < 1) continue;
    const fg = lum(cs.color), bg = behind(el); if (fg === null || bg === null) continue;
    const k = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    if (k < 3) faint.push(`"${own.slice(0, 24)}" ${k.toFixed(1)}:1`);
  }
  if (faint.length) problems.push(`text under 3:1 contrast: ${faint.slice(0, 4).join(', ')}`);
  // 5. Tappable things under the status bar or the home indicator; tap targets under 44pt.
  const taps = document.querySelectorAll(document.getElementById('root') ? '#root [role=button], #root a[href], #root button, #root [role=tab], #root [role=link], #root input, #root textarea, #root [role=switch], #root [role=checkbox]' : '[role=button], a[href], button, [role=tab], input, textarea, select');
  const zone = [];
  for (const el of taps) {
    if (!visible(el) || el.closest('.maplibregl-map')) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= H) continue;
    // Only what a finger would actually hit there: scrolled content passing behind a tab bar is fine, and so is content in a
    // scroll view that can still scroll it up (iphone.mjs scrolls every list to its end and checks again).
    const onTop = y => { const h = document.elementFromPoint(r.left + r.width / 2, y); return !!h && (h === el || el.contains(h)); };
    const canScrollUp = () => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1 && p.scrollTop + p.clientHeight < p.scrollHeight - 1) return true; } return false; };
    if ((ins.top && r.top < ins.top - 1 && r.bottom > 0 && onTop(Math.max(r.top + 1, 1))) ||
        (ins.bottom && r.bottom > H - ins.bottom + 1 && r.top < H && onTop(Math.min(r.bottom - 1, H - 1)) && !canScrollUp())) zone.push(`"${label(el)}" ${Math.round(r.top)}-${Math.round(r.bottom)}`);
    if (r.width < 43.5 || r.height < 43.5) {
      // A small visual with a bigger hit area (hitSlop, padding on a wrapper) is fine: check what a tap there would hit.
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hits = [[cx, r.top - 6], [cx, r.bottom + 6], [r.left - 6, cy], [r.right + 6, cy]].filter(([x, y]) => { const h = document.elementFromPoint(x, y); return h && (h === el || el.contains(h)); }).length;
      // An icon-only button (a label for screen readers, no letters or digits on it: an icon font glyph) has no excuse to be
      // small: IconButton gives it a 44pt box on the web. A text link or a pill with words is only reported.
      const iconOnly = el.getAttribute('aria-label') && !/[\p{L}\p{N}]/u.test(el.innerText || '') && !/INPUT|TEXTAREA/.test(el.tagName);
      if (hits < 2) (iconOnly ? smallIcons : smallTargets).push(`${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  }
  if (zone.length) problems.push(`tappable under the status bar / home indicator: ${zone.slice(0, 4).join(', ')}`);
  if (smallIcons.length) problems.push(`icon button under 44pt: ${smallIcons.slice(0, 4).join(', ')}`);
  return { problems, smallTargets };
}
