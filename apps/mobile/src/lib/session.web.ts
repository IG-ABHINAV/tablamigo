import { create } from 'zustand';

type Tokens = { accessToken: string; refreshToken: string };
type S = { tokens: Tokens | null; ready: boolean; impersonating: boolean; setTokens: (t: Tokens | null) => Promise<void>; load: () => Promise<void> };

// No secure store in the browser; localStorage is per origin, which is the web's equivalent.
const KEY = 'tablamigo.tokens';
// Admin "Login as user" (admin.html opens /app/#impersonate_token=…): a read-only, 15-minute token with no refresh token
// (API lib/auth.ts). It lives in this tab's sessionStorage under its own key and never touches KEY: it used to replace the
// admin's own session in localStorage, so the admin's everyday app use ran as that user for days afterwards.
const IMP_KEY = 'tablamigo.impersonation';

/** The impersonation token in the address (fragment, or the query string older admin pages used), removed from the address. */
function takeImpersonationToken(): string | null {
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const tok = hash.get('impersonate_token') ?? url.searchParams.get('impersonate_token');
  if (!tok) return null;
  hash.delete('impersonate_token');
  url.searchParams.delete('impersonate_token');
  url.searchParams.delete('refresh_token');
  const rest = hash.toString();
  window.history.replaceState({}, '', url.pathname + url.search + (rest ? `#${rest}` : ''));
  return tok;
}

export const useSession = create<S>((set, get) => ({
  tokens: null, ready: false, impersonating: false,
  setTokens: async t => {
    // The look ends (15 minutes up, so the refresh with no refresh token fails, or Log out): the tab goes back to being an
    // ordinary signed-out tab. It used to stay in admin-view mode, so signing in there afterwards kept that real session in
    // this tab only, under the admin-view banner.
    if (get().impersonating && !t) {
      try { sessionStorage.removeItem(IMP_KEY); } catch {}
      set({ tokens: null, impersonating: false });
      return;
    }
    try {
      if (get().impersonating) sessionStorage.setItem(IMP_KEY, JSON.stringify(t));
      else if (t) localStorage.setItem(KEY, JSON.stringify(t)); else localStorage.removeItem(KEY);
    } catch {}
    set({ tokens: t });
  },
  load: async () => {
    let tokens: Tokens | null = null, impersonating = false;
    try {
      if (typeof window !== 'undefined') {
        const imp = takeImpersonationToken();
        if (imp) sessionStorage.setItem(IMP_KEY, JSON.stringify({ accessToken: imp, refreshToken: '' }));
        const held = sessionStorage.getItem(IMP_KEY);
        if (held) { tokens = JSON.parse(held); impersonating = true; }
        else { const raw = localStorage.getItem(KEY); tokens = raw ? JSON.parse(raw) : null; }
      }
    } catch {}
    set({ tokens, impersonating, ready: true });
  },

}));

// Refresh tokens rotate: keep other open tabs on the latest pair instead of letting them refresh with a spent one.
// A tab looking at someone else's account ignores the browser's own session.
if (typeof window !== 'undefined') window.addEventListener('storage', e => {
  if (e.key === KEY && !useSession.getState().impersonating) try { useSession.setState({ tokens: e.newValue ? JSON.parse(e.newValue) : null }); } catch {}
});
