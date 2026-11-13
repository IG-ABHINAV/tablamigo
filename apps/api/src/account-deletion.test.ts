// DELETE /me must leave nothing of the person behind: the delete-account web page promises it. The account row stays as
// a tombstone (foreign keys, reports), so none of the ON DELETE CASCADEs run and every table has to be cleared by hand.
// Seeds one row in every table that points at a user (the tables made since 1 Oct 2026 included), deletes the account,
// and checks nothing remains; a schema sweep then fails for any NEW table that points at users and isn't handled.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Response as InjectResponse } from 'light-my-request';

const D = '@acctdel.tablamigo';
// Everything the whole-database search looks for carries this run's token, so rows an earlier run left behind (a deleted account keeps
// its row, and a run that failed halfway leaves what it seeded) can never be mistaken for a leftover of this one.
const RUN = Date.now().toString(36);
const DIGITS = String(Date.now()).slice(-9);
const PHONE_DEL = `+91${DIGITS}1`, PHONE_TRUSTED = `+91${DIGITS}2`;
const SAY = (t: string) => `${t} ${RUN}`;
const PEOPLE = ['del', 'ally', 'host', 'stranger'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => p + D).join(',');
process.env.REVIEW_CODE = '616161';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { putImage, putAudio } = await import('./lib/storage.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<InjectResponse>;
const u: Record<string, Api> = {};
const id: Record<string, string> = {};
let ip = 0;

async function login(name: string, gender = 'woman'): Promise<Api> {
  const email = name + D; const remoteAddress = `10.88.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '616161' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` }, remoteAddress });
  await call('PATCH', '/me', { name, birthdate: '1992-02-02', gender, homeCountry: 'IN', travelStyle: ['foodie'], interests: ['food'], instagram: name === 'del' ? `del_gram_${RUN}` : `${name}_gram`,
    emergencyContactName: 'Mum', emergencyContactPhone: name === 'del' ? PHONE_DEL : '+919999900011' });   // the others keep theirs
  id[name] = (await call('GET', '/me')).json().id;
  return call;
}
const exists = (p: string) => fs.existsSync(path.resolve('.dev-files', p));
const count = async (table: string, col: string, val: string) =>
  (await sql.unsafe(`select count(*)::int as n from ${table} where ${col} = $1`, [val]))[0].n as number;

// What the seed puts in, and where.
let hostedPlan = '', planId = '', planChat = '', circleChat = '', delTip = '', allyTip = '', delMoment = '', allyMoment = '', msgText = 0, msgVoice = 0, msgPoll = 0, msgLive = 0, allyMsg = 0, delPhoto = '', allyPhoto = '', allyProposal = '';
const files: string[] = [];
const UPI = `del.payout.${RUN}@okaxis`;

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));   // no Nominatim
  app = await build();
  await sql`delete from analytics_events where properties->>'planId' = 'x'`;   // left by an earlier run (hard-deleting a user only nulls user_id)
  await sql`delete from users where email like ${'%' + D}`;
  for (const p of PEOPLE) u[p] = await login(p, 'woman');
  await sql`update users set plus_until = now() + interval '30 days' where email like ${'%' + D}`;
  const [del, ally, host, stranger] = [id.del, id.ally, id.host, id.stranger];

  // A plan the person joined and chatted in; a trip circle; a DM request that was never accepted.
  const plan = await u.host('POST', '/activities', { title: 'Sunset chai', category: 'food', startsAt: new Date(Date.now() + 5 * 3600_000).toISOString(), lat: 19.07, lng: 72.87, placeName: 'Bandra' });
  expect(plan.statusCode).toBe(200);
  planId = plan.json().id;
  planChat = (await u.del('POST', `/activities/${planId}/join`, {})).json().chatId;
  expect(planChat).toBeTruthy();
  await u.ally('POST', `/activities/${planId}/join`, {});
  const trip = { city: 'Hue', countryCode: 'VN', startDate: '2026-11-10', endDate: '2026-11-20' };
  const tripId = (await u.del('POST', '/trips', trip)).json().id as string;
  await u.ally('POST', '/trips', trip);
  circleChat = (await u.del('POST', `/trips/${tripId}/group-chat`)).json().chatId;
  const allyTripId = (await u.ally('GET', '/trips')).json().trips[0].id as string;
  expect((await u.ally('POST', `/trips/${allyTripId}/group-chat`)).json().chatId).toBe(circleChat);
  const dmPending = (await u.del('POST', `/dm/${stranger}`)).json().chatId as string;   // never accepted: pending on their side
  expect((await sql`select request_status from chat_members where chat_id = ${dmPending} and user_id = ${stranger}`)[0].requestStatus).toBe('pending');
  const dmAccepted = (await u.del('POST', `/dm/${host}`)).json().chatId as string;       // they share a plan: accepted, kept
  await sql`update chat_members set request_status = 'accepted' where chat_id = ${dmAccepted}`;
  await sql`insert into dm_starts (user_id, chat_id) values (${del}, ${dmPending}) on conflict do nothing`;

  // Files they uploaded (chat photo, avatar, voice note, an ID document written the way the code does).
  const chatImg = await putImage(del, 'chat', 'image/jpeg', Buffer.from('x'));
  const avatar = await putImage(del, 'avatar', 'image/jpeg', Buffer.from('x'));
  const idDoc = await putImage(del, 'id_doc', 'image/jpeg', Buffer.from('x'));
  const audio = await putAudio(del, 'audio/webm', Buffer.from('x'));
  files.push(chatImg.key, avatar.key, idDoc.key, audio.key);
  allyMsg = (await sql`insert into messages (chat_id, sender_id, kind, body) values (${planChat}, ${ally}, 'text', 'see you there') returning id`)[0].id;

  // Messages beyond text: voice note, poll (+ a vote by someone else), live location, reactions on both sides.
  msgText = (await sql`insert into messages (chat_id, sender_id, kind, body) values (${planChat}, ${del}, 'text', ${SAY('my number is private')}) returning id`)[0].id;
  msgVoice = (await sql`insert into messages (chat_id, sender_id, kind, body) values (${planChat}, ${del}, 'audio', ${audio.publicUrl}) returning id`)[0].id;
  await sql`insert into chat_voice_notes (message_id, audio_url, duration_seconds) values (${msgVoice}, ${audio.publicUrl}, 7)`;
  msgPoll = (await sql`insert into messages (chat_id, sender_id, kind, body) values (${planChat}, ${del}, 'poll', 'where?') returning id`)[0].id;
  await sql`insert into chat_polls (message_id, question, options) values (${msgPoll}, 'where?', ${['a', 'b']})`;
  await sql`insert into chat_poll_votes (message_id, user_id, option) values (${msgPoll}, ${ally}, 0)`;
  msgLive = (await sql`insert into messages (chat_id, sender_id, kind, body) values (${planChat}, ${del}, 'location', 'live') returning id`)[0].id;
  await sql`insert into chat_locations (message_id, user_id, location, expires_at) values (${msgLive}, ${del}, ST_SetSRID(ST_MakePoint(72.87, 19.07), 4326)::geography, now() + interval '1 hour')`;
  await sql`insert into message_reactions (message_id, user_id, emoji) values (${msgText}, ${ally}, '❤️'), (${allyMsg}, ${del}, '👍')`;
  await sql`insert into chat_poll_votes (message_id, user_id, option) select ${msgPoll}, ${del}, 1`;

  // Moments, tips, plan discussion and photos.
  delMoment = (await sql`insert into moments (user_id, city, country_code, image_url, caption) values (${del}, 'Hue', 'VN', ${chatImg.publicUrl}, ${SAY('bridge at dusk')}) returning id`)[0].id;
  allyMoment = (await sql`insert into moments (user_id, city, country_code, image_url, caption) values (${ally}, 'Hue', 'VN', 'x', 'pho') returning id`)[0].id;
  await sql`insert into moment_likes (moment_id, user_id) values (${delMoment}, ${ally}), (${allyMoment}, ${del})`;
  await sql`insert into moment_comments (moment_id, user_id, body) values (${delMoment}, ${ally}, 'lovely'), (${allyMoment}, ${del}, 'where is this?')`;
  delTip = (await sql`insert into city_tips (city_slug, user_id, title, body) values ('hue-vn', ${del}, ${SAY('Boat at 6')}, ${SAY('ask for Linh')}) returning id`)[0].id;
  allyTip = (await sql`insert into city_tips (city_slug, user_id, title, body, helpful_count) values ('hue-vn', ${ally}, 'Skip the tour', 'walk it', 1) returning id`)[0].id;
  await sql`insert into city_tip_upvotes (tip_id, user_id) values (${delTip}, ${ally}), (${allyTip}, ${del})`;
  await sql`insert into activity_comments (activity_id, user_id, body) values (${planId}, ${del}, ${SAY('bringing a friend')})`;
  delPhoto = (await sql`insert into activity_photos (activity_id, user_id, url) values (${planId}, ${del}, ${chatImg.publicUrl}) returning id`)[0].id;
  allyPhoto = (await sql`insert into activity_photos (activity_id, user_id, url) values (${planId}, ${ally}, 'x') returning id`)[0].id;
  await sql`insert into activity_photo_reactions (photo_id, user_id) values (${delPhoto}, ${ally}), (${allyPhoto}, ${del})`;
  await sql`insert into activity_ratings (activity_id, rater_id, host_id, rating, feedback) values (${planId}, ${del}, ${host}, 5, 'great host')`;
  await sql`insert into saved_activities (user_id, activity_id, notes) values (${del}, ${planId}, ${SAY('ask about her sister')})`;
  await sql`insert into plan_shares (activity_id, user_id, token, expires_at) values (${planId}, ${del}, 'tok-acctdel', now() + interval '1 day')`;
  await sql`insert into safety_alerts (activity_id, user_id, latitude, longitude, note) values (${planId}, ${del}, 19.07, 72.87, ${SAY('felt unsafe')})`;

  // Safety contacts, buddy matching, trip circle proposals and votes.
  await sql`insert into user_trusted_contacts (user_id, name, phone) values (${del}, ${SAY('Priya')}, ${PHONE_TRUSTED})`;
  await sql`insert into travel_buddy_requests (sender_id, recipient_id, city_key, intro_note) values (${del}, ${ally}, 'hue-vn', 'hi'), (${stranger}, ${del}, 'hue-vn', 'hello')`;
  await sql`insert into trip_circle_proposals (chat_id, proposer_id, title, category, proposed_date, votes) values (${circleChat}, ${del}, ${SAY('Citadel walk')}, 'culture', '2026-11-12', ${[del, ally]}::uuid[])`;
  allyProposal = (await sql`insert into trip_circle_proposals (chat_id, proposer_id, title, category, proposed_date, votes) values (${circleChat}, ${ally}, 'Street food', 'food', '2026-11-13', ${[ally, del]}::uuid[]) returning id`)[0].id;

  // Wallet, ID verification, analytics, people graph, inbox, sign-in codes.
  const wallet = (await sql`insert into trip_pass_wallet (user_id, source, passes_added, passes_remaining, order_id) values (${del}, 'purchase_single', 1, 0, 'order_acctdel') returning id`)[0].id;
  await sql`insert into trip_pass_wallet (user_id, source, passes_added, passes_remaining) values (${del}, 'referral_bonus', 1, 1)`;
  await sql`insert into trip_pass_redemptions (user_id, wallet_id, plus_until_after) values (${del}, ${wallet}, now() + interval '14 days')`;
  await sql`update users set trip_passes_available = 2, id_verified = true, id_verification_status = 'approved', boosted_until = now() + interval '1 day', here_now_status = 'around' where id = ${del}`;
  await sql`insert into id_verification_requests (user_id, document_type, document_country, document_photo_key, status) values (${del}, 'passport', 'IN', ${idDoc.key}, 'approved')`;
  await sql`insert into analytics_events (user_id, event_name, properties) values (${del}, 'activation_first_plan_joined', '{"planId":"x"}'::jsonb), (${del}, 'signup', '{}'::jsonb)`;
  await sql`insert into connections (user_id, friend_id) values (${del}, ${ally}), (${ally}, ${del})`;
  await sql`insert into blocks (blocker_id, blocked_id) values (${del}, ${stranger}), (${stranger}, ${del})`;
  await sql`insert into notifications (user_id, kind, actor_id, body) values (${ally}, 'moment_like', ${del}, 'liked your moment'), (${del}, 'join', ${ally}, 'joined your plan')`;
  await sql`insert into otp_codes (email, code_hash, expires_at) values (${'del' + D}, 'hash', now() + interval '10 minutes') on conflict (email) do nothing`;
  await sql`insert into user_photos (user_id, url, position) values (${del}, ${avatar.publicUrl}, 0)`;
  await sql`update chats set topic_updated_by = ${del}, topic = 'Hue in November' where id = ${circleChat}`;

  // A ticketed plan they host, with the UPI id payouts would go to (paid events are switched off, but the column exists).
  hostedPlan = (await sql`insert into activities (host_id, title, category, place_name, location, city, starts_at, is_paid, ticket_price_paise, payout_upi_id)
    values (${del}, 'Citadel photo walk', 'culture', 'Imperial City', ST_SetSRID(ST_MakePoint(107.58, 16.47), 4326)::geography, 'Hue', now() + interval '2 days', true, 20000, ${UPI}) returning id`)[0].id;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await sql`delete from chats where id in (select chat_id from chat_members where user_id in (select id from users where email like ${'%' + D}))`;
  await sql`delete from users where email like ${'%' + D}`;
  await sql`delete from analytics_events where properties->>'planId' = 'x'`;
  await app.close();
  await sql.end();
});

describe('account deletion', () => {
  it('seed sanity: every table the test is about has a row for the user before deletion', async () => {
    const mine: [string, string][] = [['moments', 'user_id'], ['moment_likes', 'user_id'], ['moment_comments', 'user_id'], ['city_tips', 'user_id'], ['city_tip_upvotes', 'user_id'],
      ['activity_comments', 'user_id'], ['activity_photos', 'user_id'], ['activity_photo_reactions', 'user_id'], ['activity_ratings', 'rater_id'], ['saved_activities', 'user_id'],
      ['plan_shares', 'user_id'], ['safety_alerts', 'user_id'], ['user_trusted_contacts', 'user_id'], ['travel_buddy_requests', 'sender_id'], ['travel_buddy_requests', 'recipient_id'],
      ['trip_circle_proposals', 'proposer_id'], ['trip_pass_wallet', 'user_id'], ['trip_pass_redemptions', 'user_id'], ['id_verification_requests', 'user_id'], ['analytics_events', 'user_id'],
      ['connections', 'user_id'], ['blocks', 'blocker_id'], ['notifications', 'user_id'], ['otp_codes', 'email'], ['user_photos', 'user_id'], ['dm_starts', 'user_id'],
      ['chat_members', 'user_id'], ['chat_locations', 'user_id'], ['chat_poll_votes', 'user_id'], ['message_reactions', 'user_id'], ['activity_members', 'user_id']];
    for (const [t, c] of mine) expect(await count(t, c, c === 'email' ? 'del' + D : id.del), `${t}.${c}`).toBeGreaterThan(0);
    for (const k of files) expect(exists(k), k).toBe(true);
  });

  it('exploit: after DELETE /me no row, file or contact detail of the person is left in any table', async () => {
    expect((await u.del('DELETE', '/me')).statusCode).toBe(200);
    const del = id.del;
    const gone: [string, string][] = [['moments', 'user_id'], ['moment_likes', 'user_id'], ['moment_comments', 'user_id'], ['city_tips', 'user_id'], ['city_tip_upvotes', 'user_id'],
      ['activity_comments', 'user_id'], ['activity_photos', 'user_id'], ['activity_photo_reactions', 'user_id'], ['activity_ratings', 'rater_id'], ['activity_ratings', 'host_id'],
      ['saved_activities', 'user_id'], ['plan_shares', 'user_id'], ['safety_alerts', 'user_id'], ['user_trusted_contacts', 'user_id'],
      ['travel_buddy_requests', 'sender_id'], ['travel_buddy_requests', 'recipient_id'], ['trip_circle_proposals', 'proposer_id'],
      ['trip_pass_redemptions', 'user_id'], ['id_verification_requests', 'user_id'], ['analytics_events', 'user_id'],
      ['connections', 'user_id'], ['connections', 'friend_id'], ['blocks', 'blocker_id'], ['blocks', 'blocked_id'], ['notifications', 'user_id'], ['notifications', 'actor_id'],
      ['user_photos', 'user_id'], ['dm_starts', 'user_id'], ['chat_members', 'user_id'], ['chat_locations', 'user_id'], ['chat_poll_votes', 'user_id'],
      ['message_reactions', 'user_id'], ['activity_members', 'user_id'], ['profile_prompts', 'user_id'], ['push_tokens', 'user_id']];
    for (const [t, c] of gone) expect(await count(t, c, del), `${t}.${c}`).toBe(0);
    expect(await count('otp_codes', 'email', 'del' + D)).toBe(0);

    // Their things in other people's content go too, and counters follow.
    expect(await count('moments', 'id', delMoment)).toBe(0);
    expect(await count('moment_likes', 'moment_id', allyMoment)).toBe(0);
    expect(await count('moment_comments', 'moment_id', allyMoment)).toBe(0);
    expect((await sql`select helpful_count from city_tips where id = ${allyTip}`)[0].helpfulCount).toBe(0);
    expect(await count('city_tips', 'id', delTip)).toBe(0);
    expect((await sql`select votes from trip_circle_proposals where id = ${allyProposal}`)[0].votes).toEqual([id.ally]);
    expect((await sql`select topic_updated_by from chats where id = ${circleChat}`)[0].topicUpdatedBy).toBeNull();
    expect(await count('activity_photo_reactions', 'photo_id', allyPhoto)).toBe(0);

    // Chat leftovers: voice note, poll (and its votes), live location, text.
    for (const m of [msgVoice, msgPoll, msgLive]) {
      expect(await count('chat_voice_notes', 'message_id', String(m))).toBe(0);
      expect(await count('chat_polls', 'message_id', String(m))).toBe(0);
      expect(await count('chat_poll_votes', 'message_id', String(m))).toBe(0);
      expect(await count('chat_locations', 'message_id', String(m))).toBe(0);
    }
    const msgs = await sql`select body, kind from messages where sender_id = ${del}`;
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.every(m => m.body === '[deleted]' && m.kind === 'text')).toBe(true);
    expect((await sql`select body from messages where id = ${allyMsg}`)[0].body).toBe('see you there');   // other people's words stay

    // DM: the never-accepted request is gone entirely; the accepted conversation stays, blanked on their side.
    expect((await sql`select count(*)::int as n from chats c where c.kind = 'dm' and exists (select 1 from chat_members m where m.chat_id = c.id and m.user_id = ${id.stranger})`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from chats c where c.kind = 'dm' and exists (select 1 from chat_members m where m.chat_id = c.id and m.user_id = ${id.host})`)[0].n).toBe(1);

    // Wallet: the free grant is gone; the paid purchase record stays (tax), emptied, on the anonymised account.
    expect((await sql`select source, passes_remaining, order_id from trip_pass_wallet where user_id = ${del}`)).toEqual([{ source: 'purchase_single', passesRemaining: 0, orderId: 'order_acctdel' }]);

    // The account row: no contact details, ID or preferences that identify them.
    const [row] = await sql`select email, name, instagram, emergency_contact_name, emergency_contact_phone, travel_style, id_verified, id_verification_status, trip_passes_available, boosted_until, here_now_status, bio, photo_url, attribution from users where id = ${del}`;
    expect(row.email).toBe(`deleted-${del}@deleted.tablamigo`);
    expect(row).toMatchObject({ name: 'Deleted user', instagram: null, emergencyContactName: null, emergencyContactPhone: null, travelStyle: [], idVerified: false, idVerificationStatus: 'none', tripPassesAvailable: 0, boostedUntil: null, hereNowStatus: null, bio: null, photoUrl: null });
    // The sign-up channel stays for the admin's per-source counts; the IP and referring address go.
    expect(row.attribution?.ip).toBeUndefined();
    expect(row.attribution?.referrer).toBeUndefined();

    // A plan they hosted stays on record as cancelled, without the UPI id payouts would have gone to.
    expect((await sql`select status, payout_upi_id, is_paid from activities where id = ${hostedPlan}`)[0]).toEqual({ status: 'cancelled', payoutUpiId: null, isPaid: true });

    // Analytics keep their counts without pointing at anyone.
    expect((await sql`select count(*)::int as n from analytics_events where properties->>'planId' = 'x'`)[0].n).toBe(0);   // properties wiped
    expect((await sql`select count(*)::int as n from analytics_events where user_id is null and event_name = 'signup' and created_at > now() - interval '5 minutes'`)[0].n).toBeGreaterThan(0);   // rows kept, unlinked

    // Uploaded files are removed from storage.
    for (const k of files) expect(exists(k), k).toBe(false);
  });

  it('exploit: nothing the person typed or was identified by is left in any table, found by searching every row of every table', async () => {
    // The foreign-key sweep below only sees columns that point at users. This one doesn't care how a table is built: it looks
    // for the person's own words and identifiers in the text of every row of every table (the UPI id on a hosted plan was
    // found this way: payout_upi_id is a plain text column). Kept on purpose, with their reason: the log of service emails
    // (it holds the address the deletion confirmation went to), support tickets and replies, and reports.
    const KEPT = new Set(['email_log', 'support_tickets', 'support_replies', 'reports', 'schema_migrations', 'spatial_ref_sys']);
    const needles = ['del' + D, PHONE_DEL, PHONE_TRUSTED, `del_gram_${RUN}`, UPI, ...['my number is private', 'bringing a friend', 'ask about her sister',
      'felt unsafe', 'bridge at dusk', 'Boat at 6', 'ask for Linh', 'Citadel walk', 'Priya'].map(SAY)].map(n => `%${n}%`);
    const tables = (await sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`).map(t => t.tableName as string);
    expect(tables.length).toBeGreaterThan(40);   // the sweep really sees the schema
    const found: string[] = [];
    for (const t of tables) {
      if (KEPT.has(t)) continue;
      const n = (await sql.unsafe(`select count(*)::int as n from "${t}" r where r::text ilike any($1)`, [needles]))[0].n as number;
      if (n) found.push(`${t}: ${n} row(s)`);
    }
    expect(found, 'tables still holding the deleted person\'s words or identifiers').toEqual([]);
  });

  it('every table that points at users is either cleared on deletion or on this list of records kept on purpose', async () => {
    // Kept on purpose: billing/purchase records (subscriptions, passes, paid Trip Pass orders, tickets), support and moderation history, hosted plans (cancelled, not erased),
    // revoked token rows, and rows owned by other people that merely reference the user.
    const KEPT = new Set(['refresh_tokens.user_id', 'trip_pass_wallet.user_id', 'activities.host_id', 'subscriptions.user_id', 'passes.user_id', 'activity_tickets.user_id', 'email_log.user_id',
      'support_tickets.user_id', 'support_replies.admin_id', 'reports.reporter_id', 'messages.sender_id', 'users.referred_by', 'activity_tickets.checked_in_by',
      'verification_requests.reviewed_by', 'id_verification_requests.reviewed_by']);
    const fks = await sql`select conrelid::regclass::text as tbl, a.attname as col from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'f' and c.confrelid = 'users'::regclass`;
    const leftovers: string[] = [];
    for (const { tbl, col } of fks) {
      if (KEPT.has(`${tbl}.${col}`)) continue;
      if (await count(tbl, col, id.del)) leftovers.push(`${tbl}.${col}`);
    }
    expect(leftovers, 'tables still holding rows for the deleted user').toEqual([]);
    // The kept tokens are all revoked.
    expect((await sql`select count(*)::int as n from refresh_tokens where user_id = ${id.del} and revoked_at is null`)[0].n).toBe(0);
  });
});
