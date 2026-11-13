/**
 * Retention: how long short-lived records are kept, and the purge that enforces it. The periods are what the privacy page says,
 * so change them in both places. lib/scheduler.ts runs the purge once a day.
 *
 *   otp_codes            1 day after the code expired (and after its rate-limit window began)
 *   refresh_tokens       30 days after they expired
 *   notifications        90 days after they were created
 *   analytics_events     180 days after they were recorded
 *   chat_locations       7 days after the share expired or was stopped
 *   plan_shares          7 days after the link expired
 *
 * Rows go in batches (RETENTION_BATCH at a time, at most RETENTION_MAX_BATCHES batches per table per run) so a table that has
 * never been purged is cleared over a few days' runs without one long delete holding locks.
 */
import { sql } from './db.js';
import { clock } from './clock.js';

export const RETENTION_DAYS = { otpCodes: 1, expiredRefreshTokens: 30, notifications: 90, analyticsEvents: 180, expiredChatLocations: 7, expiredPlanShares: 7 } as const;
export const RETENTION_BATCH = 5000;
export const RETENTION_MAX_BATCHES = 100;

export type PurgeCounts = Record<'otpCodes' | 'refreshTokens' | 'notifications' | 'analyticsEvents' | 'chatLocations' | 'planShares', number>;

const ago = (now: Date, days: number) => new Date(now.getTime() - days * 86400_000);

/**
 * Deletes what is past its retention period as of `now`; returns how many rows went from each table. `now` must be the real time
 * (a purge for a made-up time would delete live data): a `now` more than an hour from the clock is refused.
 */
export async function purgeExpired(now: Date = clock.now(), { batch = RETENTION_BATCH, maxBatches = RETENTION_MAX_BATCHES }: { batch?: number; maxBatches?: number } = {}): Promise<PurgeCounts> {
  if (!isCurrent(now)) throw new Error('retention_purge_needs_the_real_time');
  const cutoff = (days: number) => ago(now, days);
  // One DELETE per batch; `where` is the condition for "past its period".
  const run = async (table: ReturnType<typeof sql>, where: ReturnType<typeof sql>) => {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const r = await sql`delete from ${table} where ctid in (select ctid from ${table} where ${where} limit ${batch})`;
      total += r.count;
      if (r.count < batch) break;
    }
    return total;
  };
  const d = RETENTION_DAYS;
  const counts: PurgeCounts = {
    otpCodes: await run(sql`otp_codes`, sql`expires_at < ${cutoff(d.otpCodes)}::timestamptz and window_start < ${cutoff(d.otpCodes)}::timestamptz`),
    refreshTokens: await run(sql`refresh_tokens`, sql`expires_at < ${cutoff(d.expiredRefreshTokens)}::timestamptz`),
    notifications: await run(sql`notifications`, sql`created_at < ${cutoff(d.notifications)}::timestamptz`),
    analyticsEvents: await run(sql`analytics_events`, sql`created_at < ${cutoff(d.analyticsEvents)}::timestamptz`),
    chatLocations: await run(sql`chat_locations`, sql`expires_at < ${cutoff(d.expiredChatLocations)}::timestamptz`),
    planShares: await run(sql`plan_shares`, sql`expires_at < ${cutoff(d.expiredPlanShares)}::timestamptz`),
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`retention: purged ${total} rows ${JSON.stringify(counts)}`);
  return counts;
}

/** Whether `now` is the actual time of day (within an hour), as opposed to a time a test made up. */
export const isCurrent = (now: Date) => Math.abs(now.getTime() - Date.now()) < 3600_000;
