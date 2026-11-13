// The next session of a recurring plan is found on the wall clock of the place the plan meets at (lib/plan-jobs.ts,
// lib/local-time.ts), not by adding 7 x 24 hours: "Saturdays at 19:00" stays 19:00 when the clocks change in between.
// Every call passes `now`, so nothing here depends on the day the tests run. The plans have auto_advance off, so the
// batch runners other test files call can't pick them up.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const { sql } = await import('./lib/db.js');
const { generateNextOccurrence } = await import('./lib/plan-jobs.js');

const D = '@recdst.tablamigo';
const PLACES = {
  berlin: { lat: 52.52, lng: 13.405 }, newYork: { lat: 40.71, lng: -74.0 }, sydney: { lat: -33.87, lng: 151.2 },
  kolkata: { lat: 22.57, lng: 88.36 }, bangkok: { lat: 13.75, lng: 100.5 }, london: { lat: 51.51, lng: -0.13 },
};
let hostId = '';

beforeAll(async () => {
  await sql`delete from users where email like ${'%' + D}`;
  hostId = (await sql`insert into users (email, name) values (${'host' + D}, 'Host') returning id`)[0].id;
});
afterAll(async () => {
  await sql`delete from users where email like ${'%' + D}`;
  await sql.end();
});

/** A recurring plan at `place`, first session at `startsAt`. Returns its id. */
async function series(place: keyof typeof PLACES, startsAt: string, recurrence: 'weekly' | 'biweekly' | 'monthly') {
  const { lat, lng } = PLACES[place];
  const [a] = await sql`insert into activities (host_id, title, emoji, category, place_name, location, city, starts_at, recurrence, occurrence_number, auto_advance)
    values (${hostId}, ${`${recurrence} ${place}`}, '🔁', 'culture', 'Meeting point', ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${place}, ${startsAt}, ${recurrence}, 1, false) returning id`;
  await sql`update activities set series_id = ${a.id} where id = ${a.id}`;
  await sql`insert into chats (kind, activity_id, title) values ('activity', ${a.id}, 'plan')`;
  return a.id as string;
}
/** Creates the next session as of one hour before `startsAt`'s session, like the scheduler would. */
const advance = async (id: string, now?: string) => {
  const [cur] = await sql`select starts_at from activities where id = ${id}`;
  const r = await generateNextOccurrence(id, new Date(now ?? new Date(cur.startsAt).getTime() - 3600_000));
  expect(r.ok).toBe(true);
  return { ...r, startsAtIso: new Date(r.startsAt as Date).toISOString() };
};

describe('recurring plans keep their local time across clock changes', () => {
  it('exploit: a Saturday 19:00 plan in Berlin stays 19:00 after the clocks go back (it moved to 18:00)', async () => {
    const id = await series('berlin', '2026-10-24T17:00:00Z', 'weekly');         // 19:00 CEST; the clocks go back on Sunday 25 Oct
    const next = await advance(id);
    expect(next.startsAtIso).toBe('2026-10-31T18:00:00.000Z');                    // 19:00 CET. +7 x 24 h would have given 17:00Z = 18:00 in Berlin
    expect(next.occurrenceNumber).toBe(2);
    // The new session is a plan of its own with the same details, in the same series.
    const [row] = await sql`select host_id, title, series_id, parent_activity_id, recurrence, auto_advance, status from activities where id = ${next.nextActivityId}`;
    expect(row).toMatchObject({ hostId, title: 'weekly berlin', seriesId: id, parentActivityId: id, recurrence: 'weekly', autoAdvance: true, status: 'active' });
  });

  it('biweekly in Berlin, weekly in New York (spring forward) and Sydney (daylight saving starts)', async () => {
    expect((await advance(await series('berlin', '2026-10-17T17:00:00Z', 'biweekly'))).startsAtIso).toBe('2026-10-31T18:00:00.000Z');
    expect((await advance(await series('newYork', '2027-03-14T00:00:00Z', 'weekly'))).startsAtIso).toBe('2027-03-20T23:00:00.000Z');    // Sat 19:00 EST -> Sat 19:00 EDT
    expect((await advance(await series('sydney', '2026-10-03T09:00:00Z', 'weekly'))).startsAtIso).toBe('2026-10-10T08:00:00.000Z');     // Sat 19:00 AEST -> AEDT
  });

  it('zones without daylight saving move by exactly a week', async () => {
    expect((await advance(await series('kolkata', '2026-10-24T13:30:00Z', 'weekly'))).startsAtIso).toBe('2026-10-31T13:30:00.000Z');
    expect((await advance(await series('bangkok', '2026-10-24T12:00:00Z', 'biweekly'))).startsAtIso).toBe('2026-11-07T12:00:00.000Z');
  });

  it('a series nobody advanced catches up to the first session that is not in the past, on the right clock time', async () => {
    const id = await series('berlin', '2026-10-03T17:00:00Z', 'weekly');         // Sat 19:00 CEST, three weeks before "now"
    const next = await advance(id, '2026-10-26T09:00:00Z');
    expect(next.startsAtIso).toBe('2026-10-31T18:00:00.000Z');                    // not 10, 17 or 24 Oct; 19:00 CET
    expect(next.occurrenceNumber).toBe(2);
  });

  it('a monthly plan keeps its day of the month, goes to the last day of a shorter month and back, and keeps 12:00 London time', async () => {
    const id = await series('london', '2026-01-31T12:00:00Z', 'monthly');
    const feb = await advance(id);
    expect(feb.startsAtIso).toBe('2026-02-28T12:00:00.000Z');                     // it used to roll over into 3 March
    const mar = await advance(feb.nextActivityId as string);
    expect(mar.startsAtIso).toBe('2026-03-31T11:00:00.000Z');                     // back on the 31st; BST began on 29 March, 12:00 local is 11:00Z
    const apr = await advance(mar.nextActivityId as string);
    expect(apr.startsAtIso).toBe('2026-04-30T11:00:00.000Z');
    expect([feb.occurrenceNumber, mar.occurrenceNumber, apr.occurrenceNumber]).toEqual([2, 3, 4]);
    expect((await sql`select series_id from activities where id = ${apr.nextActivityId}`)[0].seriesId).toBe(id);
  });

  it('a session at a time that does not exist one night (02:30, the clocks jump to 03:00) is moved that night only', async () => {
    const id = await series('berlin', '2026-03-22T01:30:00Z', 'weekly');         // Sun 02:30 CET
    const jump = await advance(id);
    expect(jump.startsAtIso).toBe('2026-03-29T01:30:00.000Z');                    // 03:30 CEST: 02:30 did not exist that night
    const after = await advance(jump.nextActivityId as string);
    expect(after.startsAtIso).toBe('2026-04-05T00:30:00.000Z');                   // 02:30 CEST again, the first session's clock time
  });

  it('the chat announces the date where the plan is, not the UTC date', async () => {
    const id = await series('kolkata', '2026-10-31T20:00:00Z', 'weekly');        // Sun 1 Nov 01:30 in Kolkata
    const next = await advance(id);
    expect(next.startsAtIso).toBe('2026-11-07T20:00:00.000Z');                    // Sun 8 Nov 01:30 IST
    const [msg] = await sql`select body from messages m join chats c on c.id = m.chat_id where c.activity_id = ${id} and m.kind = 'system'`;
    expect(msg.body).toBe('Next session (#2) has been scheduled for 2026-11-08!');
  });

  it('is idempotent: a plan that already has a next session returns it and creates nothing', async () => {
    const id = await series('berlin', '2026-11-07T18:00:00Z', 'weekly');
    const first = await advance(id);
    const again = await generateNextOccurrence(id, new Date('2026-11-07T17:00:00Z'));
    expect(again).toMatchObject({ ok: true, alreadyGenerated: true, nextActivityId: first.nextActivityId, occurrenceNumber: 2 });
    expect((await sql`select count(*)::int as n from activities where series_id = ${id}`)[0].n).toBe(2);
  });
});
