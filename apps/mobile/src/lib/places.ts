// City search with Photon (OpenStreetMap), shared by "pick a city" (app/pick-city.tsx) and a new trip (app/trip/new.tsx).
// Pure, so e2e-web/places.test.mjs runs it under node --test.

export type City = { city: string; cc: string; country: string; region?: string; lat?: number; lng?: number };

/**
 * The search URL. `near` nudges places close to the person up (Photon's location bias). A trip to Agra from India was saved
 * as Agra, United States: Photon ranks Agra, India first even without a point (checked 22 Oct 2026), so the second row was
 * most likely tapped, two 'Agra' rows that differed only in a small country line. Hence the bias and cityWhere() in each row.
 */
export function cityQueryUrl(q: string, near?: { lat: number; lng: number } | null, limit = 8) {
  const bias = near && Number.isFinite(near.lat) && Number.isFinite(near.lng) ? `&lat=${near.lat}&lon=${near.lng}` : '';
  return `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${limit}&lang=en&osm_tag=place:city&osm_tag=place:town${bias}`;
}

/**
 * Photon's answer as cities, in Photon's order (importance, nudged by `near`), without duplicates. Not reordered by the
 * person's home country: an American typing Paris means Paris, France, which Photon already ranks above Paris, Texas. Every
 * result keeps its region and country, so two places with one name read differently in the list.
 */
export function parseCities(json: any): City[] {
  const seen = new Set<string>();
  const out: City[] = [];
  for (const f of json?.features ?? []) {
    const p = f?.properties ?? {};
    const [lng, lat] = f?.geometry?.coordinates ?? [];
    if (!p.countrycode || !p.name) continue;
    const c: City = { city: String(p.name), cc: String(p.countrycode).toUpperCase(), country: String(p.country ?? ''), region: p.state ? String(p.state) : undefined,
      lat: typeof lat === 'number' ? lat : undefined, lng: typeof lng === 'number' ? lng : undefined };
    const key = `${c.city.toLowerCase()}|${c.cc}|${c.region ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(c);
  }
  return out;
}

/** "Uttar Pradesh, India": what tells two cities with one name apart in a list. */
export const cityWhere = (c: City) => [c.region && c.region !== c.city ? c.region : null, c.country || c.cc].filter(Boolean).join(', ');
