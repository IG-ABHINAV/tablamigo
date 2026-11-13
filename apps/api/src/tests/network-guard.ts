/**
 * No test process reaches the internet. Installed by test-setup.ts (integration + e2e) and test-unit-setup.ts (unit) before
 * any app module loads, so a module that saves `globalThis.fetch` at import time saves this one.
 *
 * - fetch to loopback goes through; Nominatim and Photon get a canned answer (below); any other host throws.
 * - Backstop for what doesn't use globalThis.fetch (google-auth-library's node-fetch for Google sign-in certs, the RTDN OIDC
 *   check, Play and FCM; web-push; the S3 SDK; raw http/https): a TCP or TLS connection to a non-local host fails with an
 *   error naming the host, the way a refused connection would. Those are mocked per test (vi.spyOn / vi.mock).
 *
 * A test that needs an outside answer stubs fetch itself (vi.stubGlobal('fetch', ...) or globalThis.fetch = ...) and falls back
 * to the fetch it found, which is this one.
 */
import net from 'node:net';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const extraHosts = () => (process.env.TEST_DB_HOSTS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
export const isLocalHost = (host: string) => {
  const h = host.toLowerCase();
  return LOOPBACK.has(h) || /^127\./.test(h) || h.endsWith('.localhost') || extraHosts().includes(h);
};

/**
 * The fake reverse geocoder: the nearest of these within 50 km, otherwise Nominatim's own "Unable to geocode" (open sea, or a
 * place no test needs). lib/geo.ts caches neither a failure nor this miss. Tests that need a particular answer for a cell
 * (a country without a city, say) seed geo_cache or stub fetch themselves.
 */
const CITIES: [string, string, number, number][] = [
  ['Bangkok', 'th', 13.7563, 100.5018], ['Phuket', 'th', 7.8804, 98.3923], ['Chiang Mai', 'th', 18.7883, 98.9853],
  ['Mumbai', 'in', 19.076, 72.8777], ['Pune', 'in', 18.5204, 73.8567], ['Panaji', 'in', 15.4909, 73.8278],
  ['Bengaluru', 'in', 12.9716, 77.5946], ['New Delhi', 'in', 28.6139, 77.209], ['Kolkata', 'in', 22.5726, 88.3639],
  ['Kochi', 'in', 9.9312, 76.2673], ['Leh', 'in', 34.1526, 77.5771], ['Pathankot', 'in', 32.2643, 75.6421],
  ['Lisbon', 'pt', 38.7223, -9.1393], ['Barcelona', 'es', 41.3874, 2.1686], ['Paris', 'fr', 48.8566, 2.3522],
  ['London', 'gb', 51.5072, -0.1276], ['Berlin', 'de', 52.52, 13.405], ['Valletta', 'mt', 35.8989, 14.5146],
  ['Reykjavík', 'is', 64.1466, -21.9426], ['New York', 'us', 40.7128, -74.006], ['Riyadh', 'sa', 24.7136, 46.6753],
  ['Tokyo', 'jp', 35.6762, 139.6503], ['Denpasar', 'id', -8.65, 115.2167], ['Sydney', 'au', -33.8688, 151.2093],
];
const km = (a: number, b: number, c: number, d: number) => {
  const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function fakeNominatim(u: URL): Response {
  const lat = Number(u.searchParams.get('lat')), lng = Number(u.searchParams.get('lon'));
  let best: (typeof CITIES)[number] | null = null, bestKm = 50;
  for (const c of CITIES) { const d = km(lat, lng, c[2], c[3]); if (d <= bestKm) { best = c; bestKm = d; } }
  return best ? json({ address: { city: best[0], country_code: best[1] } }) : json({ error: 'Unable to geocode' });
}

const FAKES: Record<string, (u: URL) => Response> = {
  'nominatim.openstreetmap.org': fakeNominatim,
  // Place search: nothing found, so placeNear() gives no coordinates unless a test stubs fetch with an answer.
  'photon.komoot.io': () => json({ type: 'FeatureCollection', features: [] }),
};

const INSTALLED = Symbol.for('tablamigo.tests.networkGuard');

export function installNetworkGuard() {
  const g = globalThis as any;
  if (g[INSTALLED]) return;
  g[INSTALLED] = true;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (isLocalHost(url.hostname)) return realFetch(input, init);
    const fake = FAKES[url.hostname];
    if (fake) return fake(url);
    throw new Error(`tests make no outside requests (tried ${url.hostname}); stub fetch in the test`);
  }) as typeof fetch;

  const connect = net.Socket.prototype.connect as (...args: any[]) => net.Socket;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    let host: string | null = null;
    if (first && typeof first === 'object') host = first.path ? null : String(first.host ?? 'localhost');
    else if (typeof first === 'number' || /^\d+$/.test(String(first))) host = typeof args[1] === 'string' ? args[1] : 'localhost';
    if (host !== null && !isLocalHost(host)) {
      const err = Object.assign(new Error(`tests make no outside connections (tried ${host})`), { code: 'ECONNREFUSED' });
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return connect.apply(this, args);
  } as typeof net.Socket.prototype.connect;
}
