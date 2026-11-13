/**
 * Host rewards (1 Nov 2026). Tablamigo's meetups only happen if travellers post plans, and most cities have none, so a traveller
 * who hosts a plan that real people checked in at gets HOST_REWARD.days of Plus, once per plan, at most HOST_REWARD.maxPerWindow times per
 * HOST_REWARD.windowDays. The days go into comp_until and plus_until is recomputed (never written by hand, lib/play.ts), the same as
 * invite rewards (lib/referral.ts).
 *
 * Who counts, so the reward can't be farmed with spare accounts:
 * - the host is a real traveller (lib/team-dm.ts realTraveller: no team, demo, review, admin or test accounts);
 * - a guest is a real traveller marked going who CHECKED IN at the plan (POST /activities/:id/checkin: within 350 m of the meeting
 *   point, from 30 min before to 6 h after the start), not the host, whose account existed before the plan was posted and who was
 *   not invited by the host (users.referred_by). An RSVP alone is not enough: spare accounts could RSVP from anywhere;
 * - the plan was not cancelled, and it started more than HOST_REWARD.afterStartHours ago (so it happened) but within
 *   HOST_REWARD.lookbackDays (an old plan is never rewarded the day this ships).
 * One host_rewards row per plan is the claim (071_host_rewards.sql): 'granted', or 'capped' when the host is at the limit.
 *
 * HOST_REWARDS = off | dry | on (config.hostRewards, unset = dry: logs who would get days and writes nothing).
 */
import { sql } from './db.js';
import { clock } from './clock.js';
import { config, type Mode } from './config.js';
import { realTraveller } from './team-dm.js';
import { recomputePlus } from './play.js';
import { addNotice } from './inbox.js';

export const HOST_REWARD = { days: 7, minGuests: 2, maxPerWindow: 2, windowDays: 30, afterStartHours: 2, lookbackDays: 7 };

export type HostRewardTally = { mode: Mode; granted: number; capped: number; planned: number; failed: number };

const dryLogged = new Set<string>();

/** Plans that qualify at `now`, with their real-guest count. `hostId` limits it to one host (tests share one database). */
export async function rewardablePlans(now: Date, hostId?: string) {
  return sql`select a.id, a.host_id, a.title, count(*)::int as guests
    from activities a
    join users h on h.id = a.host_id
    join activity_members m on m.activity_id = a.id and m.rsvp_status = 'going' and m.checked_in_at is not null and m.user_id <> a.host_id
    join users u on u.id = m.user_id
    where a.status = 'active'
      and a.starts_at <= ${now}::timestamptz - ${HOST_REWARD.afterStartHours + ' hours'}::interval
      and a.starts_at > ${now}::timestamptz - ${HOST_REWARD.lookbackDays + ' days'}::interval
      and ${realTraveller('h')}
      and ${realTraveller('u')}
      and u.created_at < a.created_at
      and (u.referred_by is null or u.referred_by <> a.host_id)
      and not exists (select 1 from host_rewards r where r.activity_id = a.id)
      ${hostId ? sql`and a.host_id = ${hostId}` : sql``}
    group by a.id, a.host_id, a.title
    having count(*) >= ${HOST_REWARD.minGuests}
    order by min(a.starts_at)
    limit 200`;
}

/** One pass: reward every plan that qualifies at `now`. Run by the scheduler every minute (cheap when there is nothing to do). */
export async function processHostRewards(now: Date = clock.now(), o: { mode?: Mode; dryLog?: Set<string>; hostId?: string } = {}): Promise<HostRewardTally> {
  const mode = o.mode ?? config.hostRewards;
  const t: HostRewardTally = { mode, granted: 0, capped: 0, planned: 0, failed: 0 };
  if (mode === 'off') return t;
  const plans = await rewardablePlans(now, o.hostId);
  for (const p of plans) {
    if (mode === 'dry') {
      const logged = o.dryLog ?? dryLogged;
      if (!logged.has(p.id)) { logged.add(p.id); console.log(`host reward (dry): host=${p.hostId} plan=${p.id} guests=${p.guests}`); t.planned++; }
      continue;
    }
    try {
      const status = await sql.begin(async tx => {
        // The host's row is locked so two plans ending in the same tick can't both take the last reward in the window.
        await tx`select 1 from users where id = ${p.hostId} for update`;
        const [{ n }] = await tx`select count(*)::int as n from host_rewards where host_id = ${p.hostId} and status = 'granted'
          and created_at > ${now}::timestamptz - ${HOST_REWARD.windowDays + ' days'}::interval`;
        const granted = n < HOST_REWARD.maxPerWindow;
        const [claim] = await tx`insert into host_rewards (activity_id, host_id, guests, days, status, created_at)
          values (${p.id}, ${p.hostId}, ${p.guests}, ${granted ? HOST_REWARD.days : 0}, ${granted ? 'granted' : 'capped'}, ${now})
          on conflict (activity_id) do nothing returning status`;
        if (!claim) return null;
        // Stacked on comp_until only, not on a paid subscription's or pass's end: if that payment is refunded later, recomputePlus
        // must not keep the refunded period alive through comp_until.
        if (granted) await tx`update users set comp_until = greatest(now(), coalesce(comp_until, now())) + ${HOST_REWARD.days + ' days'}::interval
          where id = ${p.hostId}`;
        return claim.status as 'granted' | 'capped';
      });
      if (status === 'granted') {
        t.granted++;
        await recomputePlus(p.hostId);
        await addNotice([p.hostId], { kind: 'plus', activityId: p.id,
          body: `Thanks for hosting "${String(p.title).slice(0, 80)}": ${p.guests} travelers checked in. You've got ${HOST_REWARD.days} days of Tablamigo Plus.` });
        await sql`insert into analytics_events (user_id, event_name, properties) values (${p.hostId}, 'host_reward', ${sql.json({ activityId: p.id, guests: p.guests, days: HOST_REWARD.days })})`.catch(() => {});
      } else if (status === 'capped') t.capped++;
    } catch (e) {
      t.failed++;
      console.error('host reward failed', p.id, (e as Error).message);
    }
  }
  return t;
}

/** What the app and the website say about it, so the numbers are written once (GET /me/host-rewards). */
export async function hostRewardSummary(uid: string, now: Date = clock.now()) {
  const [r] = await sql`select count(*) filter (where status = 'granted')::int as rewarded,
      coalesce(sum(days) filter (where status = 'granted'), 0)::int as days_earned,
      count(*) filter (where status = 'granted' and created_at > ${now}::timestamptz - ${HOST_REWARD.windowDays + ' days'}::interval)::int as in_window
    from host_rewards where host_id = ${uid}`;
  return { ...HOST_REWARD, rewarded: r.rewarded, daysEarned: r.daysEarned, leftThisWindow: Math.max(0, HOST_REWARD.maxPerWindow - r.inWindow) };
}
