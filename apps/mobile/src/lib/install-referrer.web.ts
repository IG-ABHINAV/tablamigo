// The web app has no Play install referrer (lib/install-referrer.ts is the Android one). What it has is the address it was opened
// with: a friend's invite link lands on /app/?ref=CODE (website /invite), and links from the website or an ad carry utm_* values.
// Those are kept from the first visit (localStorage, the person may browse a while before signing in) and sent with the sign-in that
// creates the account, so the API can redeem the invite code (lib/referral.ts) and record where the sign-up came from.

const KEY = 'tm_first_touch';
const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

export type FirstTouch = { ref_code?: string; landing?: string } & Partial<Record<(typeof UTM)[number], string>>;

/** What an address's query string says about where the visit came from. Pure, so it is unit-tested. */
export function touchFromSearch(search: string, pathname = ''): FirstTouch {
  const q = new URLSearchParams(search);
  const out: FirstTouch = {};
  const ref = (q.get('ref') ?? '').trim().toUpperCase();
  if (/^[A-Z0-9]{4,16}$/.test(ref)) out.ref_code = ref;
  for (const k of UTM) { const v = q.get(k); if (v) out[k] = v.slice(0, 100); }
  if (Object.keys(out).length) out.landing = (pathname + search).slice(0, 300);
  return out;
}

/**
 * A creator partner's code from the website's tm_aff cookie (apps/web/build.py PLAY_JS sets it from ?ref=CODE for 60 days). The
 * website and /app/ share an origin, so a visitor who came through a partner's link on the website and opened the web app later
 * still signs up as that partner's referral. Pure, so it is unit-tested.
 */
export function refFromCookie(cookie: string): string | undefined {
  return /(?:^|;\s*)tm_aff=([A-Z0-9]{4,16})(?:;|$)/.exec(cookie || '')?.[1];
}

/** Keeps the first visit's values; a later invite code replaces an older one (the newest invite is the one the person acted on). */
export function mergeTouch(stored: FirstTouch | null, now: FirstTouch): FirstTouch | null {
  if (!Object.keys(now).length) return stored;
  if (!stored) return now;
  return now.ref_code ? { ...stored, ref_code: now.ref_code } : stored;
}

function read(): FirstTouch | null {
  try { const raw = window.localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

export function captureFirstTouch(): void {
  if (typeof window === 'undefined' || !window.location) return;
  const next = mergeTouch(read(), touchFromSearch(window.location.search, window.location.pathname));
  if (!next) return;
  try { window.localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: the sign-in just carries nothing */ }
}

// At load: the query string is only there on the first page the web app opens.
captureFirstTouch();

export const installReferrer = async (): Promise<string | null> => null;

/** What the sign-in calls add to their body: the invite code and utm_* values the web app was opened with, if any. */
export const signupExtras = async (): Promise<FirstTouch> => {
  captureFirstTouch();
  const t = read() ?? {};
  if (!t.ref_code) {
    let c: string | undefined;
    try { c = refFromCookie(document.cookie); } catch { /* no cookies */ }
    if (c) return { ...t, ref_code: c };
  }
  return t;
};
