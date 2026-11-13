/**
 * Calendar arithmetic in a place's own time zone. "Every Tuesday at 19:00" means 19:00 on the wall clock of the city the plan
 * is in, so the next one is found by moving the calendar date and keeping the clock time, not by adding 7 x 24 hours (which
 * lands an hour off when the clocks change in between). Built on Intl, so it needs no time zone data of its own.
 */
import tzlookup from '@photostructure/tz-lookup';

const DAY = 86_400_000;

const validZone = (z: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; } };

/** IANA time zone of a point (a plan's meeting place); 'UTC' when there is no point or no zone for it. */
export function zoneAt(lat: number | null | undefined, lng: number | null | undefined): string {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return 'UTC';
  try { const z = tzlookup(lat, lng); return validZone(z) ? z : 'UTC'; } catch { return 'UTC'; }
}

export type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number };

const formats = new Map<string, Intl.DateTimeFormat>();
const formatter = (zone: string) => {
  let f = formats.get(zone);
  if (!f) formats.set(zone, f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
  return f;
};

/** What a clock in `zone` shows at the instant `ms`. */
export function wallClock(ms: number, zone: string): Wall {
  const p = Object.fromEntries(formatter(zone).formatToParts(ms).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

/** The wall time as if it were UTC, so wall times can be compared and subtracted. */
const asUtc = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
/** The zone's offset from UTC at an instant, in ms (whole seconds). */
const offsetAt = (ms: number, zone: string) => asUtc(wallClock(ms, zone)) - Math.floor(ms / 1000) * 1000;

/**
 * The instant at which a clock in `zone` shows the wall time `w`. A time that does not exist (the clocks jumped forward over
 * it) is read with the offset from before the jump, so it lands after it (02:30 becomes 03:30); a time that happens twice
 * (the clocks went back) is the first of the two.
 */
export function instantAt(zone: string, w: Wall): number {
  const wall = asUtc(w);
  const before = offsetAt(wall - DAY, zone), after = offsetAt(wall + DAY, zone);
  const valid = [...new Set([wall - before, wall - after])].filter(t => t + offsetAt(t, zone) === wall).sort((a, b) => a - b);
  return valid.length ? valid[0] : wall - before;
}

export const daysInMonth = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

/**
 * The same wall-clock time `days` days or `months` months later in `zone`. Months keep the day of the month, or `dayOfMonth`
 * when given (a series anchored on the 31st stays on the last day of shorter months and goes back to the 31st after them);
 * `time` pins the clock time (a series anchored on 02:30 stays on 02:30 after a night where 02:30 did not exist).
 */
export function addLocal(at: Date, zone: string, by: { days?: number; months?: number; dayOfMonth?: number; time?: Pick<Wall, 'h' | 'mi' | 's'> }): Date {
  const w = wallClock(at.getTime(), zone);
  const ms = ((at.getTime() % 1000) + 1000) % 1000;
  let { y, mo, d } = w;
  if (by.months) {
    const m0 = mo - 1 + by.months;
    y += Math.floor(m0 / 12);
    mo = ((m0 % 12) + 12) % 12 + 1;
    d = Math.min(by.dayOfMonth ?? d, daysInMonth(y, mo));
  }
  if (by.days) {
    const x = new Date(Date.UTC(y, mo - 1, d + by.days));
    y = x.getUTCFullYear(); mo = x.getUTCMonth() + 1; d = x.getUTCDate();
  }
  const t = by.time ?? w;
  return new Date(instantAt(zone, { y, mo, d, h: t.h, mi: t.mi, s: t.s }) + ms);
}

/** YYYY-MM-DD of an instant on the wall calendar of `zone`. */
export function localDate(at: Date, zone: string): string {
  const w = wallClock(at.getTime(), zone);
  return `${String(w.y).padStart(4, '0')}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}
