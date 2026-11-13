// Calendar arithmetic in a place's own time zone (lib/local-time.ts): what recurring plans use to find their next session.
// Pure functions, no database. Written so they hold whatever time zone the machine running them is in.
import { describe, it, expect } from 'vitest';
import { addLocal, daysInMonth, instantAt, localDate, wallClock, zoneAt } from './lib/local-time.js';

const iso = (d: Date) => d.toISOString();
const at = (s: string) => new Date(s);
const hm = (d: Date, zone: string) => { const w = wallClock(d.getTime(), zone); return `${String(w.h).padStart(2, '0')}:${String(w.mi).padStart(2, '0')}`; };

describe('addLocal: the same wall-clock time, a number of days later', () => {
  it('exploit: a weekly plan keeps its local time across the end of daylight saving (adding 7 x 24 hours moved it an hour)', () => {
    const start = at('2026-10-24T17:00:00Z');                 // Saturday 19:00 in Berlin (CEST); the clocks go back on Sunday 25 Oct
    expect(iso(new Date(start.getTime() + 7 * 86400_000))).toBe('2026-10-31T17:00:00.000Z');    // the old arithmetic: 18:00 in Berlin
    expect(iso(addLocal(start, 'Europe/Berlin', { days: 7 }))).toBe('2026-10-31T18:00:00.000Z'); // 19:00 CET
    expect(hm(addLocal(start, 'Europe/Berlin', { days: 7 }), 'Europe/Berlin')).toBe('19:00');
  });

  it('spring forward (New York), a southern-hemisphere zone (Sydney) and a half-hour shift (Lord Howe)', () => {
    expect(iso(addLocal(at('2027-03-13T19:00:00-05:00'), 'America/New_York', { days: 7 }))).toBe('2027-03-20T23:00:00.000Z');   // 19:00 EDT
    expect(iso(addLocal(at('2026-10-03T19:00:00+10:00'), 'Australia/Sydney', { days: 7 }))).toBe('2026-10-10T08:00:00.000Z');  // 19:00 AEDT
    expect(iso(addLocal(at('2026-04-04T19:00:00+11:00'), 'Australia/Lord_Howe', { days: 7 }))).toBe('2026-04-11T08:30:00.000Z');
  });

  it('zones without daylight saving move by exactly 7 x 24 hours', () => {
    for (const zone of ['Asia/Kolkata', 'Asia/Bangkok', 'UTC', 'Asia/Kathmandu']) {
      const start = at('2026-10-24T17:15:00Z');
      expect(iso(addLocal(start, zone, { days: 7 })), zone).toBe(iso(new Date(start.getTime() + 7 * 86400_000)));
    }
  });

  it('keeps the clock time for a year of weekly sessions in zones that change their clocks in very different ways', () => {
    for (const zone of ['Europe/Berlin', 'America/New_York', 'Australia/Sydney', 'Australia/Lord_Howe', 'America/St_Johns', 'Pacific/Auckland', 'Africa/Casablanca', 'America/Sao_Paulo', 'Asia/Tehran']) {
      let t = new Date(instantAt(zone, { y: 2026, mo: 1, d: 3, h: 19, mi: 0, s: 0 }));
      expect(hm(t, zone), zone).toBe('19:00');
      for (let week = 1; week <= 110; week++) {
        const next = addLocal(t, zone, { days: 7 });
        const a = wallClock(t.getTime(), zone), b = wallClock(next.getTime(), zone);
        expect(hm(next, zone), `${zone} week ${week}`).toBe('19:00');
        expect((Date.UTC(b.y, b.mo - 1, b.d) - Date.UTC(a.y, a.mo - 1, a.d)) / 86400_000, `${zone} week ${week}`).toBe(7);
        t = next;
      }
    }
  });

  it('a time that does not exist (the clocks jumped over it) lands after the jump; one that happens twice is the first', () => {
    // Berlin, Sunday 29 Mar 2026: 02:00 -> 03:00, so 02:30 does not exist. Sunday 25 Oct: 03:00 -> 02:00, so 02:30 happens twice.
    expect(iso(addLocal(at('2026-03-22T02:30:00+01:00'), 'Europe/Berlin', { days: 7 }))).toBe('2026-03-29T01:30:00.000Z');   // 03:30 CEST
    expect(iso(addLocal(at('2026-10-18T02:30:00+02:00'), 'Europe/Berlin', { days: 7 }))).toBe('2026-10-25T00:30:00.000Z');   // the first 02:30 (CEST)
    // A series anchored on 02:30 goes back to 02:30 the week after the night it was moved.
    expect(iso(addLocal(at('2026-03-29T01:30:00Z'), 'Europe/Berlin', { days: 7, time: { h: 2, mi: 30, s: 0 } }))).toBe('2026-04-05T00:30:00.000Z');
  });

  it('keeps milliseconds and works from any instant of the day, including midnight', () => {
    expect(iso(addLocal(at('2026-10-24T22:00:00.123Z'), 'Europe/Berlin', { days: 1 }))).toBe('2026-10-25T23:00:00.123Z');   // 00:00:00.123 CEST on the 25th -> 00:00:00.123 CET on the 26th
    const midnight = addLocal(at('2026-10-23T22:00:00Z'), 'Europe/Berlin', { days: 2 });   // 00:00 CEST on 24 Oct + 2 days = 00:00 CET on 26 Oct
    expect(iso(midnight)).toBe('2026-10-25T23:00:00.000Z');
    expect(hm(midnight, 'Europe/Berlin')).toBe('00:00');
  });
});

describe('addLocal: months', () => {
  it('keeps the day of the month, and the last day of a shorter month', () => {
    expect(iso(addLocal(at('2026-12-15T12:00:00Z'), 'UTC', { months: 1 }))).toBe('2027-01-15T12:00:00.000Z');
    expect(iso(addLocal(at('2026-01-31T12:00:00Z'), 'UTC', { months: 1 }))).toBe('2026-02-28T12:00:00.000Z');   // it used to roll over into March
    expect(iso(addLocal(at('2028-01-31T12:00:00Z'), 'UTC', { months: 1 }))).toBe('2028-02-29T12:00:00.000Z');
    expect(iso(addLocal(at('2026-03-31T12:00:00Z'), 'UTC', { months: 1 }))).toBe('2026-04-30T12:00:00.000Z');
  });

  it('a series anchored on the 31st returns to the 31st after a short month', () => {
    expect(iso(addLocal(at('2026-02-28T12:00:00Z'), 'UTC', { months: 1, dayOfMonth: 31 }))).toBe('2026-03-31T12:00:00.000Z');
    expect(iso(addLocal(at('2026-04-30T12:00:00Z'), 'UTC', { months: 1, dayOfMonth: 31 }))).toBe('2026-05-31T12:00:00.000Z');
  });

  it('keeps the local clock time across a clock change in between', () => {
    // 19:00 on Sat 24 Oct in Berlin (CEST), one month on is 19:00 on Tue 24 Nov (CET).
    expect(iso(addLocal(at('2026-10-24T17:00:00Z'), 'Europe/Berlin', { months: 1 }))).toBe('2026-11-24T18:00:00.000Z');
  });
});

describe('zoneAt, localDate, daysInMonth', () => {
  it('finds the zone of a place, and falls back to UTC when it cannot', () => {
    expect(zoneAt(52.52, 13.405)).toBe('Europe/Berlin');
    expect(zoneAt(19.07, 72.87)).toBe('Asia/Kolkata');
    expect(zoneAt(40.71, -74.0)).toBe('America/New_York');
    expect(zoneAt(-33.87, 151.2)).toBe('Australia/Sydney');
    for (const [lat, lng] of [[null, null], [undefined, 5], [5, undefined], [1000, 5], [5, 1000], [NaN, 5]] as const) expect(zoneAt(lat, lng), `${lat},${lng}`).toBe('UTC');
  });

  it('reads the calendar date where the plan is, not in UTC', () => {
    expect(localDate(at('2026-10-31T22:30:00Z'), 'Asia/Kolkata')).toBe('2026-11-01');
    expect(localDate(at('2026-10-31T22:30:00Z'), 'America/Los_Angeles')).toBe('2026-10-31');
    expect(localDate(at('2026-10-31T22:30:00Z'), 'UTC')).toBe('2026-10-31');
  });

  it('knows the length of every month, leap years included', () => {
    expect([1, 2, 3, 4, 12].map(m => daysInMonth(2026, m))).toEqual([31, 28, 31, 30, 31]);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
  });
});
