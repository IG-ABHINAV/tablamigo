import { sql } from './db.js';

type Place = { city: string | null; country: string | null };
const cell = (lat: number, lng: number) => `${Math.round(lat * 20) / 20},${Math.round(lng * 20) / 20}`; // 0.05° ≈ 5 km

/**
 * A cell cached before this moment was named by the old rules (zoom 10, county last resort, no clean-up: 'Challakere taluku',
 * 'Málaga-Costa del Sol'), so it is looked up again instead of being served for up to 30 more days.
 */
const NAMED_SINCE = '2026-10-22T00:00:00Z';

/** City for a point: cached per grid cell for 30 days; a miss asks Nominatim. Failures (no city and no country) aren't cached. */
export async function cityFor(lat: number, lng: number): Promise<Place> {
  const key = cell(lat, lng);
  const [hit] = await sql`select city, country from geo_cache where cell = ${key}
    and cached_at > greatest(now() - interval '30 days', ${NAMED_SINCE}::timestamptz)`.catch(() => []);
  if (hit) return { city: cleanPlaceName(hit.city), country: hit.country };
  const p = await nominatim(lat, lng);
  // A country with no city (open sea, desert, a rural cell) is worth keeping: SOS only needs the country.
  if (p.city || p.country) await sql`insert into geo_cache (cell, city, country) values (${key}, ${p.city}, ${p.country})
    on conflict (cell) do update set city = excluded.city, country = excluded.country, cached_at = now()`.catch(() => {});
  return p;
}

/**
 * Country for a point from the cache alone, for answers that can't wait on Nominatim (SOS, the safety page). Creating
 * a plan already looked its point up, so a plan's cell is normally there; a cell's country doesn't change, so an entry
 * of any age counts. A miss returns null (callers show the 112 set) and fills the cache in the background.
 */
export async function cachedCountry(lat: number, lng: number): Promise<string | null> {
  const [hit] = await sql`select country from geo_cache where cell = ${cell(lat, lng)}`.catch(() => []);
  if (hit) return hit.country ?? null;
  void cityFor(lat, lng).catch(() => {});
  return null;
}

/** City and country for a point from the cache alone: no lookup, no background fill. Null on a miss. */
export async function cachedPlace(lat: number, lng: number): Promise<Place | null> {
  const [hit] = await sql`select city, country from geo_cache where cell = ${cell(lat, lng)}`.catch(() => []);
  return hit ? { city: cleanPlaceName(hit.city ?? null), country: hit.country ?? null } : null;
}

/**
 * The city to store on a new plan. A plan's city used to be whatever one Nominatim call (4 s timeout) said, so a slow or failed
 * lookup saved it as NULL (plan a36ccdd7 at La Pepica, Valencia). Now: that lookup, else the cell's cached name of any age,
 * else the host's own city when the host is within 40 km of the plan, else null, and fillPlanCityLater tries again.
 */
export async function cityForPlan(lat: number, lng: number, hostId: string): Promise<string | null> {
  const fresh = await cityFor(lat, lng);
  if (fresh.city) return fresh.city;
  const cached = await cachedPlace(lat, lng);
  if (cached?.city) return cached.city;
  const [h] = await sql`select city from users where id = ${hostId} and city is not null and location is not null
    and ST_DWithin(location, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, 40000)`.catch(() => []);
  return (h?.city as string | undefined) ?? null;
}

/** A plan saved without a city: one more lookup after `delayMs`, written only if the plan still has none. Never throws. */
export function fillPlanCityLater(activityId: string, lat: number, lng: number, delayMs = 60_000): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(async () => {
      try {
        const p = await cityFor(lat, lng);
        if (p.city) await sql`update activities set city = ${p.city} where id = ${activityId} and city is null`;
      } catch { /* the next plan in that cell will try again */ }
      resolve();
    }, delayMs);
    t.unref?.();
  });
}

/**
 * A place name without the administrative wrapping Nominatim gives some areas: 'Challakere taluku', 'Ganganagar Tehsil',
 * 'Macharla Mandal', 'Jaipur Municipal Corporation', 'City of Edinburgh', 'City of Tshwane Metropolitan Municipality' were
 * shown on profiles, in the Host's welcome ("Challakere taluku mein…") and sent to the AI as the city. US counties ('Clark
 * County') are kept as they are: 'Clark' alone would name nothing.
 */
export function cleanPlaceName(name: string | null): string | null {
  if (!name) return name;
  const out = name.trim()
    .replace(/^city of\s+/i, '')
    .replace(/\s+(metropolitan|local|district)?\s*municipality$/i, '')
    .replace(/\s+municipal corporation$/i, '')
    .replace(/\s+(taluku|taluka|taluk|tehsil|tahsil|tahasil|mandal|sub-?division|district)$/i, '')
    .trim();
  return out || name.trim();
}

/**
 * The city in a Nominatim address: the city, town, village or municipality the point is in, cleaned up (cleanPlaceName); the
 * county only when there is nothing else. Exported for the test, which uses real answers.
 */
export function placeName(a: Record<string, string | undefined>): string | null {
  return cleanPlaceName(a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? null);
}

/**
 * Reverse-geocode with OpenStreetMap Nominatim (free, needs a UA + light use). Zoom 12 (town level): at zoom 10 a town that
 * OSM maps as a point (Challakere, Kumta, Jagraon, Macherla) is missing and only its taluk/tehsil comes back; at 14 a point at
 * a town's edge comes back as the next village. Checked against Nominatim for those towns on 22 Oct 2026.
 */
async function nominatim(lat: number, lng: number): Promise<Place> {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=12&accept-language=en&lat=${lat}&lon=${lng}`, {
      headers: { 'User-Agent': 'Tablamigo/1.0 (hello@hookstep.in)' }, signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return { city: null, country: null };
    const j: any = await r.json();
    const a = j.address ?? {};
    return { city: placeName(a), country: (a.country_code ?? '').toUpperCase() || null };
  } catch { return { city: null, country: null }; }
}
// The accents NFKD splits off a letter (combining diacritical marks), and the letters that have no plain form under NFKD.
// Migration 061 builds the same key in SQL with the same ranges and letters.
const MARKS = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g;
const PLAIN: Record<string, string> = { 'đ': 'd', 'ð': 'd', 'ø': 'o', 'ł': 'l', 'ı': 'i', 'þ': 'th', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss' };

/**
 * A city's key ('bangkok-th', 'medellin-co', 'uskudar-tr'): the name in plain lowercase letters and digits, words joined by
 * dashes, then the country. Accents are dropped, not turned into dashes: before 22 Oct 2026 'Medellín' gave 'medelli-n-co' and
 * 'Üsküdar' 'u-sku-dar-tr' (legacyCityKey), so a trip typed with the accent and one without never met.
 */
export const cityKey = (city: string, country: string) =>
  `${city.toLowerCase().normalize('NFKD').replace(MARKS, '').replace(/[đðøłıþæœß]/g, c => PLAIN[c]).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${country.toLowerCase()}`;

/** The key the old rule gave (accents became dashes). Chats and hand-made aliases made under it are still found by it. */
export const legacyCityKey = (city: string, country: string) =>
  `${city.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${country.toLowerCase()}`;

const km = (a: number, b: number, c: number, d: number) => {
  const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
};

/**
 * Coordinates for a named place near a point, from Photon (OpenStreetMap search, the same one the app's place
 * search uses). Null when nothing by that name is within `maxKm`, or the lookup fails: never a guessed point.
 */
export async function placeNear(name: string, lat: number, lng: number, maxKm = 25): Promise<{ lat: number; lng: number } | null> {
  try {
    const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(name)}&lat=${lat}&lon=${lng}&limit=3&lang=en`, {
      headers: { 'User-Agent': 'Tablamigo/1.0 (hello@hookstep.in)' }, signal: AbortSignal.timeout(3500),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    for (const f of j.features ?? []) {
      const [x, y] = f?.geometry?.coordinates ?? [];
      if (typeof x === 'number' && typeof y === 'number' && km(lat, lng, y, x) <= maxKm) return { lat: y, lng: x };
    }
    return null;
  } catch { return null; }
}

export type PlaceHit = { name: string; city: string | null; country: string | null; lat: number; lng: number; detail: string | null };

/**
 * Candidate places for a typed name from Photon (the same OpenStreetMap search the app's place search uses), for the admin
 * "Create plan as Tablamigo team" form. Real results only, in Photon's order; empty when the lookup fails.
 */
export async function searchPlaces(q: string, near?: { lat: number; lng: number } | null, limit = 6): Promise<PlaceHit[]> {
  try {
    const bias = near ? `&lat=${near.lat}&lon=${near.lng}` : '';
    const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}${bias}&limit=${limit}&lang=en`, {
      headers: { 'User-Agent': 'Tablamigo/1.0 (hello@hookstep.in)' }, signal: AbortSignal.timeout(4500),
    });
    if (!r.ok) return [];
    const j: any = await r.json();
    const out: PlaceHit[] = [];
    for (const f of j.features ?? []) {
      const [x, y] = f?.geometry?.coordinates ?? [];
      const p = f?.properties ?? {};
      if (typeof x !== 'number' || typeof y !== 'number' || !p.name) continue;
      out.push({ name: String(p.name), city: cleanPlaceName(p.city ?? p.district ?? p.county ?? null), country: p.countrycode ? String(p.countrycode).toUpperCase() : null,
        lat: y, lng: x, detail: [p.street, p.district, p.state].filter(Boolean).join(', ') || null });
    }
    return out;
  } catch { return []; }
}
