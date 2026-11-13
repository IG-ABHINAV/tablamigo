/**
 * The popular travel cities that have a canonical city chat (scripts/seed-founder-city-chats.ts CITIES), as points: "the chat
 * where you are" (POST /chats/city-here) snaps to one of them when the person is within SNAP_KM of it, so a district name
 * Nominatim gives for a point inside a big city ('Üsküdar' in Istanbul) doesn't open a one-person 'Üsküdar travelers' chat next
 * to the real Istanbul one.
 */
import { CITIES } from '../scripts/seed-founder-city-chats.js';

export const SNAP_KM = 40;

const km = (a: number, b: number, c: number, d: number) => {
  const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
};

/** The curated city whose nearest listed point is within SNAP_KM of (lat, lng) and in `country`, nearest first; else null. */
export function curatedCityNear(lat: number, lng: number, country: string): { city: string; key: string } | null {
  let best: { city: string; key: string; d: number } | null = null;
  const cc = `-${country.toLowerCase()}`;
  for (const c of CITIES) {
    if (!c.key.endsWith(cc)) continue;
    for (const p of c.points) {
      const d = km(lat, lng, p.lat, p.lng);
      if (d <= SNAP_KM && (!best || d < best.d)) best = { city: c.city, key: c.key, d };
    }
  }
  return best ? { city: best.city, key: best.key } : null;
}
