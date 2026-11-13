/**
 * What a report can point at, and the server-side checks that go with the user-generated content added since the first
 * moderation pass (moments, the comments under moments and plans, city tips, circle meetup ideas).
 *
 * For those kinds a report is accepted only when
 *  - the target exists and is still visible (not deleted, its author not deleted or banned, a women-only plan's
 *    comments only for women, a circle's ideas only for the circle's members), so a report can't probe for ids; and
 *  - the reporter and the author are not on either side of a block, and the reporter isn't the author.
 * 'user', 'activity' and 'message' keep their old behaviour (an unknown id is stored and reviewed by a person).
 *
 * The reported text is copied into the report's details: the admin queue then shows what was said even after the author
 * deletes it, which is also the evidence a moderator needs.
 */
import { sql } from './db.js';
import { bad, forbidden, notFound } from './errors.js';

export const REPORT_TARGET_TYPES = ['user', 'activity', 'message', 'moment', 'moment_comment', 'plan_comment', 'city_tip', 'circle_proposal'] as const;
export type ReportTargetType = typeof REPORT_TARGET_TYPES[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CheckedTarget = { authorId: string; authorName: string | null; text: string };

// One lookup per kind. `uid` is the reporter, for the kinds whose visibility depends on who is looking.
const LOOKUP: Record<string, (uid: string, id: string) => Promise<CheckedTarget | undefined>> = {
  moment: async (_uid, id) => (await sql`
    select m.user_id as author_id, u.name as author_name, m.caption as text
    from moments m join users u on u.id = m.user_id
    where m.id = ${id}::uuid and m.deleted_at is null and u.deleted_at is null and u.banned_at is null`)[0] as CheckedTarget | undefined,

  moment_comment: async (_uid, id) => (await sql`
    select c.user_id as author_id, u.name as author_name, c.body as text
    from moment_comments c
    join moments m on m.id = c.moment_id
    join users u on u.id = c.user_id
    join users mu on mu.id = m.user_id
    where c.id = ${id}::uuid and c.deleted_at is null and m.deleted_at is null
      and u.deleted_at is null and u.banned_at is null and mu.deleted_at is null and mu.banned_at is null`)[0] as CheckedTarget | undefined,

  plan_comment: async (uid, id) => (await sql`
    select c.user_id as author_id, u.name as author_name, c.body as text
    from activity_comments c
    join activities a on a.id = c.activity_id
    join users u on u.id = c.user_id
    where c.id = ${id}::uuid and a.status = 'active' and u.deleted_at is null and u.banned_at is null
      and (not a.women_only or exists (select 1 from users r where r.id = ${uid} and r.gender = 'woman'))`)[0] as CheckedTarget | undefined,

  city_tip: async (_uid, id) => (await sql`
    select t.user_id as author_id, u.name as author_name, t.title || chr(10) || t.body as text
    from city_tips t join users u on u.id = t.user_id
    where t.id = ${id}::uuid and u.deleted_at is null and u.banned_at is null`)[0] as CheckedTarget | undefined,

  circle_proposal: async (uid, id) => (await sql`
    select p.proposer_id as author_id, u.name as author_name, p.title as text
    from trip_circle_proposals p join users u on u.id = p.proposer_id
    where p.id = ${id}::uuid and u.deleted_at is null and u.banned_at is null
      and exists (select 1 from chat_members cm where cm.chat_id = p.chat_id and cm.user_id = ${uid})`)[0] as CheckedTarget | undefined,
};

/** How each checked kind reads in the details line a moderator sees. */
const LABEL: Record<string, string> = {
  moment: 'moment', moment_comment: 'comment on a moment', plan_comment: 'comment on a plan', city_tip: 'city tip', circle_proposal: 'circle meetup idea',
};

/**
 * Throws 404 report_target_not_found, 403 blocked or 400 cannot_report_own for a kind that is checked; resolves with the
 * target for it, or null for 'user', 'activity' and 'message', which aren't checked here.
 */
export async function checkReportTarget(uid: string, type: ReportTargetType, id: string): Promise<CheckedTarget | null> {
  const lookup = LOOKUP[type];
  if (!lookup) return null;
  const found = UUID.test(id) ? await lookup(uid, id) : undefined;
  if (!found) throw notFound('report_target_not_found');
  if (found.authorId === uid) throw bad('cannot_report_own');
  const [block] = await sql`select 1 from blocks
    where (blocker_id = ${uid} and blocked_id = ${found.authorId}) or (blocker_id = ${found.authorId} and blocked_id = ${uid})`;
  if (block) throw forbidden('blocked');
  return found;
}

/** The reporter's own words, then what was reported and by whom (400 characters of it). */
export function reportDetails(details: string | undefined, type: ReportTargetType, found: CheckedTarget | null): string | undefined {
  if (!found) return details;
  const text = found.text.length > 400 ? `${found.text.slice(0, 400)}…` : found.text;
  const line = `Reported ${LABEL[type]} by ${found.authorName ?? 'a traveler'} (user ${found.authorId}): "${text}"`;
  return [details?.trim(), line].filter(Boolean).join('\n\n');
}
