/**
 * The new-plan screen opened from a template link (the team's empty-city nudge, apps/api/src/lib/city-nudge.ts):
 * `date=YYYY-MM-DD` offers that day's times first, `near=lat,lng` searches places around the trip's city instead of where
 * the phone is. Pure, so it is unit-tested.
 */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** The plan API takes plans up to 30 days ahead. */
export const MAX_DAYS_AHEAD = 30;

/** 10 AM, 1 PM, 5 PM and 7 PM on `date` (device time), the ones still ahead of `now`; [] for a bad, past or too-far date. */
export function slotsForDay(date: string | undefined, now = new Date()): { label: string; d: Date }[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  if (!m) return [];
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const day = new Date(y, mo - 1, d);
  if (day.getFullYear() !== y || day.getMonth() !== mo - 1 || day.getDate() !== d) return [];
  if (day.getTime() - now.getTime() > MAX_DAYS_AHEAD * 86400_000) return [];
  const label = `${DOW[day.getDay()]} ${d} ${MON[mo - 1]}`;
  return [[10, '10 AM'], [13, '1 PM'], [17, '5 PM'], [19, '7 PM']]
    .map(([h, l]) => ({ label: `${label} ${l}`, d: new Date(y, mo - 1, d, h as number, 0, 0, 0) }))
    .filter(s => s.d.getTime() > now.getTime() + 30 * 60_000);
}

/** "lat,lng" from a link, or null. */
export function parseNear(s: string | undefined): { lat: number; lng: number } | null {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(s ?? '');
  if (!m) return null;
  const lat = +m[1], lng = +m[2];
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}
