/**
 * Plans the Tablamigo Host lists (the team account, lib/host.ts). One service for both ways a Host plan is made:
 *  - the starter-plans worker (lib/starter-plans.ts), in a curated city, which adds its own starter_plans row, and
 *  - the admin "Create plan as Tablamigo team" form (POST /admin/host/plans), for any city where people are.
 * The Host only lists the plan: it is never a member, so "going" counts only real people who joined, and nobody from the team
 * attends (the description and the chat's opening line say so). The plan has its group chat from the start; people who join
 * land in it. No push, no analytics `plan_created` (that would inflate the funnel): travellers find it in Explore.
 */
import type postgres from 'postgres';
import { sql } from './db.js';
import { clock } from './clock.js';
import { getHost } from './host.js';
import { bad } from './errors.js';

export const HOST_PLAN_CATEGORIES = ['food', 'drinks', 'nightlife', 'explore', 'outdoors', 'culture', 'sports', 'work', 'other'] as const;
export type HostPlanCategory = typeof HOST_PLAN_CATEGORIES[number];

export type HostPlanInput = {
  title: string; emoji: string; category: HostPlanCategory; description: string;
  placeName: string; lat: number; lng: number; city: string | null;
  startsAt: Date; maxPeople: number | null;
};

/** The chat's first line of an admin-made plan. */
export const HOST_PLAN_OPENING = 'Plan listed by the Tablamigo team. Nobody from the team attends: say hi here and agree the exact spot, and meet in a public place.';

/** Inserts the plan and its group chat (with `opening` as the first system line) in the caller's transaction. */
export async function insertHostPlan(tx: postgres.TransactionSql, hostId: string, p: HostPlanInput, opening: string): Promise<{ id: string; chatId: string }> {
  const [a] = await tx`insert into activities (host_id, title, emoji, category, description, place_name, location, city, starts_at, max_people, women_only, recurrence, occurrence_number, auto_advance)
    values (${hostId}, ${p.title}, ${p.emoji}, ${p.category}, ${p.description}, ${p.placeName},
      st_setsrid(st_makepoint(${p.lng}::float8, ${p.lat}::float8), 4326)::geography, ${p.city}, ${p.startsAt}, ${p.maxPeople}, false, null, 1, false) returning id`;
  const [ch] = await tx`insert into chats (kind, activity_id, title, last_message_at) values ('activity', ${a.id}, ${p.title}, now()) returning id`;
  await tx`insert into messages (chat_id, kind, body) values (${ch.id}, 'system', ${opening})`;
  return { id: a.id as string, chatId: ch.id as string };
}

export const HOST_PLAN_MIN_LEAD_HOURS = 4, HOST_PLAN_MAX_LEAD_DAYS = 30;

/**
 * The admin path: validates the time, refuses a second identical plan, lists it as the Host and returns its ids.
 * Throws bad('no_host') if the team account is missing, bad('bad_time') outside 4 hours..30 days ahead, bad('duplicate_plan')
 * for the same title at the same time and place.
 */
export async function createHostPlan(p: HostPlanInput, now: Date = clock.now()): Promise<{ id: string; chatId: string; city: string | null }> {
  const host = await getHost();
  if (!host) throw bad('no_host', 'The Tablamigo team account does not exist.');
  const lead = p.startsAt.getTime() - now.getTime();
  if (lead < HOST_PLAN_MIN_LEAD_HOURS * 3600_000 || lead > HOST_PLAN_MAX_LEAD_DAYS * 86400_000) throw bad('bad_time', `Pick a time from ${HOST_PLAN_MIN_LEAD_HOURS} hours to ${HOST_PLAN_MAX_LEAD_DAYS} days ahead.`);
  const [dup] = await sql`select id from activities where host_id = ${host.id} and status = 'active' and starts_at = ${p.startsAt} and place_name = ${p.placeName} and title = ${p.title}`;
  if (dup) throw bad('duplicate_plan', 'The team already listed this plan.');
  const made = await sql.begin(tx => insertHostPlan(tx, host.id, p, HOST_PLAN_OPENING));
  return { ...made, city: p.city };
}
