/**
 * The live counts on Explore (components/LiveCity.tsx), from the API's public GET /public/social-proof (apps/api/src/lib/
 * social-proof.ts). The API leaves out every city with fewer than 10 upcoming trips from real travellers, so a city that isn't
 * in the answer shows nothing at all; this file only finds the person's city in it.
 */
export type CityCount = { cityKey: string; city: string; countryCode: string; upcomingTrips: number; plansThisWeek: number };
export type SocialProof = { minTrips: number; cities: CityCount[]; trending: { cityKey: string; city: string; countryCode: string; travellers: number }[] };

const norm = (s: string | null | undefined) => (s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').trim().toLowerCase();

/** The person's city in the answer (by name, accents and case aside), or null: then nothing renders. */
export function liveCity(p: SocialProof | null | undefined, city: string | null | undefined): CityCount | null {
  const n = norm(city);
  if (!n || !p?.cities?.length) return null;
  return p.cities.find(c => norm(c.city) === n && c.upcomingTrips >= (p.minTrips ?? 10)) ?? null;
}

/** "12 upcoming trips · 4 plans this week" (a zero is left out rather than shown). */
export function liveLine(c: CityCount): string {
  const parts = [`${c.upcomingTrips} upcoming ${c.upcomingTrips === 1 ? 'trip' : 'trips'}`];
  if (c.plansThisWeek > 0) parts.push(`${c.plansThisWeek} ${c.plansThisWeek === 1 ? 'plan' : 'plans'} this week`);
  return parts.join(' · ');
}
