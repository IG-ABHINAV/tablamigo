// Where the web app's root box goes so it always covers exactly what the person can see (lib/viewport.web.ts applies it).
// iPhone Safari (and Chrome on Android since 108) do not shrink the page for the on-screen keyboard: they shrink and pan the
// *visual* viewport over an unchanged layout, so a bottom composer ends up under the keyboard, the header slides off the
// top, and the page often stays shifted after the keyboard closes. Sizing the root to the visual viewport and following its
// offset keeps every screen's own layout (header on top, composer or tab bar at the bottom) inside the visible area.
// No DOM here so it can be unit-tested.

export type ViewportInput = {
  innerHeight: number;        // layout viewport height (window.innerHeight)
  vvHeight: number;           // visualViewport.height
  vvOffsetTop: number;        // visualViewport.offsetTop
  scale: number;              // visualViewport.scale (pinch zoom)
  textFieldFocused: boolean;  // document.activeElement is an input/textarea/contenteditable
  wasKeyboard?: boolean;      // the previous result said keyboard: it stays up while it animates away after a blur
};
export type ViewportFit = { height: number | null; top: number; keyboard: boolean };

/** Smaller differences are browser chrome (Safari's toolbar collapsing), not a keyboard. */
export const KEYBOARD_MIN = 120;

export function fitViewport(v: ViewportInput): ViewportFit {
  // Pinch-zoomed: the visual viewport is a magnifier over the page, not the screen. Leave the layout alone.
  if (!(v.scale > 0) || Math.abs(v.scale - 1) > 0.01) return { height: null, top: 0, keyboard: false };
  if (!(v.vvHeight > 0) || !(v.innerHeight > 0)) return { height: null, top: 0, keyboard: false };
  const covered = v.innerHeight - v.vvHeight;
  // A focused field is what tells a keyboard from other chrome; once open, it counts until the space is given back (on blur
  // the field loses focus at once but the keyboard takes ~250 ms to slide away).
  const keyboard = covered >= KEYBOARD_MIN && (v.textFieldFocused || !!v.wasKeyboard);
  const top = Math.max(0, Math.round(v.vvOffsetTop));
  // Nothing covered and nothing panned: plain 100% is right (and survives rotation without a stale pixel height).
  if (covered < 1 && top === 0) return { height: null, top: 0, keyboard: false };
  return { height: Math.round(v.vvHeight), top, keyboard };
}

export type Edge = 'top' | 'right' | 'bottom' | 'left';
/** Safe-area edges to pad: the bottom one goes while the keyboard covers the home indicator. */
export const edgesFor = (edges: readonly Edge[], keyboardOpen: boolean): Edge[] => edges.filter(e => !keyboardOpen || e !== 'bottom');
