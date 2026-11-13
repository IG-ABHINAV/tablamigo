/**
 * Security headers on every API response (server.ts adds them in an onSend hook), plus the CSP report sink.
 *
 * The API answers JSON, media files and a few small HTML pages (email unsubscribe and alert links, routes/email.ts). None of
 * them is ever meant to run in a frame, sniff a type, send a Referer or load anything, so the policy is strict:
 *  - JSON and media: Content-Security-Policy "default-src 'none'; frame-ancestors 'none'; base-uri 'none'".
 *  - The HTML pages: their inline <style> and the logo image from the website are allowed, nothing else.
 *  - X-Content-Type-Options nosniff, Referrer-Policy no-referrer, X-Frame-Options DENY (older browsers).
 *  - Strict-Transport-Security in production only (a year; no includeSubDomains: other hookstep.in names are not ours to pin).
 * A header a route already set (the media route's own nosniff) is left as it is.
 *
 * The website and the web app (nginx, infra/nginx/tablamigo-headers.conf) send a report-only CSP whose reports come to
 * POST /csp-report: logged as one short line each (directive, blocked origin, page path), no query strings, no body kept.
 */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
export const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src https://tablamigo.hookstep.in; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
export const HSTS = 'max-age=31536000';

export function securityHeaders(contentType: string | undefined, isProd: boolean): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': /^text\/html/i.test(contentType ?? '') ? HTML_CSP : API_CSP,
    ...(isProd ? { 'strict-transport-security': HSTS } : {}),
  };
}

/** Scheme and host of a URL, or a CSP keyword ('inline', 'eval', 'data'), never its path or query. */
export function cspOrigin(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return '-';
  if (/^[a-z-]+$/i.test(s)) return s.slice(0, 20);   // inline, eval, self, wasm-eval, trusted-types-sink
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'wss:' ? u.origin : u.protocol.replace(/:$/, ''); }
  catch { return 'invalid'; }
}
/** The path of the page a report came from, without its query or fragment (they can carry tokens). */
export function cspPage(v: unknown): string {
  try { const u = new URL(String(v)); return `${u.host}${u.pathname}`.slice(0, 120); } catch { return '-'; }
}

/** One report from either format (report-uri's {"csp-report": {...}}, or the Reporting API's [{type, body}]) as a log line. */
export function cspReportLines(body: unknown): string[] {
  const items: any[] = Array.isArray(body) ? body.filter(r => r?.type === 'csp-violation').map(r => r.body) : (body as any)?.['csp-report'] ? [(body as any)['csp-report']] : [];
  return items.slice(0, 10).map(r => {
    const directive = String(r?.['effective-directive'] ?? r?.effectiveDirective ?? r?.['violated-directive'] ?? '-').replace(/[^a-z-]/gi, '').slice(0, 40) || '-';
    const blocked = cspOrigin(r?.['blocked-uri'] ?? r?.blockedURL);
    const page = cspPage(r?.['document-uri'] ?? r?.documentURL);
    const mode = (r?.disposition ?? 'report') === 'enforce' ? 'enforced' : 'report-only';
    return `csp ${mode}: ${directive} blocked ${blocked} on ${page}`;
  });
}

/** Where report lines go: the request's logger (PM2's log). An object so a test can watch it. */
export const cspSink = { write: (log: { warn: (m: string) => void }, line: string) => log.warn(line) };
