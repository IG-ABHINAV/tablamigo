/**
 * The time-based jobs on plans: reminders shortly before a plan starts, and creating the next session of a recurring plan.
 * lib/scheduler.ts runs them every minute; the admin routes (POST /admin/activities/process-reminders and
 * /process-recurring) and the host's "advance recurrence" call the same functions. Each takes `now` so tests (and the
 * scheduler) say what time it is instead of reading the clock.
 */
import { sql } from './db.js';
import { clock } from './clock.js';
import { notify } from './push.js';
import { addNotice } from './inbox.js';
import { emitToChat, joinUserToChat } from './realtime.js';
import { bad } from './errors.js';
import { addLocal, localDate, wallClock, zoneAt } from './local-time.js';

type Due = { id: string; title: string; placeName: string; startsAt: Date; chatId: string | null };

/**
 * Marks the plans that are due (`due` is the filter on `a`) as reminded in the same statement that selects them, and returns
 * them, so two processes running at once can't both remind the same plan: the second one skips rows the first has locked and
 * no longer finds them once it commits. A reminder lost to a crash is the safer failure than one sent twice.
 */
async function claim(column: 'reminded_2h_at' | 'reminded_15m_at', now: Date, from: string, to: string) {
  const col = sql(column);
  return sql<Due[]>`
    update activities a set ${col} = ${now}::timestamptz
    where a.id in (
      select id from activities
      where status = 'active' and ${col} is null
        and starts_at between ${now}::timestamptz + ${from}::interval and ${now}::timestamptz + ${to}::interval
      order by starts_at asc limit 50
      for update skip locked)
    returning a.id, a.title, a.place_name, a.starts_at, (select c.id from chats c where c.activity_id = a.id limit 1) as chat_id`;
}

/** One reminder: a system line in the plan's chat, and a push to the people who are going (the host included). */
async function remind(d: Due, body: string, push: { title: string; body: string }) {
  if (!d.chatId) return;
  const [msg] = await sql`insert into messages (chat_id, kind, body) values (${d.chatId}, 'system', ${body}) returning id, created_at`;
  emitToChat(d.chatId, 'message:new', { id: String(msg.id), chatId: d.chatId, kind: 'system', body, createdAt: msg.createdAt });
  const going = (await sql`select user_id from activity_members where activity_id = ${d.id} and rsvp_status = 'going'`).map(m => m.userId as string);
  // The app opens a tapped notification by data.chatId (lib/push.ts in the app, sw.js on the web).
  if (going.length) notify(going, { ...push, data: { chatId: d.chatId }, tag: d.chatId }).catch(() => {});
}

/**
 * The 2-hour reminder (plans starting between 45 minutes and 2 h 15 min from `now`) and the 15-minute one (plans starting
 * within 20 minutes). The windows are wide on purpose, so a restart or a missed minute doesn't lose a reminder. Each plan is
 * reminded once per kind.
 */
export async function processPlanReminders(now: Date = clock.now()) {
  const due2h = await claim('reminded_2h_at', now, '45 minutes', '2 hours 15 minutes');
  for (const d of due2h) {
    // One failing plan must not leave the rest of the claimed batch unsent.
    try {
      await remind(d, `⏰ Reminder: "${d.title}" starts in ~2 hours at ${d.placeName}! Check your route.`,
        { title: `Starts in 2 hours: ${d.title}`, body: `Meet at ${d.placeName}. Check directions!` });
    } catch (err) { console.error('plan reminder (2h) failed for', d.id, (err as Error).message); }
  }
  const due15m = await claim('reminded_15m_at', now, '0 minutes', '20 minutes');
  for (const d of due15m) {
    try {
      await remind(d, `📍 Meetup starting in 15 minutes at ${d.placeName}! Tap "I'm here" once you arrive to check in.`,
        { title: 'Starting in 15 minutes!', body: `Head over to ${d.placeName} for "${d.title}".` });
    } catch (err) { console.error('plan reminder (15m) failed for', d.id, (err as Error).message); }
  }
  return { reminded2h: due2h.length, reminded15m: due15m.length };
}

/** A series whose latest session began longer ago than this is not woken up by the scheduler; its host can still advance it. */
export const RECURRING_LOOKBACK_DAYS = 7;

/**
 * Recurring plans whose next session is due: it is created 2 hours before the current one starts (or later, if it was
 * missed, up to RECURRING_LOOKBACK_DAYS later: after an outage or the first run, a dormant series is not suddenly
 * rescheduled and announced to people who left it long ago).
 */
export async function processDueRecurring(now: Date = clock.now()) {
  const due = await sql`
    select id, title, starts_at, recurrence
    from activities
    where recurrence is not null
      and next_activity_id is null
      and auto_advance = true
      and starts_at <= ${now}::timestamptz + interval '2 hours'
      and starts_at > ${now}::timestamptz - ${RECURRING_LOOKBACK_DAYS + ' days'}::interval
      and status = 'active'
    order by starts_at asc
    limit 50`;
  if (due.length === 50) console.warn('processDueRecurring hit its cap of 50 plans; the rest wait for the next tick');
  const items = [];
  for (const d of due) {
    try {
      const res = await generateNextOccurrence(d.id, now);
      items.push({ id: d.id, title: d.title, ...res });
    } catch (err) {
      items.push({ id: d.id, title: d.title, error: (err as Error).message });
    }
  }
  return { processed: items.length, items };
}

const STEP = { weekly: { days: 7 }, biweekly: { days: 14 }, monthly: { months: 1 } } as const;

/**
 * Creates the next session of a recurring plan: same host, chat and details, the next date on the plan's own wall clock
 * (the time zone of the place it meets at, so "Tuesdays at 19:00" stays 19:00 across a clock change), never earlier than a
 * minute ago. A monthly plan keeps its day of the month, or the last day of a shorter month, and every session keeps the
 * clock time of the first one. Idempotent: a plan that already has a next session returns it.
 */
export async function generateNextOccurrence(activityId: string, now: Date = clock.now()) {
  const result = await sql.begin(async tx => {
    const [current] = await tx`
      select id, host_id, title, emoji, category, description, place_name, place_address,
             location, ST_Y(location::geometry) as lat, ST_X(location::geometry) as lng,
             city, starts_at, max_people, women_only, recurrence, series_id,
             occurrence_number, next_activity_id, auto_advance
      from activities
      where id = ${activityId}
      for update
    `;
    if (!current) throw bad('not_found', 'Activity not found.');
    if (!current.recurrence) throw bad('not_recurring', 'This activity is not a recurring plan.');
    if (current.nextActivityId) {
      const [nextAct] = await tx`select id, starts_at, title, occurrence_number from activities where id = ${current.nextActivityId}`;
      return { ok: true, alreadyGenerated: true, nextActivityId: current.nextActivityId, startsAt: nextAct?.startsAt, occurrenceNumber: nextAct?.occurrenceNumber };
    }

    const zone = zoneAt(current.lat, current.lng);
    const seriesId = current.seriesId || current.id;
    // The first session sets the clock time and the day of the month every later one keeps.
    const [root] = seriesId === current.id ? [current] : await tx`select starts_at from activities where id = ${seriesId}`;
    const anchor = wallClock(new Date(root?.startsAt ?? current.startsAt).getTime(), zone);
    const step = STEP[current.recurrence as keyof typeof STEP];
    let nextStarts = new Date(current.startsAt);
    // At least one step on, and on until it is no longer in the past (a series nobody advanced for weeks catches up in one go).
    for (let i = 0; i < 1000; i++) {
      nextStarts = addLocal(nextStarts, zone, { ...step, dayOfMonth: anchor.d, time: anchor });
      if (nextStarts.getTime() >= now.getTime() - 60_000) break;
    }

    const nextOccNumber = (current.occurrenceNumber || 1) + 1;

    const [nextAct] = await tx`
      insert into activities (
        host_id, title, emoji, category, description, place_name, place_address,
        location, city, starts_at, max_people, women_only, recurrence,
        series_id, parent_activity_id, occurrence_number, auto_advance
      )
      values (
        ${current.hostId}, ${current.title}, ${current.emoji}, ${current.category},
        ${current.description}, ${current.placeName}, ${current.placeAddress},
        ${current.location}, ${current.city}, ${nextStarts}, ${current.maxPeople},
        ${current.womenOnly}, ${current.recurrence}, ${seriesId}, ${current.id},
        ${nextOccNumber}, true
      )
      returning id, starts_at, title
    `;

    // Mark previous activity with next_activity_id
    await tx`update activities set next_activity_id = ${nextAct.id} where id = ${current.id}`;

    // Add host as going
    await tx`insert into activity_members (activity_id, user_id, rsvp_status) values (${nextAct.id}, ${current.hostId}, 'going')`;

    // Create chat for new activity
    const [c] = await tx`insert into chats (kind, activity_id, title, last_message_at) values ('activity', ${nextAct.id}, ${current.title}, now()) returning id`;
    await tx`insert into chat_members (chat_id, user_id) values (${c.id}, ${current.hostId})`;
    await tx`insert into messages (chat_id, kind, body) values (${c.id}, 'system', ${`Session #${nextOccNumber} scheduled! Welcome back.`})`;

    // Announce in old chat, with the date as it reads where the plan is
    const [oldChat] = await tx`select id from chats where activity_id = ${current.id}`;
    if (oldChat) {
      await tx`insert into messages (chat_id, kind, body) values (${oldChat.id}, 'system', ${`Next session (#${nextOccNumber}) has been scheduled for ${localDate(nextStarts, zone)}!`})`;
    }

    // Collect past attendees to notify outside the tx
    const pastMembers = await tx`select user_id from activity_members where activity_id = ${current.id} and user_id <> ${current.hostId} and rsvp_status = 'going'`;
    const recipientIds = pastMembers.map((m: any) => (m.userId || m.user_id) as string);

    return {
      ok: true,
      nextActivityId: nextAct.id,
      chatId: c.id,
      startsAt: nextAct.startsAt,
      occurrenceNumber: nextOccNumber,
      title: current.title,
      hostId: current.hostId,
      recipientIds,
    };
  });

  if (result.alreadyGenerated) {
    return result;
  }

  if (result.recipientIds && result.recipientIds.length > 0) {
    await addNotice(result.recipientIds, {
      kind: 'recurring_next',
      actorId: result.hostId,
      activityId: result.nextActivityId,
      chatId: result.chatId,
      body: (hostName: string) => `${hostName} scheduled session #${result.occurrenceNumber} of "${result.title}"!`
    });
  }

  joinUserToChat(result.hostId, result.chatId);

  return {
    ok: true,
    nextActivityId: result.nextActivityId,
    chatId: result.chatId,
    startsAt: result.startsAt,
    occurrenceNumber: result.occurrenceNumber,
  };
}
