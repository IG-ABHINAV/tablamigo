// Keeps the web app inside what the person can see on phones (see lib/viewport-fit.ts for why). The CSS that reads these
// variables is in public/index.html: body takes --app-h and --app-top while <html> has the vv-fit class, and a transform on
// body then makes RN-web's modal portals (position: fixed children of body) follow it too.
import { create } from 'zustand';
import { fitViewport } from './viewport-fit';

const useKb = create<{ open: boolean }>(() => ({ open: false }));
/** True while the on-screen keyboard covers part of the page. Bottom bars drop their home-indicator padding then. */
export const useKeyboardOpen = () => useKb(s => s.open);
/** The same, outside React (tests, event handlers). */
export const keyboardOpenNow = () => useKb.getState().open;

const isField = (el: Element | null) => !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|file|color)$/i.test((el as HTMLInputElement).type)) || (el as HTMLElement).isContentEditable);

function install() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  let pending = false;
  const apply = () => {
    const fit = fitViewport({ innerHeight: window.innerHeight, vvHeight: vv.height, vvOffsetTop: vv.offsetTop, scale: vv.scale, textFieldFocused: isField(document.activeElement), wasKeyboard: useKb.getState().open });
    if (fit.height == null) {
      root.classList.remove('vv-fit');
      root.style.removeProperty('--app-h'); root.style.removeProperty('--app-top');
    } else {
      root.classList.add('vv-fit');
      root.style.setProperty('--app-h', fit.height + 'px'); root.style.setProperty('--app-top', fit.top + 'px');
    }
    // iOS scrolls the (non-scrolling) document to bring a focused field into view and can leave it there after the keyboard
    // closes, which shifts every screen. The body is fixed, so the document should never be scrolled.
    if (!fit.keyboard && (window.scrollY || window.scrollX)) window.scrollTo(0, 0);
    const opened = fit.keyboard && !useKb.getState().open;
    if (useKb.getState().open !== fit.keyboard) useKb.setState({ open: fit.keyboard });
    // The app just got shorter: a field inside a scroll view may now be below the fold. Bring it back into view (the body is
    // fixed, so this scrolls only the screen's own scroll view).
    if (opened) {
      const el = document.activeElement as HTMLElement | null;
      requestAnimationFrame(() => { if (el && document.activeElement === el) el.scrollIntoView?.({ block: 'nearest' }); });
    }
  };
  // One update per frame however many events fire (Safari sends resize and scroll together while the keyboard animates).
  const schedule = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; apply(); }); };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  // Focus changes decide keyboard vs toolbar; the keyboard animates for ~250 ms after focus, so look again after it.
  document.addEventListener('focusin', () => { schedule(); setTimeout(schedule, 300); });
  document.addEventListener('focusout', () => { schedule(); setTimeout(schedule, 300); });
  apply();
}

if (typeof window !== 'undefined') install();
