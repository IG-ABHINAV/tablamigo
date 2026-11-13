/**
 * The Plus welcome: when a subscription first becomes active (Google Play verify or RTDN, Razorpay webhook or sync, whichever
 * wrote it to `subscriptions`), the person gets one DM from the Tablamigo Host and one email: what Plus gives them, read from
 * LIMITS (lib/plus.ts) so it can never promise something the code doesn't do, the next step for their trips, and a link to the
 * Plus page. The receipt (lib/emails/jobs.ts plus_started) stays a separate, transactional email.
 *
 * Once per subscription: plus_welcomes is claimed (purchase token) before anything is sent. Not for a Play plan change or
 * resubscribe (a token that replaces one of their own, linkedPurchaseToken), not when they had a welcome in the last 30 days,
 * not for subscriptions that existed before migration 069, and never while everything is free (nothing is sold then).
 * The email is in the 'activity' category, so email_prefs opt-outs apply.
 *
 * PLUS_WELCOME (config.plusWelcome): 'off' | 'dry' (log only) | 'on'. The scheduler runs it every minute.
 */
import { sql } from './db.js';
import { config, type Mode } from './config.js';
import { clock } from './clock.js';
import { LIMITS } from './plus.js';
import { getHost } from './host.js';
import { deliver } from './emails/send.js';
import { firstName, fmtRange } from './emails/templates.js';
import type { Email } from './emails/layout.js';
import { overlapping } from './trip-match.js';
import { appLink, postAsTeam, realTraveller } from './team-dm.js';
import { recordInApp } from './ladder.js';

const ACTIVE = 'SUBSCRIPTION_STATE_ACTIVE';
export const RECENT_WELCOME_DAYS = 30;

const F = LIMITS.free, P = LIMITS.plus;
const n = (x: number) => x === Infinity ? 'unlimited' : String(x);
/** What Plus gives, each line from LIMITS. Exported for the consistency test. */
export function plusPerks(hinglish = false): string[] {
  return hinglish ? [
    `Aapki trip dates pe sabko dekho (free mein sirf ${F.overlapPreview})`,
    `City chat landing se ${P.cityChatDaysAhead} din pehle join karo (free: ${F.cityChatDaysAhead} din)`,
    `Roz ${n(P.dmStartsPerDay)} naye DMs (free: ${F.dmStartsPerDay})`,
    'Trip lists mein aapka profile pehle dikhta hai',
    'Kisne aapka profile dekha, woh dekho',
    `Roz ${P.activitiesPerDay} plans post karo (free: ${F.activitiesPerDay})`,
    'Incognito browsing aur 24 ghante ka profile Boost',
  ] : [
    `See everyone on your trip dates (free accounts see ${F.overlapPreview})`,
    `Join a city chat up to ${P.cityChatDaysAhead} days before you land (free: ${F.cityChatDaysAhead})`,
    `Start ${n(P.dmStartsPerDay)} new DMs a day (free: ${F.dmStartsPerDay})`,
    'Your profile is listed first on other travellers\' trip lists',
    'See who viewed your profile',
    `Post up to ${P.activitiesPerDay} plans a day (free: ${F.activitiesPerDay})`,
    'Browse in incognito and boost your profile for 24 hours',
  ];
}

export type NextTrip = { id: string; city: string; startDate: string; endDate: string; others: number };
export type WelcomeText = { name: string | null; hinglish: boolean; trips: NextTrip[] };

function nextSteps(d: WelcomeText): string[] {
  const H = d.hinglish;
  if (!d.trips.length) return [H ? `Apni agli trip add karo, aur jab koi aur usi city mein unhi dates pe hoga hum aapko bata denge: ${appLink('/trip/new')}`
    : `Add your next trip and we'll tell you when someone will be in the same city on your dates: ${appLink('/trip/new')}`];
  return d.trips.map(t => {
    const when = fmtRange(t.startDate, t.endDate), link = appLink(`/trip/${t.id}`);
    if (t.others > 0) return H ? `${t.city} (${when}): ${t.others} aur traveller${t.others === 1 ? '' : 's'} aapki dates pe. Sab yahan dekho: ${link}`
      : `${t.city} (${when}): ${t.others} other traveller${t.others === 1 ? ' is' : 's are'} there on your dates. See them all: ${link}`;
    return H ? `${t.city} (${when}): abhi tak koi aur nahi. City chat abhi join karo aur ek plan post karo, jo bhi aayega use dikhega: ${link}`
      : `${t.city} (${when}): nobody else has added it yet. Join the city chat now and post a plan, so whoever comes next sees it: ${link}`;
  });
}

/** The DM. Pure. */
export function renderPlusWelcome(d: WelcomeText): string {
  const H = d.hinglish;
  return [
    H ? `Tablamigo Plus mein welcome, ${firstName(d.name)} 🎉 Subscribe karne ke liye thank you. Ab yeh sab aapke paas hai:`
      : `Welcome to Tablamigo Plus, ${firstName(d.name)} 🎉 Thanks for subscribing. Here's what you have now:`,
    plusPerks(H).map(p => `• ${p}`).join('\n'),
    (H ? 'Aage kya karein:\n' : 'What to do next:\n') + nextSteps(d).map(s => `• ${s}`).join('\n'),
    H ? `Plus ki saari details: ${appLink('/paywall')}\nKoi sawaal ho toh yahin reply karo, team ka koi insaan jawab dega.`
      : `Everything in Plus: ${appLink('/paywall')}\nQuestions? Reply here and a person from the team will answer.`,
  ].join('\n\n');
}

/** The email. Pure. */
export function plusWelcomeEmail(d: WelcomeText): Email {
  const steps = nextSteps({ ...d, hinglish: false }).map(s => s.replace(/: https?:\/\/\S+$/, '.'));
  return {
    subject: `Welcome to Plus, ${firstName(d.name)}`, category: 'activity',
    preheader: 'What Plus gives you, and the best next step for your trip.',
    blocks: [
      { t: 'eyebrow', text: 'Tablamigo Plus' },
      { t: 'h1', text: `Welcome to Plus, ${firstName(d.name)}` },
      { t: 'p', text: 'Thanks for subscribing. Here is what you have now:' },
      { t: 'list', items: plusPerks(false) },
      { t: 'p', text: '**What to do next**' },
      { t: 'list', items: steps },
      { t: 'button', label: d.trips.length ? `Open your ${d.trips[0].city} trip` : 'Add your next trip', url: d.trips.length ? appLink(`/trip/${d.trips[0].id}`) : appLink('/trip/new') },
      { t: 'small', text: `Everything in Plus, and how to manage it: [the Plus page](${appLink('/paywall')}).` },
    ],
  };
}

/** Up to 2 upcoming trips, with how many other people are on each (the same list the trip screen shows). */
export async function tripsFor(userId: string): Promise<NextTrip[]> {
  const rows = await sql`select id, city, city_key, start_date::text as start_date, end_date::text as end_date from trips
    where user_id = ${userId} and end_date >= current_date order by start_date limit 2`;
  const out: NextTrip[] = [];
  for (const t of rows) out.push({ id: t.id, city: t.city, startDate: t.startDate, endDate: t.endDate, others: (await overlapping(userId, t.cityKey, t.startDate, t.endDate)).length });
  return out;
}

const dryLogged = new Set<string>();
export type PlusWelcomeTally = { mode: Mode; sent: number; skipped: number; failed: number; planned: number };

export async function processPlusWelcomes(now: Date = clock.now(), o: { mode?: Mode; dryLog?: Set<string> } = {}): Promise<PlusWelcomeTally> {
  const mode = o.mode ?? config.plusWelcome;
  const t: PlusWelcomeTally = { mode, sent: 0, skipped: 0, failed: 0, planned: 0 };
  if (mode === 'off' || config.allFree) return t;
  const subs = await sql`select s.purchase_token, s.user_id, u.name, u.home_country,
      exists (select 1 from subscriptions l where l.purchase_token = s.raw->>'linkedPurchaseToken' and l.user_id = s.user_id) as plan_change,
      exists (select 1 from plus_welcomes w where w.user_id = s.user_id and w.status = 'sent'
        and w.created_at > ${now}::timestamptz - ${RECENT_WELCOME_DAYS + ' days'}::interval) as recent
    from subscriptions s join users u on u.id = s.user_id
    where s.status = ${ACTIVE} and s.expires_at > ${now} and s.updated_at > ${now}::timestamptz - interval '3 days'
      and ${realTraveller('u')}
      and not exists (select 1 from plus_welcomes w where w.purchase_token = s.purchase_token)
    order by s.updated_at limit 20`;
  if (!subs.length) return t;
  const host = await getHost();
  for (const s of subs) {
    if (mode === 'dry') {
      const logged = o.dryLog ?? dryLogged;
      if (!logged.has(s.purchaseToken)) { logged.add(s.purchaseToken); console.log(`plus welcome (dry): user=${s.userId}`); t.planned++; }
      continue;
    }
    const skip = s.planChange ? 'plan_change' : s.recent ? 'recent' : !host ? 'no_host' : null;
    const [claim] = await sql`insert into plus_welcomes (purchase_token, user_id, status, reason, created_at) values (${s.purchaseToken}, ${s.userId}, ${skip ? 'skipped' : 'pending'}, ${skip}, ${now})
      on conflict (purchase_token) do nothing returning purchase_token`;
    if (!claim) continue;
    if (skip) { t.skipped++; continue; }
    try {
      const text: WelcomeText = { name: s.name, hinglish: s.homeCountry === 'IN', trips: await tripsFor(s.userId) };
      const dm = await postAsTeam(host!, s.userId, renderPlusWelcome(text));
      if (dm.status === 'sent') await recordInApp(s.userId, 'plus_welcome', s.purchaseToken, { chatId: dm.chatId, messageId: dm.messageId });
      // Asked for in both channels: the email goes now (opt-outs apply), not only as a fallback.
      await deliver({ kind: 'plus_welcome', userId: s.userId, periodKey: s.purchaseToken, build: u => plusWelcomeEmail({ ...text, name: u.name }) });
      await sql`update plus_welcomes set status = 'sent', sent_at = now(), chat_id = ${dm.chatId}, message_id = ${dm.status === 'sent' ? dm.messageId : null},
        reason = ${dm.status === 'declined' ? 'dm_declined' : null} where purchase_token = ${s.purchaseToken}`;
      console.log(`plus welcome: sent to user=${s.userId}`);
      t.sent++;
    } catch (e) {
      const err = String((e as Error)?.message ?? e).slice(0, 300);
      await sql`update plus_welcomes set status = 'failed', reason = ${err} where purchase_token = ${s.purchaseToken}`.catch(() => {});
      console.error('plus welcome failed', s.userId, err);
      t.failed++;
    }
  }
  return t;
}
