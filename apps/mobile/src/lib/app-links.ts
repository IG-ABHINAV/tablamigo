/**
 * Links in chat messages. The team's messages (trip matches, the Plus welcome, the empty-city nudge) carry web app links,
 * https://tablamigo.hookstep.in/app/<route>; in a chat those open the screen in the app instead of a browser. Any other
 * http(s) link opens in the system browser. Only http and https are ever links (never javascript:, data:, intent: ...),
 * and the text shown is always the address itself. Contact links between strangers are held back by the server
 * (apps/api/src/lib/contact-shield.ts) before a message is stored; nothing here loosens that.
 *
 * Also where a tapped push goes, and the report that it was opened (the email ladder, apps/api/src/lib/ladder.ts, reads it).
 */
import { SITE } from './share';

const OWN_HOST = SITE.replace(/^https:\/\//, '');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// An http(s) address, or this site written without the scheme ("tablamigo.hookstep.in/app/user/1"), starting a word.
const LINK = new RegExp(`(?<![\\w@.\\-/])(?:https?://[^\\s<>"]+|(?:www\\.)?${esc(OWN_HOST)}(?=[/?#])[^\\s<>"]*)`, 'gi');

/** route: an in-app path (e.g. "/user/<id>"); url: an address for the system browser. Plain text has neither. */
export type Piece = { text: string; route?: string; url?: string };

/** "…/app/user/1." -> "…/app/user/1": the sentence's punctuation stays text, a closing bracket only when it closes nothing. */
function trimEnd(s: string) {
  for (;;) {
    const c = s[s.length - 1];
    if (/[.,!?;:'"’”*_~]/.test(c ?? '')) { s = s.slice(0, -1); continue; }
    const open = ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[c ?? ''];
    if (open && s.split(open).length <= s.split(c).length - 1) { s = s.slice(0, -1); continue; }
    return s;
  }
}

/** Where a link this site wrote goes in the app, or null when it is a website page (opened in the browser). Pure. */
export function ownRoute(url: string): string | null {
  const m = url.match(/^(?:https?:\/\/)?(?:www\.)?([^/?#]+)([^#]*)/i);
  if (!m || m[1].toLowerCase() !== OWN_HOST) return null;
  const rest = m[2] || '/';
  if (/^\/app(?:[/?#]|$)/.test(rest)) {
    // Only the screens a message is meant to open (what Android App Links open, plus the team's own links); the rest of the
    // web app opens in the browser. Never an odd path ("//host", "..") handed to the router.
    const route = inAppPath(rest), path = route.split('?')[0];
    if (/\/\/|(?:^|\/)\.\.?(?:\/|$)/.test(path)) return null;
    return path === '/' || CHAT_ROUTES.includes(path) || APP_LINK_PREFIXES.some(p => path.startsWith(p) && path.length > p.length) ? route : null;
  }
  // An invite (/invite?code=…, /r/<code>) for someone already in the app: the invite screen.
  if (/^\/(?:invite(?:[/?]|$)|r\/)/.test(rest)) return '/referral';
  return null;
}

/** Whole screens the team's messages link to (the Plus welcome, trip alerts, the empty-city nudge). */
const CHAT_ROUTES = ['/paywall', '/activity/new', '/trip/new', '/referral'];

/** Splits a message into plain text, in-app links and browser links. Joining every piece's text gives the body back. Pure. */
export function linkify(body: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of body.matchAll(LINK)) {
    const text = trimEnd(m[0]);
    // "https://" alone, or a bare host with nothing after it, stays text.
    if (!/^(?:https?:\/\/)?[^/?#\s]+\.[^/?#\s]+/i.test(text)) continue;
    if (m.index! > last) out.push({ text: body.slice(last, m.index) });
    const route = ownRoute(text);
    out.push(route ? { text, route } : { text, url: /^https?:\/\//i.test(text) ? text : `https://${text.replace(/^www\./i, '')}` });
    last = m.index! + text.length;
  }
  if (last < body.length) out.push({ text: body.slice(last) });
  return out;
}

/** The screen a tapped notification opens: a person, a plan or a chat (in that order of specificity). Pure. */
export function routeForPush(data: Record<string, unknown> | null | undefined): string | null {
  if (!data) return null;
  if (typeof data.userId === 'string') return `/user/${data.userId}`;
  if (typeof data.activityId === 'string') return `/activity/${data.activityId}`;
  if (typeof data.chatId === 'string') return `/chat/${data.chatId}`;
  return null;
}

/** The body for POST /me/notifications/opened, when the push says which event it was. Pure. */
export function openedReport(data: Record<string, unknown> | null | undefined): { kind: string; ref: string } | null {
  return data && typeof data.nkind === 'string' && typeof data.nref === 'string' ? { kind: data.nkind, ref: data.nref } : null;
}

/**
 * Android App Links: the web app screens that open in the installed app instead of the browser. app.json lists the same
 * prefixes (under /app) as autoVerify intent filters, and the website serves /.well-known/assetlinks.json so Android trusts
 * them. Only things a person shares or is sent (a plan, a chat, a profile, a trip, a city chat, a moment); the web app's
 * home, sign-in and safety-contact pages stay in the browser.
 */
export const APP_LINK_PREFIXES = ['/activity/', '/chat/', '/user/', '/trip/', '/city/', '/m/'] as const;

/**
 * The in-app path for a link Android hands the app (expo-router's +native-intent calls this before routing). This site's
 * https://…/app/<route>?q becomes /<route>?q; anything else (tablamigo:// paths, push routes, other hosts) passes through
 * untouched. Pure.
 */
export function inAppPath(path: string): string {
  const host = SITE.replace(/^https:\/\//, '');
  let rest: string;
  const full = path.match(/^https?:\/\/([^/?#]+)([^#]*)/i);
  if (full) {
    if (full[1].toLowerCase() !== host) return path;
    rest = full[2] || '/';
  } else {
    rest = path;
  }
  const m = rest.match(/^\/app(\/[^?#]*)?(\?[^#]*)?(#.*)?$/);
  if (!m) return full ? rest : path;
  const route = (m[1] ?? '/').replace(/\/+$/, '') || '/';
  return route + (m[2] ?? '');
}
