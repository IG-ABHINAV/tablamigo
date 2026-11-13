/**
 * Every customer email Tablamigo sends. Templates are pure: data in, blocks out (see layout.ts).
 * Copy rules: short and warm, subjects under ~50 characters, numbers instead of adjectives, no fake urgency.
 */
import { config } from '../config.js';
import { LIMITS } from '../plus.js';
import type { Block, Email, Person } from './layout.js';

export const appUrl = (path = '/') => `${config.siteUrl}/app${path}`;
const PLAY_SUBS = 'https://play.google.com/store/account/subscriptions?package=com.tablamigo.app';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const asDate = (d: Date | string) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T00:00:00Z') : new Date(d);

/** "Fri 3 Oct 2026" in UTC: we don't store a time zone per user, so no clock times in emails. */
export const fmtDate = (d: Date | string) => { const x = asDate(d); return `${DAY[x.getUTCDay()]} ${x.getUTCDate()} ${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}`; };
/** "3–10 Oct" or "28 Sep – 4 Oct". */
export const fmtRange = (a: string, b: string) => {
  const x = asDate(a), y = asDate(b);
  return x.getUTCMonth() === y.getUTCMonth() ? `${x.getUTCDate()}–${y.getUTCDate()} ${MON[y.getUTCMonth()]}` : `${x.getUTCDate()} ${MON[x.getUTCMonth()]} – ${y.getUTCDate()} ${MON[y.getUTCMonth()]}`;
};
export const money = (minor: number, currency = 'INR') => currency === 'INR'
  ? `₹${(minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
  : `${currency} ${(minor / 100).toFixed(2)}`;
export const firstName = (name?: string | null) => name?.trim().split(/\s+/)[0] || 'there';
const days = (until: Date, now = new Date()) => Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 86400_000));
const inDays = (n: number) => n === 1 ? 'tomorrow' : `in ${n} days`;

const F = LIMITS.free, P = LIMITS.plus;
const PERKS = [
  'See who viewed your profile',
  `Post up to ${P.activitiesPerDay} plans a day (free: ${F.activitiesPerDay})`,
  `See everyone on your trip dates (free: ${F.overlapPreview})`,
  `Join city chats up to ${P.cityChatDaysAhead} days before you land (free: ${F.cityChatDaysAhead})`,
];
const LOSE = `After that you're back on the free plan: ${F.activitiesPerDay} plans a day, a preview of ${F.overlapPreview} people per trip, and no profile viewers.`;

export function loginCode(d: { code: string }): Email {
  return {
    subject: `${d.code} is your Tablamigo code`, category: 'transactional',
    preheader: 'Enter it in the app to sign in. It expires in 10 minutes.',
    blocks: [
      { t: 'h1', text: 'Your sign-in code' },
      { t: 'p', text: 'Enter this code in Tablamigo to sign in. It expires in 10 minutes.' },
      { t: 'code', text: d.code },
      { t: 'small', text: `Didn't ask for a code? You can ignore this email; nobody can sign in without it.` },
    ],
  };
}

export function welcome(d: { name?: string | null }): Email {
  return {
    subject: `Welcome to Tablamigo, ${firstName(d.name)}`, category: 'transactional',
    preheader: 'Three things to do first, each takes under a minute.',
    blocks: [
      { t: 'eyebrow', text: 'Welcome' },
      { t: 'h1', text: `Glad you're here, ${firstName(d.name)}` },
      { t: 'p', text: 'Tablamigo helps you find people to eat, explore and hang out with while you travel. Three things to do first:' },
      { t: 'list', items: [
        '**Add your next trip.** See who else will be in that city on your dates.',
        '**Join a plan nearby, or post one.** Dinner, drinks, a day trip: people join with one tap.',
        '**Get verified.** One selfie with a pose, checked in seconds. Your profile gets a tick.',
      ] },
      { t: 'button', label: 'Open Tablamigo', url: appUrl('/') },
      { t: 'small', text: 'Meet in busy public places and keep chats in the app until you know someone. More in our [safety guide](https://tablamigo.hookstep.in/safety).' },
    ],
  };
}

/** A Plus period or base plan id as people read it: "monthly", "yearly", and "6-month" for halfyearly. */
export const periodName = (period: string) => period === 'halfyearly' ? '6-month' : period;

export type Purchase = {
  name?: string | null; kind: 'subscription' | 'pass'; platform: 'google' | 'razorpay';
  period?: string | null; amount?: string | null; orderId?: string | null; startedAt: Date; until: Date | null;
};
export function plusStarted(d: Purchase): Email {
  const via = d.platform === 'google' ? 'Google Play' : 'Razorpay';
  const pass = d.kind === 'pass';
  const plan = pass ? 'Trip Pass · 14 days' : `Plus · ${d.period ? periodName(d.period) : 'subscription'}`;
  const rows: [string, string][] = [['Plan', plan]];
  if (d.amount) rows.push(['Amount', d.amount]);
  rows.push(['Paid with', via], ['Date', fmtDate(d.startedAt)]);
  if (d.until) rows.push([pass ? 'Plus until' : 'Renews on', fmtDate(d.until)]);
  if (d.orderId) rows.push([pass ? 'Payment ID' : 'Reference', d.orderId]);
  return {
    subject: pass ? 'Your Trip Pass receipt' : 'Your Tablamigo Plus receipt', category: 'transactional',
    preheader: pass ? `14 days of Plus${d.until ? `, until ${fmtDate(d.until)}` : ''}. No renewal.` : `Plus is on${d.until ? ` and renews on ${fmtDate(d.until)}` : ''}.`,
    blocks: [
      { t: 'eyebrow', text: 'Receipt' },
      { t: 'h1', text: pass ? 'Your Trip Pass is active' : `You're on Plus` },
      { t: 'p', text: `Thanks, ${firstName(d.name)}. Here are the details for your records.` },
      { t: 'rows', rows },
      { t: 'p', text: '**What Plus unlocks**' },
      { t: 'list', items: PERKS },
      { t: 'button', label: 'Open Tablamigo', url: appUrl('/') },
      { t: 'small', text: pass
        ? `A Trip Pass doesn't renew; it simply ends. Buying another adds 14 more days.`
        : d.platform === 'google'
          ? `Manage or cancel anytime in [Google Play subscriptions](${PLAY_SUBS}). Google also sends its own receipt with tax details.`
          : `Cancel anytime in the app under Profile → Plus; you keep Plus until the end of the paid period. Razorpay also emails a payment receipt.` },
    ],
  };
}

export function paymentProblem(d: { name?: string | null; platform: 'google' | 'razorpay'; onHold: boolean; until?: Date | null }): Email {
  const fix = d.platform === 'google'
    ? { label: 'Update payment in Google Play', url: PLAY_SUBS, where: 'in Google Play' }
    : { label: 'Update payment', url: appUrl('/paywall'), where: 'in the app under Profile → Plus' };
  return d.onHold ? {
    subject: 'Plus is paused: your payment failed', category: 'transactional',
    preheader: 'Update your payment method and Plus switches back on.',
    blocks: [
      { t: 'h1', text: 'Plus is paused' },
      { t: 'p', text: `Hi ${firstName(d.name)}, we couldn't collect your Plus renewal after several tries, so Plus is paused. Nothing else about your account has changed.` },
      { t: 'p', text: `Update your payment method ${fix.where} and Plus switches back on straight away.` },
      { t: 'button', label: fix.label, url: fix.url },
      { t: 'small', text: `If you meant to stop Plus, there's nothing to do. You won't be charged.` },
    ],
  } : {
    subject: `Your Plus payment didn't go through`, category: 'transactional',
    preheader: 'Plus is still on while the payment is retried.',
    blocks: [
      { t: 'h1', text: `Your Plus payment didn't go through` },
      { t: 'p', text: `Hi ${firstName(d.name)}, your latest Plus renewal was declined. Plus stays on while ${d.platform === 'google' ? 'Google Play' : 'Razorpay'} retries the payment over the next few days.` },
      { t: 'p', text: `To avoid a gap, check your card or UPI mandate ${fix.where}.` },
      { t: 'button', label: fix.label, url: fix.url },
      { t: 'small', text: `If you meant to stop Plus, you can ignore this; it will end on its own.` },
    ],
  };
}

export function plusEndingSoon(d: { name?: string | null; until: Date; source: 'subscription' | 'comp'; now?: Date }): Email {
  const n = days(d.until, d.now);
  return {
    subject: `Your Plus ends ${inDays(n)}`, category: 'reminders',
    preheader: `Plus stays on until ${fmtDate(d.until)}.`,
    blocks: [
      { t: 'h1', text: `Your Plus ends on ${fmtDate(d.until)}` },
      { t: 'p', text: d.source === 'comp'
        ? `Hi ${firstName(d.name)}, the complimentary Plus we gave you runs out ${inDays(n)}. Thanks for trying it.`
        : `Hi ${firstName(d.name)}, your Plus is set not to renew, so it stops ${inDays(n)}.` },
      { t: 'p', text: LOSE },
      { t: 'button', label: 'Keep Plus', url: appUrl('/paywall') },
      { t: 'small', text: `Happy to let it end? There's nothing to do.` },
    ],
  };
}

/** What Plus costs to continue after the launch offer, already formatted ("₹499"): the web prices, see lib/razorpay.ts. */
export type Prices = { monthly: string; yearly: string };
const PRICES_NOTE = `Prices are for the website and the web app. The Android app shows Google Play's price at checkout.`;

/**
 * The launch offer (Plus free for everyone) ends soon, for an account whose only Plus is the offer: no subscription, no pass.
 * Nothing here is a renewal: the offer just ends, and Plus costs what it costs to continue.
 */
export function launchOfferEnding(d: { name?: string | null; until: Date; prices: Prices; now?: Date }): Email {
  const n = days(d.until, d.now);
  return {
    subject: `Your free Plus ends ${inDays(n)}`, category: 'reminders',
    preheader: `The launch offer ends on ${fmtDate(d.until)}.`,
    blocks: [
      { t: 'h1', text: `The launch offer ends on ${fmtDate(d.until)}` },
      { t: 'p', text: `Hi ${firstName(d.name)}, Plus has been free for everyone since we launched. The offer ends ${inDays(n)}, and your Plus ends with it.` },
      { t: 'p', text: `To keep Plus: **${d.prices.monthly} a month** or **${d.prices.yearly} a year**. Otherwise you're back on the free plan: ${F.activitiesPerDay} plans a day, a preview of ${F.overlapPreview} people per trip, and no profile viewers.` },
      { t: 'button', label: 'Keep Plus', url: appUrl('/paywall') },
      { t: 'small', text: `Happy to go back to the free plan? There's nothing to do, and you won't be charged.` },
      { t: 'small', text: PRICES_NOTE },
    ],
  };
}

/** The launch offer has ended, for an account whose only Plus was the offer. */
export function launchOfferEnded(d: { name?: string | null; prices: Prices }): Email {
  return {
    subject: 'The Tablamigo launch offer has ended', category: 'reminders',
    preheader: 'Your account, chats and trips are all still here.',
    blocks: [
      { t: 'h1', text: 'The launch offer has ended' },
      { t: 'p', text: `Hi ${firstName(d.name)}, Plus was free for everyone while we launched. That period is over, so you're back on the free plan. Your profile, chats, trips and plans are all still here.` },
      { t: 'p', text: `On the free plan you can post ${F.activitiesPerDay} plans a day and see a preview of ${F.overlapPreview} people per trip. To bring Plus back: **${d.prices.monthly} a month** or **${d.prices.yearly} a year**.` },
      { t: 'button', label: 'See Plus options', url: appUrl('/paywall') },
      { t: 'small', text: PRICES_NOTE },
    ],
  };
}

export function passExpiring(d: { name?: string | null; until: Date; now?: Date }): Email {
  const n = days(d.until, d.now);
  return {
    subject: `Your Trip Pass ends ${inDays(n)}`, category: 'reminders',
    preheader: `Plus stays on until ${fmtDate(d.until)}. Passes never renew by themselves.`,
    blocks: [
      { t: 'h1', text: `Your Trip Pass ends on ${fmtDate(d.until)}` },
      { t: 'p', text: `Hi ${firstName(d.name)}, your 14 days of Plus are nearly up. Passes don't renew, so you won't be charged.` },
      { t: 'p', text: `Still travelling? Another Trip Pass adds 14 days on top of the time you have left.` },
      { t: 'button', label: 'Add 14 days', url: appUrl('/paywall') },
    ],
  };
}

export function plusEnded(d: { name?: string | null; source: 'subscription' | 'pass' | 'comp' }): Email {
  const what = d.source === 'pass' ? 'Trip Pass' : 'Plus';
  return {
    subject: `Your Tablamigo ${what} has ended`, category: 'reminders',
    preheader: 'Your account, chats and trips are all still here.',
    blocks: [
      { t: 'h1', text: `Your ${what} has ended` },
      { t: 'p', text: `Hi ${firstName(d.name)}, you're back on the free plan. Your profile, chats, trips and plans are all still here.` },
      { t: 'p', text: `On the free plan you can post ${F.activitiesPerDay} plans a day and see a preview of ${F.overlapPreview} people per trip.` },
      { t: 'button', label: 'See Plus options', url: appUrl('/paywall') },
    ],
  };
}

/** Plus the user still has from somewhere other than the subscription an email is about. */
export type OtherPlus = { until: Date; source: 'pass' | 'comp' } | null;
const otherPlusLine = (o: OtherPlus) => o
  ? `You still have Plus until **${fmtDate(o.until)}** from ${o.source === 'pass' ? 'your Trip Pass' : 'complimentary access'}, so nothing changes for you until then.`
  : null;

/**
 * A web (Razorpay) Plus subscription was cancelled: from the app, or by us in the Razorpay dashboard.
 * `until` is the end of the paid period when Plus runs on until then; null when it has already ended
 * (the period's payment was refunded, or the period was over).
 */
/** `paused`: the customer paused the mandate at their bank or UPI app; we don't pause subscriptions, so it is cancelled (SC-16). */
export function plusCancelled(d: { name?: string | null; period?: string | null; until: Date | null; endedAt?: Date; otherPlus?: OtherPlus; paused?: boolean }): Email {
  const plan = `Plus · ${d.period ? periodName(d.period) : 'subscription'}`;
  const other = otherPlusLine(d.otherPlus ?? null);
  return {
    subject: 'Your Plus subscription is cancelled', category: 'transactional',
    preheader: d.until ? `Plus stays on until ${fmtDate(d.until)}. You won't be charged again.` : `You won't be charged again.`,
    blocks: [
      { t: 'eyebrow', text: 'Plus' },
      { t: 'h1', text: 'Your Plus subscription is cancelled' },
      { t: 'p', text: d.paused
        ? `Hi ${firstName(d.name)}, your payment mandate for Tablamigo Plus was paused at your bank or UPI app. We can't pause a subscription, so we've cancelled it and you won't be charged again.`
        : `Hi ${firstName(d.name)}, your Tablamigo Plus subscription is cancelled and you won't be charged again.` },
      { t: 'rows', rows: [
        ['Plan', plan],
        d.until ? ['Plus until', fmtDate(d.until)] : ['Ended', fmtDate(d.endedAt ?? new Date())],
        ['Future charges', 'None'],
      ] },
      { t: 'p', text: d.until
        ? `You keep every Plus feature until **${fmtDate(d.until)}**, the end of the period you paid for. ${LOSE}`
        : `Plus from this subscription has ended. ${other ? '' : `You're on the free plan: ${F.activitiesPerDay} plans a day and a preview of ${F.overlapPreview} people per trip. Your profile, chats and trips are all still here.`}`.trim() },
      ...(other ? [{ t: 'p', text: other } as const] : []),
      { t: 'button', label: 'Get Plus again', url: appUrl('/paywall') },
      { t: 'small', text: 'Cancelled by mistake? You can subscribe again anytime in the app under Profile → Plus.' },
    ],
  };
}

/**
 * A web (Razorpay) payment was refunded: a Plus subscription payment or a Trip Pass.
 * `plus` says what happened to the thing that was bought, so nobody has to guess.
 */
export function refundIssued(d: {
  name?: string | null; amount: string; refundId: string; paymentId?: string | null; refundedAt: Date;
  what: 'subscription' | 'pass'; period?: string | null; plus: 'ended' | 'active'; renewsOn?: Date | null; otherPlus?: OtherPlus;
}): Email {
  const item = d.what === 'pass' ? 'Trip Pass' : `Plus · ${d.period ? periodName(d.period) : 'subscription'}`;
  const rows: [string, string][] = [['Amount', d.amount], ['For', item], ['Refund ID', d.refundId]];
  if (d.paymentId) rows.push(['Original payment', d.paymentId]);
  rows.push(['Date', fmtDate(d.refundedAt)]);
  const status = d.what === 'pass'
    ? 'Your Trip Pass is cancelled, so its Plus days have ended.'
    : d.plus === 'ended'
      ? `Your Plus subscription is cancelled and its Plus has ended. You won't be charged again.`
      : `Your Plus subscription stays active${d.renewsOn ? ` and renews on **${fmtDate(d.renewsOn)}**` : ''}. Nothing else changes.`;
  const other = d.plus === 'ended' ? otherPlusLine(d.otherPlus ?? null) : null;
  return {
    subject: `Your refund of ${d.amount} is on its way`, category: 'transactional',
    preheader: 'It usually reaches your bank in 5–7 working days.',
    blocks: [
      { t: 'eyebrow', text: 'Refund' },
      { t: 'h1', text: `Your refund of ${d.amount} is on its way` },
      { t: 'p', text: `Hi ${firstName(d.name)}, we've refunded **${d.amount}** to the payment method you paid with. It usually reaches your bank in 5–7 working days; the exact time depends on your bank.` },
      { t: 'rows', rows },
      { t: 'p', text: status },
      ...(other ? [{ t: 'p', text: other } as const] : []),
      ...(d.plus === 'ended' && !other ? [{ t: 'button', label: 'See Plus options', url: appUrl('/paywall') } as const] : []),
      { t: 'small', text: `Not in your account after 7 working days? Reply with the refund ID above and we'll chase it with Razorpay.` },
    ],
  };
}

/**
 * A web renewal failed and Razorpay stopped retrying (SC-05): the subscription is cancelled and its Plus has ended, because the
 * period was never paid. Subscribing again starts a new one.
 */
export function plusPaymentStopped(d: { name?: string | null; period?: string | null; otherPlus?: OtherPlus }): Email {
  const other = otherPlusLine(d.otherPlus ?? null);
  return {
    subject: `Your Plus renewal didn't go through`, category: 'transactional',
    preheader: `We couldn't collect the payment, so Plus has stopped. You won't be charged.`,
    blocks: [
      { t: 'eyebrow', text: 'Plus' },
      { t: 'h1', text: `Your Plus renewal didn't go through` },
      { t: 'p', text: `Hi ${firstName(d.name)}, the payment for your Tablamigo Plus renewal (${d.period ? periodName(d.period) : 'subscription'}) failed several times, so the subscription is cancelled and its Plus has ended. Nothing was charged for the new period, and you won't be charged again.` },
      ...(other ? [{ t: 'p', text: other } as const] : [{ t: 'p', text: `You're on the free plan: ${F.activitiesPerDay} plans a day and a preview of ${F.overlapPreview} people per trip. Your profile, chats and trips are all still here.` } as const]),
      { t: 'button', label: 'Subscribe again', url: appUrl('/paywall') },
      { t: 'small', text: 'You can pay with another card or UPI app when you subscribe again.' },
    ],
  };
}

/**
 * Your bank told us a web payment is disputed (SC-13). Neutral on purpose: it states what changed and how to sort it out,
 * and claims no fee or penalty.
 */
export function billingDisputed(d: { name?: string | null; amount: string | null; paymentId: string }): Email {
  return {
    subject: 'A payment to Tablamigo was disputed', category: 'transactional',
    preheader: 'Plus from web purchases is paused while the dispute is open.',
    blocks: [
      { t: 'eyebrow', text: 'Payments' },
      { t: 'h1', text: 'A payment to Tablamigo was disputed' },
      { t: 'p', text: `Hi ${firstName(d.name)}, your bank has told us that you disputed a payment${d.amount ? ` of **${d.amount}**` : ''} to Tablamigo. While the dispute is open, Plus from purchases on the website is off and new web purchases are paused. Your profile, chats and trips are unchanged.` },
      { t: 'rows', rows: [['Payment', d.paymentId]] },
      { t: 'p', text: `If this was a mistake, reply to this email and we'll help you sort it out with your bank.` },
    ],
  };
}

export function verification(d: { name?: string | null; approved: boolean; reason?: string | null }): Email {
  return d.approved ? {
    subject: `You're verified on Tablamigo`, category: 'transactional',
    preheader: 'Your profile now shows the verified tick.',
    blocks: [
      { t: 'eyebrow', text: 'Verification' },
      { t: 'h1', text: `You're verified, ${firstName(d.name)}` },
      { t: 'p', text: 'Your selfie matched your profile photo. Your profile and your plans now show the verified tick, so people know you are who your photos say.' },
      { t: 'button', label: 'See your profile', url: appUrl('/profile') },
    ],
  } : {
    subject: `Your verification photo didn't pass`, category: 'transactional',
    preheader: 'You can try again now; it takes about a minute.',
    blocks: [
      { t: 'h1', text: `Let's try that selfie again` },
      ...(d.reason ? [
        { t: 'p', text: `Hi ${firstName(d.name)}, we couldn't verify your last photo. ${d.reason}` },
      ] satisfies Block[] : [
        { t: 'p', text: `Hi ${firstName(d.name)}, we couldn't verify your last photo. The usual reasons:` },
        { t: 'list', marker: 'dot', items: ['Your face was hard to see (too dark, too far, or covered)', `The pose didn't match the one we asked for`, `It didn't look like your profile photo`] },
      ] satisfies Block[]),
      { t: 'p', text: 'You can send a new selfie now. It is checked automatically in a few seconds, up to 5 tries a day.' },
      { t: 'button', label: 'Try again', url: appUrl('/verify') },
    ],
  };
}

export function planJoined(d: { name?: string | null; plan: { id: string; title: string; placeName?: string | null }; joiners: Person[]; total: number }): Email {
  const who = d.joiners[0]?.name ?? 'Someone';
  const n = d.joiners.length;
  const title = d.plan.title.length > 28 ? d.plan.title.slice(0, 27) + '…' : d.plan.title;
  return {
    subject: n === 1 ? `${who} joined ${title}` : `${n} people joined ${title}`, category: 'activity',
    preheader: `${d.total} ${d.total === 1 ? 'person is' : 'people are'} going now. Say hi in the group chat.`,
    blocks: [
      { t: 'h1', text: n === 1 ? `${who} joined your plan` : `${n} people joined your plan` },
      { t: 'p', text: `**${d.plan.title}**${d.plan.placeName ? ` at ${d.plan.placeName}` : ''} now has ${d.total} ${d.total === 1 ? 'person' : 'people'} going, including you.` },
      { t: 'people', people: d.joiners.slice(0, 3), more: n > 3 ? `and ${n - 3} more` : undefined },
      { t: 'button', label: 'Say hi in the chat', url: appUrl(`/activity/${d.plan.id}`) },
      { t: 'small', text: 'We send at most one of these per plan every 6 hours, and only when you haven\'t opened the app since.' },
    ],
  };
}

export function weeklyDigest(d: { name?: string | null; trip: { id: string; city: string; startDate: string; endDate: string }; travelers: number; plans: number; faces: Person[] }): Email {
  const t = d.travelers, city = d.trip.city;
  const subject = t > 0 ? `${t} ${t === 1 ? 'traveler' : 'travelers'} in ${city} on your dates` : `${d.plans} ${d.plans === 1 ? 'plan' : 'plans'} in ${city} for your trip`;
  return {
    subject, category: 'digest',
    preheader: `Your trip: ${fmtRange(d.trip.startDate, d.trip.endDate)}. Here's who else is going.`,
    blocks: [
      { t: 'eyebrow', text: `Your trip · ${fmtRange(d.trip.startDate, d.trip.endDate)}` },
      { t: 'h1', text: `${city}: who else is going` },
      { t: 'p', text: `Hi ${firstName(d.name)}, here's what's lined up for your trip this week.` },
      { t: 'stats', items: [{ value: String(t), label: t === 1 ? 'traveler on your dates' : 'travelers on your dates' }, { value: String(d.plans), label: d.plans === 1 ? `plan posted in ${city}` : `plans posted in ${city}` }] },
      ...(d.faces.length ? [{ t: 'people', people: d.faces, more: t > d.faces.length ? `and ${t - d.faces.length} more` : undefined } as const] : []),
      { t: 'button', label: `See who's going`, url: appUrl(`/trip/${d.trip.id}`) },
      { t: 'small', text: 'A weekly summary while you have a trip coming up. It stops after your trip.' },
    ],
  };
}

export function accountDeleted(d: { name?: string | null; deletedAt: Date; googleSub: boolean; googleCancelled?: boolean; webSub: boolean; webCancelled?: boolean }): Email {
  const blocks: Email['blocks'] = [
    { t: 'h1', text: 'Your account is deleted' },
    { t: 'p', text: `Hi ${firstName(d.name)}, as you asked, we deleted your Tablamigo account on ${fmtDate(d.deletedAt)}. Your profile, photos, trips and verification selfie are gone, and your chat messages now read "[deleted]".` },
  ];
  if (d.googleCancelled) blocks.push({ t: 'p', text: `**We've cancelled your Google Play subscription.** You won't be charged again. Google sends its own confirmation.` });
  if (d.googleSub) blocks.push({ t: 'p', text: `**Your Google Play subscription is still active.** Deleting the account doesn't stop it. Cancel it in [Google Play subscriptions](${PLAY_SUBS}).` });
  if (d.webCancelled) blocks.push({ t: 'p', text: `**We've cancelled your web Plus subscription.** You won't be charged again.` });
  if (d.webSub) blocks.push({ t: 'p', text: `**Your web Plus subscription is still set to renew.** Reply to this email and we'll cancel it for you.` });
  blocks.push(
    { t: 'p', text: 'You can come back anytime with the same email. You would start with a fresh, empty profile.' },
    { t: 'small', text: `Didn't ask for this? Reply to this email straight away.` },
  );
  return { subject: 'Your Tablamigo account is deleted', category: 'transactional', preheader: `Deleted on ${fmtDate(d.deletedAt)}. Nothing else to do.`, blocks };
}

export function safetyAlert(d: {
  userName: string;
  planTitle: string;
  placeName: string;
  city: string;
  placeAddress?: string | null;
  mapUrl: string;
  note?: string | null;
  emergencyNumbers: { police: string; ambulance: string; general: string };
}): Email {
  const blocks: Email['blocks'] = [
    { t: 'eyebrow', text: 'Safety Alert' },
    { t: 'h1', text: `Safety Alert from ${d.userName}` },
    { t: 'p', text: `An urgent safety alert was triggered by **${d.userName}** during the meetup **${d.planTitle}** in ${d.city}.` },
    { t: 'p', text: `**Location:** ${d.placeName}${d.placeAddress ? ` · ${d.placeAddress}` : ''}` },
  ];
  if (d.note) {
    blocks.push({ t: 'p', text: `**Message from traveler:** "${d.note}"` });
  }
  blocks.push(
    { t: 'button', label: 'View Location on Map', url: d.mapUrl },
    { t: 'p', text: `**Local Emergency Contact Numbers:**\n• Police: ${d.emergencyNumbers.police}\n• Ambulance: ${d.emergencyNumbers.ambulance}\n• General: ${d.emergencyNumbers.general}` },
    { t: 'small', text: `This is your copy of the safety alert you logged in Tablamigo. Tablamigo doesn't contact anyone for you: call the local numbers above, or send your trusted contacts the ready-made message in the app.` }
  );
  return {
    subject: `🚨 URGENT: Safety Alert from ${d.userName}`,
    category: 'transactional',
    preheader: `${d.userName} triggered a safety alert during ${d.planTitle} in ${d.city}.`,
    blocks
  };
}


// --- activation nudges (lib/emails/activation.ts) ----------------------------------------------
// Facts these rely on, checked in the code on 13 Oct 2026: the verified tick shows on the profile and on plans
// (routes/me.ts, routes/activities.ts); Plus can filter travelers to verified only (GET /travelers verified_only);
// the selfie is camera-only, one pose, checked automatically, 5 tries a day (lib/verification.ts); seeing and
// joining plans is free on every tier (lib/plus.ts); a free account sees a preview of LIMITS.free.overlapPreview
// people per trip.

export function verifyNudge(d: { name?: string | null; second: boolean; hinglish?: boolean }): Email {
  const n = firstName(d.name), hi = !!d.hinglish;
  const why = [
    '**People can see it\'s really you.** Your profile and every plan you post get the verified tick.',
    '**You show up in "verified only" searches.** Plus members can filter travelers to verified people, and without the tick you\'re left out.',
    '**It\'s quick.** Camera only, one pose, checked automatically in a few seconds.',
  ];
  return d.second ? {
    subject: 'Your verified tick is one selfie away', category: 'reminders',
    preheader: 'About a minute, checked automatically. Last reminder about this.',
    blocks: [
      { t: 'h1', text: `Still up for that selfie, ${n}?` },
      { t: 'p', text: `Hi ${n}, your Tablamigo profile doesn't have the verified tick yet. ${hi ? 'Ek selfie' : 'One selfie'}, about a minute, and you're done.` },
      { t: 'list', items: why },
      { t: 'button', label: 'Verify my selfie', url: appUrl('/verify') },
      { t: 'small', text: `This is the last reminder about verification. Joining plans is free either way.` },
    ],
  } : {
    subject: 'One selfie and you\'re verified', category: 'reminders',
    preheader: 'Takes about a minute. Your profile gets the verified tick.',
    blocks: [
      { t: 'eyebrow', text: 'One step left' },
      { t: 'h1', text: `Get your verified tick, ${n}` },
      { t: 'p', text: `Hi ${n}, your profile is set up. ${hi ? 'Bas ek step baaki hai' : 'One step left'}: a quick verification selfie. Here's why it's worth the minute:` },
      { t: 'list', items: why },
      { t: 'button', label: 'Verify my selfie', url: appUrl('/verify') },
      { t: 'small', text: 'Meeting someone from Tablamigo? Pick a busy public place and look for the tick. More in our [safety guide](https://tablamigo.hookstep.in/safety).' },
    ],
  };
}

/** A plan shown in an email. `day` is YYYY-MM-DD on the plan's local calendar. */
export type PlanTeaser = { id: string; title: string; emoji?: string | null; placeName?: string | null; city?: string | null; going: number; day: string };

/** `scope`: where the plans are, see plansFor() in activation.ts (trip city on the trip dates, trip city any date, near the user). */
export function planNudge(d: { name?: string | null; trip: { city: string } | null; scope: 'trip_dates' | 'trip_city' | 'near' | null; plans: PlanTeaser[] }): Email {
  const n = firstName(d.name), k = d.plans.length;
  const items = d.plans.map(p => `**${p.emoji ? p.emoji + ' ' : ''}${p.title}** · ${[p.placeName, p.city].filter(Boolean).join(', ')} · ${fmtDate(p.day)} · ${p.going} going`);
  if (!k) {
    const where = d.trip ? ` in ${d.trip.city}` : ' near you';
    return {
      subject: d.trip ? `Be the first plan in ${d.trip.city}` : 'Post a plan, people join with one tap', category: 'reminders',
      preheader: 'Dinner, a walk, a day trip: post it and travelers nearby can join.',
      blocks: [
        { t: 'h1', text: `Start something${where}, ${n}` },
        { t: 'p', text: `Hi ${n}, you haven't joined or posted a plan yet. There are no open plans${where} right now, so yours would be one of the first people see.` },
        { t: 'p', text: `Keep it simple: chai, dinner, a sunset walk. People nearby join with one tap and you all get a group chat. You can post ${F.activitiesPerDay} plans a day on the free plan.` },
        { t: 'button', label: 'Post a plan', url: appUrl('/activity/new') },
      ],
    };
  }
  const city = d.trip?.city;
  const head = d.scope === 'trip_dates' && city ? `Plans in ${city} for your trip` : d.scope === 'trip_city' && city ? `${k} ${k === 1 ? 'plan' : 'plans'} coming up in ${city}` : `${k} ${k === 1 ? 'plan' : 'plans'} near you`;
  return {
    subject: head, category: 'reminders',
    preheader: 'Joining is free. Tap Join and you\'re in the group chat.',
    blocks: [
      { t: 'h1', text: head },
      { t: 'p', text: `Hi ${n}, you haven't joined a plan yet. ${d.scope === 'trip_dates' ? 'These are on during your trip:' : d.scope === 'trip_city' ? `Nothing on your exact dates yet, but here's what's coming up in ${city}:` : city ? `Nothing in ${city} yet, but here's what's on near you:` : `Here's what's coming up near you:`}` },
      { t: 'list', marker: 'dot', items },
      { t: 'p', text: 'Joining is free. Tap Join and you\'re in the group chat with everyone going.' },
      { t: 'button', label: k === 1 ? 'See the plan' : 'See the plans', url: k === 1 ? appUrl(`/activity/${d.plans[0].id}`) : appUrl('/') },
      { t: 'small', text: 'Meet in busy public places and keep chats in the app until you know someone.' },
    ],
  };
}

export function tripNudge(d: { name?: string | null; hinglish?: boolean }): Email {
  const n = firstName(d.name);
  return {
    subject: 'Where are you headed next?', category: 'reminders',
    preheader: 'Add your trip and see who else will be there on your dates.',
    blocks: [
      { t: 'h1', text: d.hinglish ? `Kahan ja rahe ho, ${n}?` : `Where to next, ${n}?` },
      { t: 'p', text: `Hi ${n}, add your next trip (just a city and dates) and Tablamigo shows you who else will be there at the same time.` },
      { t: 'list', items: [
        `**See who overlaps.** The free plan shows a preview of ${F.overlapPreview} people on your dates; Plus shows everyone.`,
        `**Join the city chat** up to ${F.cityChatDaysAhead} days before you land.`,
        '**Hear from us** when other travelers or plans line up with your trip.',
      ] },
      { t: 'button', label: 'Add my trip', url: appUrl('/trip/new') },
    ],
  };
}
