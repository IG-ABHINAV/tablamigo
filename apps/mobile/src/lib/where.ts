// Which place the map, plans, travelers and feed are about when the phone has no location fix. Pure (no React Native), so
// e2e-web/where.test.mjs runs it under node --test.
//
// The app used to fall back to a fixed Bangkok point whenever there was no fix, and said nothing about it: people in Istanbul,
// Sydney or Casablanca who said no to location (or whose browser never answered) saw only Bangkok plans and Bangkok travelers,
// and "Say hi in the city chat" put them in the Bangkok chat. Now the order is: a city the person picked, the phone's fix, the
// last place the server saw them (users.location), then the main city of their home country. With none of those the screens ask
// them to turn on location or pick a city, and nothing is queried.

export type Point = { lat: number; lng: number };
/** Where a screen is looking, and why. Only 'device' and 'saved' are places the person really was. */
export type Here = Point & { source: 'picked' | 'device' | 'saved' | 'country'; city: string | null };

/**
 * The main traveller city of each country we see people from, for someone who shares no location at all. A country that isn't
 * here gets the "turn on location or pick a city" screen instead of a guess.
 */
export const COUNTRY_CITIES: Record<string, { city: string; lat: number; lng: number }> = {
  AE: { city: 'Dubai', lat: 25.2048, lng: 55.2708 }, AM: { city: 'Yerevan', lat: 40.1792, lng: 44.4991 },
  AR: { city: 'Buenos Aires', lat: -34.6037, lng: -58.3816 }, AT: { city: 'Vienna', lat: 48.2082, lng: 16.3738 },
  AU: { city: 'Sydney', lat: -33.8688, lng: 151.2093 }, BD: { city: 'Dhaka', lat: 23.8103, lng: 90.4125 },
  BE: { city: 'Brussels', lat: 50.8503, lng: 4.3517 }, BG: { city: 'Sofia', lat: 42.6977, lng: 23.3219 },
  BR: { city: 'São Paulo', lat: -23.5505, lng: -46.6333 }, CA: { city: 'Toronto', lat: 43.6532, lng: -79.3832 },
  CH: { city: 'Zurich', lat: 47.3769, lng: 8.5417 }, CL: { city: 'Santiago', lat: -33.4489, lng: -70.6693 },
  CN: { city: 'Shanghai', lat: 31.2304, lng: 121.4737 }, CO: { city: 'Bogotá', lat: 4.711, lng: -74.0721 },
  CR: { city: 'San José', lat: 9.9281, lng: -84.0907 }, CY: { city: 'Limassol', lat: 34.7071, lng: 33.0226 },
  CZ: { city: 'Prague', lat: 50.0755, lng: 14.4378 }, DE: { city: 'Berlin', lat: 52.52, lng: 13.405 },
  DK: { city: 'Copenhagen', lat: 55.6761, lng: 12.5683 }, EC: { city: 'Quito', lat: -0.1807, lng: -78.4678 },
  EE: { city: 'Tallinn', lat: 59.437, lng: 24.7536 }, EG: { city: 'Cairo', lat: 30.0444, lng: 31.2357 },
  ES: { city: 'Madrid', lat: 40.4168, lng: -3.7038 }, FI: { city: 'Helsinki', lat: 60.1699, lng: 24.9384 },
  FR: { city: 'Paris', lat: 48.8566, lng: 2.3522 }, GB: { city: 'London', lat: 51.5074, lng: -0.1278 },
  GE: { city: 'Tbilisi', lat: 41.7151, lng: 44.8271 }, GR: { city: 'Athens', lat: 37.9838, lng: 23.7275 },
  HK: { city: 'Hong Kong', lat: 22.3193, lng: 114.1694 }, HR: { city: 'Zagreb', lat: 45.815, lng: 15.9819 },
  HU: { city: 'Budapest', lat: 47.4979, lng: 19.0402 }, ID: { city: 'Jakarta', lat: -6.2088, lng: 106.8456 },
  IE: { city: 'Dublin', lat: 53.3498, lng: -6.2603 }, IL: { city: 'Tel Aviv', lat: 32.0853, lng: 34.7818 },
  IN: { city: 'Delhi', lat: 28.6139, lng: 77.209 }, IS: { city: 'Reykjavik', lat: 64.1466, lng: -21.9426 },
  IT: { city: 'Rome', lat: 41.9028, lng: 12.4964 }, JO: { city: 'Amman', lat: 31.9454, lng: 35.9284 },
  JP: { city: 'Tokyo', lat: 35.6762, lng: 139.6503 }, KE: { city: 'Nairobi', lat: -1.2921, lng: 36.8219 },
  KH: { city: 'Phnom Penh', lat: 11.5564, lng: 104.9282 }, KR: { city: 'Seoul', lat: 37.5665, lng: 126.978 },
  KZ: { city: 'Almaty', lat: 43.222, lng: 76.8512 }, LK: { city: 'Colombo', lat: 6.9271, lng: 79.8612 },
  LT: { city: 'Vilnius', lat: 54.6872, lng: 25.2797 }, LU: { city: 'Luxembourg', lat: 49.6116, lng: 6.1319 },
  LV: { city: 'Riga', lat: 56.9496, lng: 24.1052 }, MA: { city: 'Casablanca', lat: 33.5731, lng: -7.5898 },
  MT: { city: 'Valletta', lat: 35.8989, lng: 14.5146 }, MX: { city: 'Mexico City', lat: 19.4326, lng: -99.1332 },
  MY: { city: 'Kuala Lumpur', lat: 3.139, lng: 101.6869 }, NG: { city: 'Lagos', lat: 6.5244, lng: 3.3792 },
  NL: { city: 'Amsterdam', lat: 52.3676, lng: 4.9041 }, NO: { city: 'Oslo', lat: 59.9139, lng: 10.7522 },
  NP: { city: 'Kathmandu', lat: 27.7172, lng: 85.324 }, NZ: { city: 'Auckland', lat: -36.8485, lng: 174.7633 },
  PE: { city: 'Lima', lat: -12.0464, lng: -77.0428 }, PH: { city: 'Manila', lat: 14.5995, lng: 120.9842 },
  PK: { city: 'Lahore', lat: 31.5204, lng: 74.3587 }, PL: { city: 'Warsaw', lat: 52.2297, lng: 21.0122 },
  PT: { city: 'Lisbon', lat: 38.7223, lng: -9.1393 }, QA: { city: 'Doha', lat: 25.2854, lng: 51.531 },
  RO: { city: 'Bucharest', lat: 44.4268, lng: 26.1025 }, RS: { city: 'Belgrade', lat: 44.7866, lng: 20.4489 },
  SA: { city: 'Riyadh', lat: 24.7136, lng: 46.6753 }, SE: { city: 'Stockholm', lat: 59.3293, lng: 18.0686 },
  SG: { city: 'Singapore', lat: 1.3521, lng: 103.8198 }, SI: { city: 'Ljubljana', lat: 46.0569, lng: 14.5058 },
  SK: { city: 'Bratislava', lat: 48.1486, lng: 17.1077 }, TH: { city: 'Bangkok', lat: 13.7563, lng: 100.5018 },
  TN: { city: 'Tunis', lat: 36.8065, lng: 10.1815 }, TR: { city: 'Istanbul', lat: 41.0082, lng: 28.9784 },
  TW: { city: 'Taipei', lat: 25.033, lng: 121.5654 }, UA: { city: 'Kyiv', lat: 50.4501, lng: 30.5234 },
  US: { city: 'New York', lat: 40.7128, lng: -74.006 }, UY: { city: 'Montevideo', lat: -34.9011, lng: -56.1645 },
  VN: { city: 'Ho Chi Minh City', lat: 10.8231, lng: 106.6297 }, ZA: { city: 'Cape Town', lat: -33.9249, lng: 18.4241 },
};

const real = (p: { lat?: unknown; lng?: unknown } | null | undefined): p is Point =>
  !!p && typeof p.lat === 'number' && typeof p.lng === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng);

/**
 * The place to show, or null when there is none and the screen should ask. `settled` is whether the phone has answered (a fix,
 * a no, or a timeout): until then the home-country guess isn't used, so a slow GPS doesn't flash another city first.
 */
export function pickHere(o: {
  picked?: (Point & { city?: string | null }) | null;
  device?: Point | null; deviceCity?: string | null;
  saved?: { lat?: number | null; lng?: number | null; city?: string | null } | null;
  homeCountry?: string | null;
  settled: boolean;
}): Here | null {
  const { picked, device, saved } = o;
  if (real(picked)) return { lat: picked.lat, lng: picked.lng, source: 'picked', city: o.picked?.city ?? null };
  if (real(device)) return { lat: device.lat, lng: device.lng, source: 'device', city: o.deviceCity ?? null };
  if (real(saved)) return { lat: saved.lat, lng: saved.lng, source: 'saved', city: o.saved?.city ?? null };
  if (!o.settled) return null;
  const c = o.homeCountry ? COUNTRY_CITIES[o.homeCountry.toUpperCase()] : undefined;
  return c ? { lat: c.lat, lng: c.lng, source: 'country', city: c.city } : null;
}

/** "The chat for where you are" (POST /chats/city-here) only makes sense where the person really is, or last was. */
export const isRealPlace = (h: Here | null): boolean => !!h && (h.source === 'device' || h.source === 'saved');
