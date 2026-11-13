/**
 * Owner sale alerts: one email to the owner (OWNER_SALES_ALERT_EMAIL, config.ownerSalesAlerts) for every money event —
 * a purchase, a charge, a renewal, a plan change, a cancellation, a payment problem, a refund — on the web (Razorpay) and
 * in the Android app (Google Play). Customer receipts are separate (emails/*) and never go to these addresses; these alerts
 * never go to a customer.
 *
 * Rules every caller relies on:
 *  - Best effort. ownerSaleAlert() returns at once and never throws: the webhook, RTDN push or verify call that reports the
 *    event finishes (and answers its provider) whatever the email provider does. The build function runs off that path.
 *  - Exactly once per event. `key` is made of the provider's own ids (a Razorpay payment, refund or subscription id, a Play
 *    order id), never a time; owner_sale_alerts' primary key turns a retried, duplicated or concurrent event into a no-op.
 *    A failed send is retried by the next delivery of the same event and by the email jobs (retryFailedOwnerAlerts).
 *  - Only what was verified. Callers alert after the provider confirmed the event (a re-read from Razorpay or Google, or a
 *    checked signature), never from what a request body claims.
 *  - Whitelisted fields only. An alert carries the event, product, amount, the customer's name, email, user id and sign-up
 *    source, provider ids that pass PROVIDER_ID (so never a Play purchase token) and the admin link. Never card, UPI, bank or
 *    phone details, tokens, signatures or a raw payload.
 *  - Test mode only for a provider test (Razorpay test key, Play license-tester purchase), as a small badge in the body. An
 *    internal account paying on a live key is live money (an "Internal account" badge), never test.
 */
import crypto from 'node:crypto';
import { config } from './config.js';
import { sql } from './db.js';
import { sendMail } from './mail.js';
import { money, periodName } from './emails/templates.js';
import { render, type Block } from './emails/layout.js';

export type SaleKind =
  | 'subscription_started' | 'first_charge' | 'renewal' | 'renewal_recovered' | 'plan_change' | 'resubscribed'
  | 'cancel_requested' | 'cancelled' | 'ended' | 'renewal_failed' | 'halted' | 'on_hold' | 'grace' | 'paused'
  | 'refund' | 'revoked' | 'pass_purchase' | 'ticket_purchase' | 'dispute' | 'charge_stopped';

export const SALE_LABEL: Record<SaleKind, string> = {
  subscription_started: 'New subscription',
  first_charge: 'First charge',
  renewal: 'Renewal',
  renewal_recovered: 'Renewal recovered',
  plan_change: 'Plan change',
  resubscribed: 'Resubscribed',
  cancel_requested: 'Cancellation requested',
  cancelled: 'Cancelled',
  ended: 'Subscription ended',
  renewal_failed: 'Renewal failed',
  halted: 'Renewal halted',
  on_hold: 'On hold',
  grace: 'Grace period',
  paused: 'Paused',
  refund: 'Refund',
  revoked: 'Revoked',
  pass_purchase: 'Trip Pass purchase',
  ticket_purchase: 'Ticket purchase',
  dispute: 'Chargeback',
  charge_stopped: 'Charge stopped',
};

const ID_LABEL = {
  paymentId: 'Razorpay payment id', orderId: 'Razorpay order id', subscriptionId: 'Razorpay subscription id',
  refundId: 'Razorpay refund id', invoiceId: 'Razorpay invoice id', playOrderId: 'Google Play order id', disputeId: 'Razorpay dispute id',
} as const;
export type SaleIds = Partial<Record<keyof typeof ID_LABEL, string | null>>;

export type SaleEvent = {
  kind: SaleKind;
  provider: 'razorpay' | 'google_play';
  userId: string | null;
  /** "Plus monthly", "Trip Pass (14 days)", "Event ticket". */
  product: string;
  /** The money this event moved, in minor units (paise), when known. */
  amountMinor?: number | null;
  currency?: string | null;
  /** How to read the amount when it is not the exact charge, e.g. "plan price". */
  amountNote?: string | null;
  ids?: SaleIds;
  /** Why the provider says this is a test (Razorpay test key, Play test purchase); null for live money. */
  test?: string | null;
  /** Extra whitelisted lines, e.g. ['Plus until', '25 Nov 2026']. Empty values are left out. */
  details?: [string, string | null | undefined][];
  at?: Date | null;
};

export type AlertOutcome = 'sent' | 'duplicate' | 'disabled' | 'nothing' | 'failed';

/** Provider ids are short and plain (pay_Abc123, sub_…, GPA.1234-5678-9012-34567..0). A purchase token is 100+ characters. */
const PROVIDER_ID = /^[A-Za-z0-9_.:-]{3,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-z_]+:[A-Za-z0-9_.:-]{1,190}$/;
export const MAX_ATTEMPTS = 6;
const DEMO_DOMAINS = ['demo.tablamigo', 'deleted.tablamigo', 'team.tablamigo'];

const clean = (v: unknown, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** "25 Oct 2026, 14:05 IST": the owner reads these in India. */
export const istTime = (d: Date) => `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)} IST`;
export const istDate = (d: Date | null | undefined) => d && !Number.isNaN(d.getTime()) ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(d) : null;
/** A Razorpay unix-seconds field as a date line. */
export const unixDate = (s: unknown) => (Number(s) > 0 ? istDate(new Date(Number(s) * 1000)) : null);

/** Razorpay test keys only ever see test objects, so a test key means every Razorpay event is a test. */
export const razorpayTest = () => (config.razorpay.keyId.startsWith('rzp_test_') ? 'Razorpay test key' : null);

/** notes.product of a Tablamigo Razorpay object, as the owner reads it. */
export function razorpayProduct(product: unknown) {
  const p = String(product ?? '');
  if (p === 'tablamigo_trip_pass') return 'Trip Pass (14 days)';
  if (p === 'activity_ticket') return 'Event ticket';
  const period = p.replace(/^tablamigo_plus_/, '');
  return period && period !== p ? `Plus ${clean(periodName(period), 20)}` : 'Plus';
}

/** Google's Money ({ currencyCode, units, nanos }) in minor units. */
export function playMoney(m: any): { amountMinor: number; currency: string } | null {
  if (!m?.currencyCode || !/^[A-Z]{3}$/.test(m.currencyCode)) return null;
  const v = Number(m.units ?? 0) + Number(m.nanos ?? 0) / 1e9;
  return Number.isFinite(v) ? { amountMinor: Math.round(v * 100), currency: m.currencyCode } : null;
}
export const playProduct = (productId: string, basePlanId?: string | null) =>
  productId === 'tablamigo_trip_pass' ? 'Trip Pass (14 days)' : `Plus${basePlanId ? ' ' + clean(periodName(basePlanId), 20) : ''}`;

// --- the customer ------------------------------------------------------------------------------------------------------------
export type Customer = {
  name: string | null; email: string | null; internal: string | null;
  homeCountry: string | null; city: string | null; signedUp: Date | null; deleted: boolean;
  source: string | null; medium: string | null; campaign: string | null; signupCountry: string | null; device: string | null;
};

async function customer(userId: string): Promise<Customer | null> {
  const [u] = await sql`select name, email::text as email, role, account_kind, home_country, city, created_at, deleted_at,
      attribution->>'source' as source, attribution->>'medium' as medium, attribution->>'campaign' as campaign,
      attribution->>'country' as signup_country, attribution->>'device' as device
    from users where id = ${userId}`;
  if (!u) return null;
  const email = (u.email as string | null)?.toLowerCase() ?? null;
  const domain = email?.split('@')[1] ?? '';
  const internal = email && config.adminEmails.includes(email) ? 'internal account (ADMIN_EMAILS)'
    : email && config.reviewEmails.includes(email) ? 'store review / QA account (REVIEW_EMAILS)'
    : u.role === 'admin' ? 'admin account'
    : u.accountKind && u.accountKind !== 'person' ? 'team account'
    : DEMO_DOMAINS.includes(domain) && !u.deletedAt ? 'demo account' : null;
  return {
    name: u.name, email, internal, homeCountry: u.homeCountry, city: u.city, signedUp: u.createdAt ? new Date(u.createdAt) : null,
    deleted: !!u.deletedAt, source: u.source, medium: u.medium, campaign: u.campaign, signupCountry: u.signupCountry, device: u.device,
  };
}

// --- rendering ---------------------------------------------------------------------------------------------------------------
export type RenderedAlert = { subject: string; text: string; html: string; test: boolean };

/** One short sentence under the headline. `who` is the customer's name or email; `amount` may be empty. */
const SUMMARY: Record<SaleKind, (who: string, product: string, amount: string) => string> = {
  subscription_started: (w, p) => `${w} started a ${p} subscription.`,
  first_charge: (w, p, a) => `${w} made the first payment${a ? ` of ${a}` : ''} on ${p}.`,
  renewal: (w, p, a) => `${w}'s ${p} renewed${a ? ` for ${a}` : ''}.`,
  renewal_recovered: (w, p) => `${w}'s ${p} renewal went through after an earlier failed attempt.`,
  plan_change: (w, p) => `${w} switched plan. The new plan is ${p}.`,
  resubscribed: (w, p) => `${w} subscribed to ${p} again.`,
  cancel_requested: (w, p) => `${w} asked to cancel ${p}.`,
  cancelled: (w, p) => `${w}'s ${p} subscription is cancelled.`,
  ended: (w, p) => `${w}'s ${p} subscription has ended.`,
  renewal_failed: (w, p) => `A ${p} renewal payment from ${w} didn't go through.`,
  halted: (w, p) => `Renewals of ${w}'s ${p} failed and the payment provider stopped retrying. Tablamigo cancels a halted web subscription at once; Plus ends with the paid period.`,
  on_hold: (w, p) => `${w}'s ${p} is on hold in Google Play after a failed payment.`,
  grace: (w, p) => `${w}'s ${p} payment failed and Google Play's grace period has started.`,
  paused: (w, p) => `${w} paused ${p} in Google Play.`,
  refund: (w, p, a) => `${a ? `${a} was` : 'A payment was'} refunded to ${w} for ${p}.`,
  revoked: (w, p) => `${w}'s ${p} was revoked by the payment provider.`,
  pass_purchase: (w, p, a) => `${w} bought a ${p}${a ? ` for ${a}` : ''}.`,
  ticket_purchase: (w, _p, a) => `${w} bought an event ticket${a ? ` for ${a}` : ''}.`,
  dispute: (w, p, a) => `${w} raised a chargeback${a ? ` of ${a}` : ''} on ${p}. Their Plus from web purchases has ended and web checkout is locked.`,
  charge_stopped: (w, p) => `${w}'s ${p} could still have charged after its plan ended here, so it was cancelled at the payment provider.`,
};

/** The owner's footer: says who gets this and keeps the dedupe key for support. */
const ownerFooter = (key: string) => [
  `Sent only to the owner (OWNER_SALES_ALERT_EMAIL). The customer gets their own receipt separately.`,
  `Alert key: ${key}`,
];

/**
 * The owner's alert, in the same branded layout as the customer emails (emails/layout.ts): a headline ("Renewal: Plus
 * monthly, ₹499"), one sentence, a button to the customer in admin and fact tables, with the plain-text part rendered from
 * the same blocks. Every value from a customer or provider goes through `facts` (escaped, never parsed for links).
 *
 * Test vs live: only a provider test (a Razorpay test key, a Google Play license-tester purchase; `ev.test`) is test mode,
 * shown as a small "Test mode" badge, never in the subject. An internal account (ADMIN_EMAILS, REVIEW_EMAILS, an admin, a
 * team or demo account) paying on a live key is real money: it gets an "Internal account" badge and Mode "Live".
 */
export function renderOwnerAlert(ev: SaleEvent, who: Customer | null, key: string): RenderedAlert {
  const label = SALE_LABEL[ev.kind];
  const product = clean(ev.product, 60) || 'Tablamigo';
  const amount = ev.amountMinor != null && Number.isFinite(ev.amountMinor) && ev.currency && /^[A-Z]{3}$/.test(ev.currency)
    ? money(Math.round(ev.amountMinor), ev.currency) : null;
  const testReason = ev.test ? clean(ev.test, 80) : null;
  const test = !!testReason;
  const internal = who?.internal ? clean(who.internal, 80) : null;
  const name = clean(who?.name, 60), email = clean(who?.email, 120);
  const whoLine = name && email ? `${name} (${email})` : email || name || 'unknown customer';
  const headline = `${label}: ${product}${amount ? `, ${amount}` : ''}`;
  const subject = clean(`${headline} — ${whoLine}`, 250);
  // 'p' text is parsed for **bold** and [label](url): the characters that make those are taken out of the customer's name.
  const md = (v: string) => v.replace(/[*[\]]/g, '');
  const summary = SUMMARY[ev.kind](md(name || email || 'A customer'), md(product), amount ?? '');

  const signup = who ? [
    who.signedUp ? istDate(who.signedUp) : null,
    who.source ? `source ${clean(who.source, 40)}${who.medium ? ' / ' + clean(who.medium, 40) : ''}${who.campaign ? ' / ' + clean(who.campaign, 60) : ''}` : null,
    who.signupCountry ? `country ${clean(who.signupCountry, 8)}` : null,
    who.device ? `device ${clean(who.device, 30)}` : null,
  ].filter(Boolean).join(' · ') : null;
  const ids = Object.entries(ev.ids ?? {})
    .filter(([k, v]) => k in ID_LABEL && typeof v === 'string' && PROVIDER_ID.test(v))
    .map(([k, v]) => ({ k: ID_LABEL[k as keyof typeof ID_LABEL], v: v as string }));
  const pay = ev.ids?.paymentId && PROVIDER_ID.test(ev.ids.paymentId) ? ev.ids.paymentId : null;
  const adminUrl = ev.userId ? `${config.siteUrl}/admin#users?q=${ev.userId}` : null;

  const provider = ev.provider === 'razorpay' ? 'Razorpay' : 'Google Play';
  const r = renderOwnerNotice({
    subject, testReason, internal, eyebrow: `Owner alert · ${provider}`, headline, summary,
    button: adminUrl ? { label: 'Open customer in admin', url: adminUrl } : null,
    sections: [
      [null, [
        { k: 'Event', v: label },
        { k: 'Product', v: product },
        { k: 'Amount', v: amount ? `${amount}${ev.currency !== 'INR' ? '' : ' INR'}${ev.amountNote ? ` (${clean(ev.amountNote, 80)})` : ''}` : 'not reported by the provider' },
        { k: 'When', v: istTime(ev.at && !Number.isNaN(ev.at.getTime()) ? ev.at : new Date()) },
        { k: 'Mode', v: test ? `Test mode (${testReason})` : internal ? `Live (${internal})` : 'Live' },
        ...(ev.details ?? []).map(([k, v]) => ({ k: clean(k, 40), v: v == null ? null : clean(v, 200) })),
      ]],
      ['Customer', who ? [
        { k: 'Name', v: name || '(no name yet)' },
        { k: 'Email', v: email || null },
        { k: 'User id', v: ev.userId },
        { k: 'Signed up', v: signup || null },
        { k: 'Profile', v: [who.homeCountry ? `home ${clean(who.homeCountry, 8)}` : null, who.city ? clean(who.city, 60) : null].filter(Boolean).join(' · ') || null },
        { k: 'Account', v: who.deleted ? 'deleted since' : null },
      ] : [{ k: 'Customer', v: ev.userId ? `user ${ev.userId} (no such account now)` : 'unknown' }]],
      [provider, [
        ...ids,
        { k: 'Dashboard', v: ev.provider === 'razorpay' && pay ? `https://dashboard.razorpay.com/app/payments/${pay}` : null,
          url: ev.provider === 'razorpay' && pay ? `https://dashboard.razorpay.com/app/payments/${pay}` : undefined },
      ]],
    ],
    footer: ownerFooter(key),
  });
  return { subject, text: r.text, html: r.html, test };
}

export type OwnerFact = { k: string; v: string | null | undefined; url?: string };
/**
 * The one template for every email to the owner (sale alerts here, the Play acknowledgement alert in play-ack.ts): the
 * customer emails' layout with a "Test mode" badge only for a provider test (`testReason`), an "Internal account" badge for
 * live money from one of our own accounts, an eyebrow, the headline, one sentence, an optional button and titled fact
 * tables. Facts are escaped and never parsed; rows with no value and sections with no rows are left out.
 */
export function renderOwnerNotice(n: {
  subject: string; testReason?: string | null; internal?: string | null; eyebrow: string; headline: string; summary: string;
  button?: { label: string; url: string } | null; sections: [string | null, OwnerFact[]][]; footer: string[];
}) {
  // 'h1' and 'p' are parsed for **bold** and [label](url): the characters that make those are taken out.
  const md = (v: string) => v.replace(/[*[\]]/g, '');
  const blocks: (Block | null)[] = [
    n.testReason ? { t: 'badge', text: `Test mode · ${n.testReason}` } : null,
    !n.testReason && n.internal ? { t: 'badge', text: 'Internal account · live money' } : null,
    { t: 'eyebrow', text: n.eyebrow },
    { t: 'h1', text: md(n.headline) },
    { t: 'p', text: n.summary },
    n.button ? { t: 'button', label: n.button.label, url: n.button.url } : null,
    ...n.sections.flatMap(([title, rows]): (Block | null)[] => {
      const kept = rows.filter((r): r is { k: string; v: string; url?: string } => !!r.v);
      return kept.length ? [title ? { t: 'eyebrow', text: title } : null, { t: 'facts', rows: kept }] : [];
    }),
  ];
  return render({ subject: n.subject, preheader: n.summary, category: 'transactional', blocks: blocks.filter((b): b is Block => !!b) },
    { unsubscribeUrl: null, footer: n.footer });
}

/**
 * The partner-lead alert to ADMIN_EMAILS (routes/partnerships.ts), in the same layout. Every value is the visitor's own
 * text, so all of it goes through `facts` and `quote`.
 */
export function partnerLeadEmail(b: { businessName: string; contactName: string; email: string; businessType: string; city: string; country?: string; budget?: string; message: string }, lead: { id: string | number; at: Date }) {
  const subject = clean(`New partner lead: ${b.businessName} (${b.city})`, 200);
  return render({
    subject, preheader: clean(`${b.contactName} · ${b.businessType} · ${b.city}`, 120), category: 'transactional',
    blocks: [
      { t: 'eyebrow', text: 'Partnerships' },
      { t: 'h1', text: 'New partner lead' },
      { t: 'facts', rows: [
        { k: 'Business', v: clean(b.businessName, 120) },
        { k: 'Contact', v: clean(b.contactName, 100) },
        { k: 'Email', v: clean(b.email, 200) },
        { k: 'Type', v: clean(b.businessType, 60) },
        { k: 'Location', v: clean(`${b.city}${b.country ? `, ${b.country}` : ''}`, 180) },
        { k: 'Budget', v: clean(b.budget, 100) || 'Not specified' },
        { k: 'Received', v: istTime(lead.at) },
      ] },
      { t: 'eyebrow', text: 'Message' },
      { t: 'quote', text: String(b.message).slice(0, 3000) },
    ],
  }, { unsubscribeUrl: null, footer: [`Sent to ADMIN_EMAILS from the Tablamigo partnerships form. Reply to answer the sender.`, `Lead id: ${lead.id}`] });
}

/** The confirmation to the address typed into the partnerships form. Carries none of the visitor's words. */
export function partnerConfirmationEmail() {
  return render({
    subject: 'We got your Tablamigo partnership enquiry', preheader: 'We have your enquiry and will reply to this address.', category: 'transactional',
    blocks: [
      { t: 'h1', text: 'Thanks for getting in touch' },
      { t: 'p', text: 'We have your enquiry about partnering with Tablamigo and will reply to this address.' },
      { t: 'small', text: "If you didn't send it, you can ignore this email." },
      { t: 'p', text: 'Tablamigo Partnerships' },
    ],
  }, { unsubscribeUrl: null, footer: ['You got this because this address was entered on the Tablamigo partnerships form.'] });
}

// --- sending -----------------------------------------------------------------------------------------------------------------
/**
 * Waits before each new try of `build` after a transient provider failure (a Razorpay 5xx, a timeout, a dropped connection):
 * the webhook was answered long ago, so nothing else would bring the alert back. Mutable so tests can shorten it.
 */
export const BUILD_RETRY_MS = [2_000, 10_000, 30_000];
const transient = (e: any) => {
  const status = Number(e?.response?.status ?? 0);
  return status >= 500 || status === 429 || /razorpay_(5\d\d|429)\b|fetch failed|timed? ?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|aborted|network/i.test(String(e?.message ?? ''));
};
async function buildWithRetries(build: () => SaleEvent | null | Promise<SaleEvent | null>) {
  for (let i = 0; ; i++) {
    try { return await build(); }
    catch (e) {
      if (i >= BUILD_RETRY_MS.length || !transient(e)) throw e;
      await new Promise(r => setTimeout(r, BUILD_RETRY_MS[i]));
    }
  }
}

/**
 * Resend keeps an idempotency key for 24 hours, so a copy re-sent after a crash between Resend's answer and our status
 * update (a stale 'pending' row, retryFailedOwnerAlerts) is dropped by Resend instead of reaching the owner twice. One key
 * per alert and recipient; the retried copy is the stored one, byte for byte.
 */
const idempotencyKey = (key: string, addr: string) => `tablamigo-owner-alert-${crypto.createHash('sha256').update(`${key}|${addr}`).digest('hex').slice(0, 48)}`;

async function deliverClaim(key: string, mail: { subject: string; text: string; html: string }): Promise<AlertOutcome> {
  const to = config.ownerSalesAlerts.valid;
  const ids: string[] = [], errors: string[] = [];
  let logged = false;
  for (const addr of to) {
    try {
      const r = await sendMail({ to: addr, subject: mail.subject, text: mail.text, html: mail.html, idempotencyKey: idempotencyKey(key, addr) });
      if (r?.logged) logged = true;
      if (r?.id) ids.push(r.id);
    } catch (e) { errors.push(clean((e as Error)?.message, 200)); }
  }
  if (errors.length === to.length) {
    await sql`update owner_sale_alerts set status = 'failed', error = ${errors.join(' | ').slice(0, 500)} where event_key = ${key}`;
    console.error('owner sale alert: send failed', key, errors[0]);
    return 'failed';
  }
  // Sent (to at least one address): the rendered copy, which names the customer, is not kept.
  await sql`update owner_sale_alerts set status = ${logged ? 'skipped' : 'sent'}, sent_at = now(), provider_id = ${ids.join(',') || null},
      error = ${errors.length ? `${errors.length} of ${to.length} recipients failed: ${errors[0]}`.slice(0, 500) : logged ? 'no RESEND_API_KEY: logged, not sent' : null},
      subject = null, body_text = null, body_html = null
    where event_key = ${key}`;
  return 'sent';
}

/**
 * The awaited core of ownerSaleAlert: claim `key`, build and send. 'duplicate' when this event already has an alert (sent,
 * in flight, or failed MAX_ATTEMPTS times); 'nothing' when `build` decides there is nothing to tell. Never throws.
 */
export async function sendOwnerSaleAlert(key: string, build: () => SaleEvent | null | Promise<SaleEvent | null>): Promise<AlertOutcome> {
  try {
    if (!config.ownerSalesAlerts.valid.length) return 'disabled';
    if (!KEY.test(key)) { console.error('owner sale alert: refused a malformed key'); return 'failed'; }
    // Cheap check first, so a duplicate delivery never repeats the provider lookups in `build`.
    const [seen] = await sql`select status, attempts from owner_sale_alerts where event_key = ${key}`;
    if (seen && !(seen.status === 'failed' && seen.attempts < MAX_ATTEMPTS)) return 'duplicate';
    const ev = await buildWithRetries(build);
    if (!ev) return 'nothing';
    const userId = ev.userId && UUID.test(ev.userId) ? ev.userId : null;
    const who = userId ? await customer(userId) : null;
    const mail = renderOwnerAlert({ ...ev, userId }, who, key);
    // A failed row is retried with the copy it already holds, so a re-send is the same email (see idempotencyKey).
    const [claim] = await sql`insert into owner_sale_alerts (event_key, kind, provider, user_id, test, subject, body_text, body_html)
      values (${key}, ${ev.kind}, ${ev.provider}, ${userId}, ${mail.test}, ${mail.subject}, ${mail.text}, ${mail.html})
      on conflict (event_key) do update set status = 'pending', attempts = owner_sale_alerts.attempts + 1, error = null, claimed_at = now(),
        subject = coalesce(owner_sale_alerts.subject, excluded.subject), body_text = coalesce(owner_sale_alerts.body_text, excluded.body_text),
        body_html = coalesce(owner_sale_alerts.body_html, excluded.body_html)
        where owner_sale_alerts.status = 'failed' and owner_sale_alerts.attempts < ${MAX_ATTEMPTS}
      returning subject, body_text, body_html`;
    if (!claim) return 'duplicate';
    return await deliverClaim(key, { subject: claim.subject, text: claim.bodyText, html: claim.bodyHtml });
  } catch (e) {
    console.error('owner sale alert failed', KEY.test(key) ? key : '(bad key)', clean((e as Error)?.message, 200));
    return 'failed';
  }
}

const inFlight = new Set<Promise<AlertOutcome>>();
function track(p: Promise<AlertOutcome>) {
  const t: Promise<AlertOutcome> = p.catch(() => 'failed' as const).finally(() => inFlight.delete(t));
  inFlight.add(t);
}
/**
 * Queue the alert for `key` and return at once: the caller (a webhook, an RTDN push, a verify call) never waits for the
 * provider lookups in `build` or for the email, and nothing here can throw into it.
 */
export function ownerSaleAlert(key: string, build: () => SaleEvent | null | Promise<SaleEvent | null>): void {
  if (!config.ownerSalesAlerts.valid.length) return;
  track(sendOwnerSaleAlert(key, build));
}
type Found = { key: string; build: () => SaleEvent | null | Promise<SaleEvent | null> };
/**
 * ownerSaleAlert for events whose keys need a provider lookup first (the payments behind renewals the periodic sync found).
 * `resolve` runs off the caller's path, with the same retries as a build; each event it returns is sent as ownerSaleAlert would.
 */
export function ownerSaleAlertLookup(resolve: () => Promise<Found[]>): void {
  if (!config.ownerSalesAlerts.valid.length) return;
  track((async () => {
    let found: Found[] = [];
    for (let i = 0; ; i++) {
      try { found = await resolve(); break; }
      catch (e) {
        if (i >= BUILD_RETRY_MS.length || !transient(e)) { console.error('owner sale alert lookup failed', clean((e as Error)?.message, 200)); return 'failed' as const; }
        await new Promise(r => setTimeout(r, BUILD_RETRY_MS[i]));
      }
    }
    // One after another: a catch-up of several charges must not trip Resend's rate limit.
    const outcomes: AlertOutcome[] = [];
    for (const f of found) outcomes.push(await sendOwnerSaleAlert(f.key, f.build));
    return outcomes.includes('sent') ? 'sent' as const : outcomes.includes('failed') ? 'failed' as const : 'nothing' as const;
  })());
}
/** Resolves once every queued alert has finished, or after `ms` (tests wait for all; a shutdown waits briefly). */
export async function ownerAlertsSettled(ms = Infinity) {
  const end = Date.now() + ms;
  while (inFlight.size && Date.now() < end) {
    const left = end - Date.now();
    await Promise.race([Promise.allSettled([...inFlight]), ...(Number.isFinite(left) ? [new Promise(r => setTimeout(r, left))] : [])]);
  }
}

/** A claim whose process died before it recorded the outcome (a crash, a restart mid-send) is taken again after this long. */
const STALE_PENDING = '15 minutes';
/**
 * Run by the email jobs every 10 minutes. Re-sends alerts whose send failed (email provider down) and claims left 'pending' by
 * a process that died mid-send, from their stored copy. Copies that will never be sent again (out of attempts, older than 3
 * days) are cleared, so no customer's name or email stays in this table longer than the retry window.
 */
export async function retryFailedOwnerAlerts(): Promise<number> {
  await sql`update owner_sale_alerts set subject = null, body_text = null, body_html = null
    where subject is not null and status in ('failed', 'pending') and (attempts >= ${MAX_ATTEMPTS} or created_at < now() - interval '3 days')`;
  if (!config.ownerSalesAlerts.valid.length) return 0;
  const rows = await sql`update owner_sale_alerts set status = 'pending', attempts = attempts + 1, error = null, claimed_at = now()
    where event_key in (select event_key from owner_sale_alerts
      where subject is not null and attempts < ${MAX_ATTEMPTS} and created_at > now() - interval '3 days'
        and (status = 'failed' or (status = 'pending' and claimed_at < now() - ${STALE_PENDING}::interval))
      order by created_at limit 20 for update skip locked)
    returning event_key, subject, body_text, body_html`;
  let sent = 0;
  for (const r of rows) if (await deliverClaim(r.eventKey, { subject: r.subject, text: r.bodyText, html: r.bodyHtml }).catch(() => 'failed') === 'sent') sent++;
  return sent;
}

/** One startup line saying whether alerts are on, and how many configured addresses were dropped. */
export function ownerAlertsStartupLine() {
  const { valid, invalid } = config.ownerSalesAlerts;
  const bad = invalid ? `; ${invalid} invalid address${invalid === 1 ? '' : 'es'} in OWNER_SALES_ALERT_EMAIL ignored` : '';
  return valid.length ? `owner sale alerts: on, ${valid.length} recipient${valid.length === 1 ? '' : 's'}${bad}` : `owner sale alerts: off (OWNER_SALES_ALERT_EMAIL unset)${bad}`;
}
