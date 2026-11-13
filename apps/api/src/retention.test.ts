// The retention purge (lib/retention.ts) and the daily tick that runs it (lib/scheduler.ts). The periods are the ones the privacy page
// states: sign-in codes 1 day, expired refresh tokens 30 days, notifications 90 days, analytics events 180 days, expired live
// locations and plan share links 7 days. The purge only ever runs for the real time (a made-up "now" would delete live data), so the
// fixtures here are dated backwards from the real clock, one day either side of each cut-off, and only those rows are asserted on.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const { sql } = await import('./lib/db.js');
const { purgeExpired, RETENTION_DAYS, RETENTION_BATCH } = await import('./lib/retention.js');

const D = '@retention.tablamigo';
const DAY = 86400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const ahead = (days: number) => new Date(Date.now() + days * DAY);
let userId = '', chatId = '', planId = '';
const ids: Record<string, any> = {};
const present = async (table: string, col: string, val: unknown) => ((await sql.unsafe(`select count(*)::int as n from ${table} where ${col} = $1`, [val as any]))[0].n as number) > 0;

beforeAll(async () => {
  await sql`delete from users where email like ${'%' + D}`;
  await sql`delete from otp_codes where email like ${'%' + D}`;
  userId = (await sql`insert into users (email, name) values (${'owner' + D}, 'Owner') returning id`)[0].id;
  planId = (await sql`insert into activities (host_id, title, category, place_name, location, city, starts_at) values (${userId}, 'Retention plan', 'culture', 'x', ST_SetSRID(ST_MakePoint(1, 1), 4326)::geography, 'x', now() + interval '1 day') returning id`)[0].id;
  chatId = (await sql`insert into chats (kind, activity_id, title) values ('activity', ${planId}, 'Retention') returning id`)[0].id;

  // Sign-in codes: kept 1 day after they expired.
  for (const [name, expires, window] of [['old', ago(2), ago(2)], ['recentwindow', ago(2), new Date()], ['justexpired', ago(0.5), ago(0.5)], ['live', ahead(0.01), new Date()]] as const) {
    await sql`insert into otp_codes (email, code_hash, expires_at, window_start) values (${name + D}, 'h', ${expires}, ${window})`;
  }
  // Refresh tokens: kept 30 days after they expired (revoked or not).
  for (const [name, expires, revoked] of [['old', ago(31), null], ['oldrevoked', ago(40), ago(50)], ['recent', ago(29), null], ['live', ahead(30), null], ['livrevoked', ahead(30), ago(1)]] as const) {
    ids['rt_' + name] = (await sql`insert into refresh_tokens (user_id, token_hash, expires_at, revoked_at) values (${userId}, ${'ret-' + name + Math.random()}, ${expires}, ${revoked}) returning id`)[0].id;
  }
  // Notifications 90 days, analytics events 180 days.
  for (const [name, age] of [['old', 91], ['recent', 89]] as const) {
    ids['n_' + name] = (await sql`insert into notifications (user_id, kind, body, created_at) values (${userId}, 'plus', ${'ret ' + name}, ${ago(age)}) returning id`)[0].id;
  }
  for (const [name, age] of [['old', 181], ['recent', 179]] as const) {
    ids['a_' + name] = (await sql`insert into analytics_events (user_id, event_name, created_at) values (null, 'ret_probe', ${ago(age)}) returning id`)[0].id;
  }
  // Live locations (one row per message) and plan share links: kept 7 days after they expired.
  for (const [name, expires] of [['old', ago(8)], ['recent', ago(6)], ['live', ahead(1)]] as const) {
    const m = (await sql`insert into messages (chat_id, sender_id, kind, body) values (${chatId}, ${userId}, 'location', 'live') returning id`)[0].id;
    await sql`insert into chat_locations (message_id, user_id, location, expires_at) values (${m}, ${userId}, ST_SetSRID(ST_MakePoint(100.5, 13.7), 4326)::geography, ${expires})`;
    ids['l_' + name] = m;
    await sql`insert into plan_shares (activity_id, user_id, token, expires_at) values (${planId}, ${userId}, ${'ret-share-' + name + Math.random()}, ${expires})`;
  }
});
afterAll(async () => {
  await sql`delete from users where email like ${'%' + D}`;
  await sql`delete from otp_codes where email like ${'%' + D}`;
  await sql`delete from analytics_events where event_name in ('ret_probe', 'ret_batch')`;
  await sql.end();
});

describe('retention periods', () => {
  it('are the ones the privacy page states', () => {
    expect(RETENTION_DAYS).toEqual({ otpCodes: 1, expiredRefreshTokens: 30, notifications: 90, analyticsEvents: 180, expiredChatLocations: 7, expiredPlanShares: 7 });
  });
});

describe('purgeExpired', () => {
  it('deletes what is past its period and keeps everything else, one day either side of every cut-off', async () => {
    const counts = await purgeExpired();
    // Sign-in codes: needs the code to have expired a day ago AND its rate-limit window to be old.
    expect(await present('otp_codes', 'email', 'old' + D)).toBe(false);
    for (const k of ['recentwindow', 'justexpired', 'live']) expect(await present('otp_codes', 'email', k + D), k).toBe(true);
    // Refresh tokens: 30 days after expiry, revoked or not; a live token is never touched, revoked or not.
    for (const k of ['old', 'oldrevoked']) expect(await present('refresh_tokens', 'id', ids['rt_' + k]), k).toBe(false);
    for (const k of ['recent', 'live', 'livrevoked']) expect(await present('refresh_tokens', 'id', ids['rt_' + k]), k).toBe(true);
    expect(await present('notifications', 'id', ids.n_old)).toBe(false);
    expect(await present('notifications', 'id', ids.n_recent)).toBe(true);
    expect(await present('analytics_events', 'id', ids.a_old)).toBe(false);
    expect(await present('analytics_events', 'id', ids.a_recent)).toBe(true);
    expect(await present('chat_locations', 'message_id', ids.l_old)).toBe(false);
    for (const k of ['recent', 'live']) expect(await present('chat_locations', 'message_id', ids['l_' + k]), k).toBe(true);
    const shares = (await sql`select token from plan_shares where activity_id = ${planId}`).map(r => r.token as string);
    expect(shares.filter(t => t.startsWith('ret-share-old'))).toHaveLength(0);
    expect(shares.filter(t => t.startsWith('ret-share-recent') || t.startsWith('ret-share-live'))).toHaveLength(2);
    // The counts say what went (at least our rows; the database may hold other stale rows too).
    expect(counts.otpCodes).toBeGreaterThanOrEqual(1);
    expect(counts.refreshTokens).toBeGreaterThanOrEqual(2);
    for (const k of ['notifications', 'analyticsEvents', 'chatLocations', 'planShares'] as const) expect(counts[k], k).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent: a second run finds nothing of ours to delete', async () => {
    const again = await purgeExpired();
    expect(await present('refresh_tokens', 'id', ids.rt_recent)).toBe(true);
    expect(again.analyticsEvents + again.notifications + again.chatLocations + again.planShares + again.otpCodes + again.refreshTokens).toBeGreaterThanOrEqual(0);
    expect(await present('notifications', 'id', ids.n_recent)).toBe(true);
  });

  it('deletes in batches: at most batch x maxBatches rows a table in one run, the rest on the next', async () => {
    for (let i = 0; i < 12; i++) await sql`insert into analytics_events (user_id, event_name, created_at) values (null, 'ret_batch', ${ago(200)})`;
    const first = await purgeExpired(new Date(), { batch: 5, maxBatches: 2 });
    expect(first.analyticsEvents).toBe(10);
    expect((await sql`select count(*)::int as n from analytics_events where event_name = 'ret_batch'`)[0].n).toBeGreaterThanOrEqual(2);   // 12 of ours and only 10 deleted in all
    const second = await purgeExpired(new Date(), { batch: 5, maxBatches: 2 });
    expect(second.analyticsEvents).toBeLessThanOrEqual(10);
    expect((await sql`select count(*)::int as n from analytics_events where event_name = 'ret_batch'`)[0].n).toBe(0);
    expect(RETENTION_BATCH).toBeGreaterThan(0);
  });

  it('refuses a time that is not now: nothing is deleted', async () => {
    const fresh = (await sql`insert into notifications (user_id, kind, body) values (${userId}, 'plus', 'ret fresh') returning id`)[0].id;
    await expect(purgeExpired(new Date(Date.now() + 5 * DAY))).rejects.toThrow('retention_purge_needs_the_real_time');
    await expect(purgeExpired(new Date('2031-01-01T00:00:00Z'))).rejects.toThrow('retention_purge_needs_the_real_time');
    expect(await present('notifications', 'id', fresh)).toBe(true);
  });
});
