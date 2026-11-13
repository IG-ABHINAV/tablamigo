import 'dotenv/config';
import { isIP } from 'node:net';

const req = (k: string, fallback?: string) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined) throw new Error(`Missing env ${k}`);
  return v;
};

const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * TRUST_PROXY for Fastify. Accepts what the env var can sensibly hold and refuses everything else at startup, so a
 * typo can't silently change which X-Forwarded-For entries the API believes:
 *  - unset or empty: loopback only (the nginx on this machine, see infra/nginx/tablamigo-realip.conf);
 *  - 'true' / 'false': every hop / no hop (a bare boolean, never a string Fastify would treat as an address);
 *  - an integer: that many hops;
 *  - otherwise a comma-separated list of IPs, CIDRs or the keywords loopback / linklocal / uniquelocal.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  const v = (raw ?? '').trim();
  if (!v) return ['loopback'];
  const lower = v.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  const entries = v.split(',').map(s => s.trim()).filter(Boolean);
  const bad = entries.filter(e => !validProxyEntry(e));
  if (!entries.length || bad.length) {
    throw new Error(`Invalid TRUST_PROXY ${JSON.stringify(raw)}: ${bad.length ? `${bad.map(b => JSON.stringify(b)).join(', ')} is not an IP, a CIDR or one of loopback/linklocal/uniquelocal` : 'no addresses given'}. Use true, false, a hop count, or a comma-separated list of IPs/CIDRs.`);
  }
  return entries;
}

function validProxyEntry(e: string): boolean {
  if (PROXY_KEYWORDS.has(e)) return true;
  const [addr, bits, extra] = e.split('/');
  const family = isIP(addr);
  if (!family || extra !== undefined) return false;
  if (bits === undefined) return true;
  return /^\d{1,3}$/.test(bits) && Number(bits) <= (family === 4 ? 32 : 128);
}

/** SCHEDULER=off stops the in-process scheduler (plan reminders, recurring plans); anything else, or unset, leaves it on. */
export const schedulerEnabled = (raw: string | undefined) => (raw ?? 'on').trim().toLowerCase() !== 'off';

/** REVIEW_ASK=on lets the app ask for a store rating (lib/review-ask.ts); anything else, or unset, keeps it off. */
export const reviewAskEnabled = (raw: string | undefined) => (raw ?? 'off').trim().toLowerCase() === 'on';

/**
 * LAUNCH_PLUS_UNTIL: the end of the launch offer (Plus free for everyone), as an ISO instant WITH a zone, e.g.
 * 2026-12-31T18:29:59Z (31 Dec 2026, 23:59 IST). Unset or empty: no offer. Anything else that isn't such an instant refuses
 * to start, so a typo can't quietly switch the offer off or move its end (a date without a zone would read as the server's
 * own time zone).
 */
export function parseLaunchPlusUntil(raw: string | undefined): Date | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const d = new Date(v);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(v) || Number.isNaN(d.getTime())) {
    throw new Error(`Invalid LAUNCH_PLUS_UNTIL ${JSON.stringify(raw)}: use an ISO instant with a time zone, such as 2026-12-31T18:29:59Z.`);
  }
  return d;
}

/**
 * ALL_FREE: while on, everything in Tablamigo is free (founder's decision, 4 Oct 2026). Every account is treated as Plus
 * (lib/plus.ts isPlus / limitsFor), nothing is sold, nobody is ranked or tagged for paying, and the app hides every purchase
 * entry point (it reads `allFree` from GET /meta, /me and /billing/me, so switching back needs no app release). The billing
 * code stays in place, and existing subscriptions, passes and webhooks keep working untouched. Unset or empty: on. 'false',
 * 'off' or '0' switches paid plans back on; anything else refuses to start, so a typo can't quietly turn paywalls on.
 */
export function parseAllFree(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v || v === 'true' || v === 'on' || v === '1') return true;
  if (v === 'false' || v === 'off' || v === '0') return false;
  throw new Error(`Invalid ALL_FREE ${JSON.stringify(raw)}: use true (everything free) or false (paid plans on).`);
}

/**
 * A three-way switch for a feature that acts on people: 'off' does nothing, 'dry' logs what it would do and writes nothing,
 * 'on' does it. Unset or empty: 'dry', so a new feature only ever runs once the owner switches it on. Anything else refuses
 * to start, so a typo can't quietly switch a feature on (or off).
 */
export type Mode = 'off' | 'dry' | 'on';
export function parseMode(name: string, raw: string | undefined): Mode {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return 'dry';
  if (v === 'off' || v === 'dry' || v === 'on') return v;
  throw new Error(`Invalid ${name} ${JSON.stringify(raw)}: use off, dry or on.`);
}

/**
 * PLAY_YEARLY_TRIAL_OFFER_ID: the id of a free-trial offer on the yearly base plan in Play Console (for example
 * "yearly-trial-3d"). Unset or empty: no trial anywhere, and the app shows no trial text. When set, the app reads it from
 * GET /billing/plans, looks for that offer among the ones Play returns for this person (Play only returns offers they are
 * eligible for), and only then says "3 days free, then ..." and buys with the offer's token. Play's own rule for offer ids
 * (lower-case letters, digits and hyphens, starting with a letter or digit, at most 63) is checked here, so a typo refuses to
 * start instead of silently never matching.
 */
export function parseTrialOfferId(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(v)) {
    throw new Error(`Invalid PLAY_YEARLY_TRIAL_OFFER_ID ${JSON.stringify(raw)}: use the offer id exactly as Play Console shows it (lower-case letters, digits and hyphens), or leave it unset.`);
  }
  return v;
}

/**
 * SOCIAL_PROOF: the live counts on the website and in the app (lib/social-proof.ts). 'auto' (the default) shows a city only once
 * it has SOCIAL_PROOF_MIN_TRIPS upcoming trips from real travellers, and the popular-cities page only once 3 cities do; 'off'
 * shows nothing anywhere. Anything else refuses to start.
 */
export function parseSocialProof(raw: string | undefined): 'auto' | 'off' {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v || v === 'auto') return 'auto';
  if (v === 'off') return 'off';
  throw new Error(`Invalid SOCIAL_PROOF ${JSON.stringify(raw)}: use auto or off.`);
}

/**
 * ANDROID_MIN_VERSION_CODE: the oldest android.versionCode allowed to keep running (GET /app/min-version). Below it the app
 * shows Google Play's blocking in-app update instead of the usual background one. Unset or empty: no floor, nothing is ever
 * forced. Anything that is not a positive whole number refuses to start, because a typo here would either lock every
 * install out of the app or quietly let a broken version keep running.
 */
export function parseMinVersionCode(raw: string | undefined): number | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  // Play's own ceiling for android:versionCode. A floor above it could never be met by any build, so it would lock every
  // install into a blocking update screen with nothing to install.
  const MAX = 2_100_000_000;
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > MAX) {
    throw new Error(`Invalid ANDROID_MIN_VERSION_CODE ${JSON.stringify(raw)}: use a whole versionCode between 1 and ${MAX}, such as 14, or leave it unset.`);
  }
  return Number(v);
}

/**
 * OWNER_SALES_ALERT_EMAIL: where the owner's sale alerts go (lib/owner-alerts.ts), a comma-separated list. Each entry must be a
 * plain address; anything else is dropped and counted in `invalid` (logged at startup, never fatal: a typo in an alert
 * address must not stop the API taking payments). Unset or empty: no alerts.
 */
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export function parseEmailList(raw: string | undefined): { valid: string[]; invalid: number } {
  const entries = (raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const valid = [...new Set(entries.filter(e => e.length <= 254 && EMAIL_RE.test(e)).map(e => e.toLowerCase()))];
  return { valid, invalid: entries.filter(e => !(e.length <= 254 && EMAIL_RE.test(e))).length };
}

/** A positive number of hours up to `max` (fractions allowed: the end-to-end tests use seconds); anything else is `fallback`. */
export function boundedHours(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  return raw?.trim() && Number.isFinite(n) && n > 0 && n <= max ? n : fallback;
}

export const config = {
  appName: process.env.APP_NAME ?? 'Tablamigo',
  port: Number(process.env.PORT ?? 4100),
  // Hops whose X-Forwarded-For the API believes: only nginx on this machine (loopback). nginx is the single trusted
  // hop: it takes Cloudflare's CF-Connecting-IP (accepted only from Cloudflare's published ranges) and writes it as the
  // one X-Forwarded-For value, replacing whatever the client sent (infra/nginx/tablamigo-realip.conf). The API must
  // not trust Cloudflare's ranges itself: they include Workers egress (2a06:98c0::/29), where anyone can run code
  // that sends a forged X-Forwarded-For entry, and req.ip is what every rate limit keys on. TRUST_PROXY replaces the
  // default (see parseTrustProxy).
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  databaseUrl: req('DATABASE_URL', 'postgres://tablamigo:tablamigo-local@localhost:5434/tablamigo'),
  jwtSecret: req('JWT_SECRET', 'dev-only-secret-change-me'),
  accessTtlSec: 60 * 30,
  refreshTtlDays: 60,
  // Email login codes. Without a key the code is logged (dev only).
  resendKey: process.env.RESEND_API_KEY ?? '',
  mailFrom: process.env.MAIL_FROM ?? 'Tablamigo <hello@hookstep.in>',
  supportEmail: process.env.SUPPORT_EMAIL ?? 'support@hookstep.in',
  // The owner's sale alerts (lib/owner-alerts.ts): one email per money event, to these addresses only. Mutable so tests can set it.
  ownerSalesAlerts: parseEmailList(process.env.OWNER_SALES_ALERT_EMAIL),
  // The website; email buttons open the web app under /app, which also hands off to the Android app.
  siteUrl: (process.env.SITE_URL ?? 'https://tablamigo.hookstep.in').replace(/\/$/, ''),
  // Time-based customer emails (lib/emails/jobs.ts). 'off' stops the scheduler; event emails still send.
  emailJobs: (process.env.EMAIL_JOBS ?? 'on') !== 'off',
  // Activation nudges (lib/emails/activation.ts), part of the email jobs: 'off' stops them, 'dry' logs who would get
  // which email every run and sends nothing.
  activationEmails: (['off', 'dry'].includes(process.env.ACTIVATION_EMAILS ?? '') ? process.env.ACTIVATION_EMAILS : 'on') as 'on' | 'off' | 'dry',
  // Plan reminders and the next session of recurring plans (lib/scheduler.ts). 'off' stops them; set it on all but one
  // process if several run. A tick takes a database lock, so two processes never send a reminder twice either way.
  scheduler: schedulerEnabled(process.env.SCHEDULER),
  // How often the scheduler ticks. A minute in production; the end-to-end tests run it every second.
  schedulerIntervalMs: Math.max(1000, Number(process.env.SCHEDULER_INTERVAL_MS) || 60_000),
  // Launch offer: until this instant every account has Plus for free (lib/plus.ts launchOffer). New accounts get it at sign-up
  // and scripts/grant-launch-plus.ts gives it to the existing ones; both set comp_until, so Plus ends by itself at this
  // instant. Keep it set for 4 days after the end, so the "offer has ended" email can still tell these accounts apart.
  launchPlusUntil: parseLaunchPlusUntil(process.env.LAUNCH_PLUS_UNTIL),
  // Everything free (see parseAllFree). While on, the launch offer is ignored: no comp_until at sign-up, no "offer ending"
  // emails; LAUNCH_PLUS_UNTIL takes effect again only once ALL_FREE is switched off. Mutable so tests can flip it.
  allFree: parseAllFree(process.env.ALL_FREE),
  // The Tablamigo Host (lib/host.ts): the team account's one welcome DM to each new user. off | dry | on, default dry.
  hostWelcome: parseMode('HOST_WELCOME', process.env.HOST_WELCOME),
  // Community starter plans hosted by the Host (lib/starter-plans.ts). This switch governs listing NEW plans; plans already
  // listed always keep their promise (cancelled 3 h before start unless 2 real people joined), whatever the mode.
  starterPlans: parseMode('STARTER_PLANS', process.env.STARTER_PLANS),
  // Trip match alerts (lib/trip-match.ts): two real people in the same city on overlapping dates are each told about the other
  // once, by a team DM (with its push) and an email. off | dry | on, default dry. TRIP_MATCH_PER_DAY caps alerts per person.
  tripMatch: parseMode('TRIP_MATCH', process.env.TRIP_MATCH),
  tripMatchPerDay: Math.max(1, Math.min(20, Number(process.env.TRIP_MATCH_PER_DAY) || 3)),
  // The Plus welcome (lib/plus-welcome.ts): one team DM and email per new subscription. off | dry | on, default dry.
  plusWelcome: parseMode('PLUS_WELCOME', process.env.PLUS_WELCOME),
  // The empty-city nudge (lib/city-nudge.ts): one DM and email per trip whose city has no plans on its dates. off | dry | on.
  cityNudge: parseMode('CITY_NUDGE', process.env.CITY_NUDGE),
  // The delivery ladder's email fallbacks (lib/ladder.ts): unread team DMs, DMs and plan reminders. off | dry | on.
  emailLadder: parseMode('EMAIL_LADDER', process.env.EMAIL_LADDER),
  // Engagement loops (lib/engagement.ts): plan-view summaries to hosts and the trip-in-3-days email. off | dry | on.
  engagement: parseMode('ENGAGEMENT', process.env.ENGAGEMENT),
  // Host rewards (lib/host-rewards.ts): days of Plus for hosting a plan real travellers went to. off | dry | on, default dry.
  hostRewards: parseMode('HOST_REWARDS', process.env.HOST_REWARDS),
  // The yearly plan's free-trial offer in Play (see parseTrialOfferId). null = no trial. Mutable so tests can set it.
  playYearlyTrialOfferId: parseTrialOfferId(process.env.PLAY_YEARLY_TRIAL_OFFER_ID),
  // Live counts on the site and in the app (see parseSocialProof). Mutable so tests can switch it.
  socialProof: parseSocialProof(process.env.SOCIAL_PROOF),
  // Signed-in users with one of these emails are admins, on top of users.role = 'admin'.
  // Only these (and role = 'admin' accounts) can get a code from the admin sign-in (POST /admin/auth/start).
  // Comma-separated, set in the environment only: there is no default, so with ADMIN_EMAILS unset nobody is admin by email.
  adminEmails: (process.env.ADMIN_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  // Photos on Tablamigo's own private Cloudflare R2 bucket (S3 API), served through GET /media/*. Without keys uploads go to local disk.
  r2: {
    accountId: process.env.R2_ACCOUNT_ID ?? '',
    accessKey: process.env.R2_ACCESS_KEY ?? '',
    secretKey: process.env.R2_SECRET_KEY ?? '',
    bucket: process.env.R2_BUCKET ?? '',
    publicUrl: process.env.R2_PUBLIC_URL ?? '',
    // Key prefix when sharing a bucket with another app, e.g. "tablamigo/".
    prefix: process.env.R2_PREFIX ?? '',
  },
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:4100',
  // The oldest Android build that may keep running (see parseMinVersionCode). null = nothing is forced. Mutable so tests can set it.
  androidMinVersionCode: parseMinVersionCode(process.env.ANDROID_MIN_VERSION_CODE),
  // Google Play: package + service-account JSON (path) for subscription checks.
  playPackage: process.env.PLAY_PACKAGE ?? 'com.tablamigo.app',
  playServiceAccount: process.env.PLAY_SERVICE_ACCOUNT_JSON ?? '',
  // Google's service fee taken off a Play charge before a partner's commission (lib/affiliate-ledger.ts playNet) when Google's order
  // doesn't state our revenue itself: 15% for subscriptions and for the first $1M a year of other sales.
  affiliatePlayFeePercent: ((v: number) => (Number.isFinite(v) && v >= 0 && v <= 30 ? v : 15))(Number(process.env.AFFILIATE_PLAY_FEE_PERCENT ?? 15)),
  // The Play acknowledgement safety net (lib/play-ack.ts). Google refunds a purchase that is not acknowledged within 3 days.
  // A purchase still not acknowledged this many hours after it was bought is retried by the scheduler (then with backoff),
  // and the owner (OWNER_SALES_ALERT_EMAIL) gets one email once it is PLAY_ACK_ALERT_HOURS old and still not acknowledged.
  playAckGraceHours: boundedHours(process.env.PLAY_ACK_GRACE_HOURS, 1, 24),
  playAckAlertHours: boundedHours(process.env.PLAY_ACK_ALERT_HOURS, 24, 48),
  // "Continue with Google": ID tokens from the Android app and the web app must be issued to this (web) OAuth client.
  // A public identifier, not a secret. The Android OAuth clients only need to exist in the same Google Cloud project.
  googleWebClientId: process.env.GOOGLE_WEB_CLIENT_ID ?? '316890004786-11d9pklbq4phqa7vk3a99vfiol2qsc1s.apps.googleusercontent.com',
  openaiKey: process.env.OPENAI_API_KEY ?? '',
  isProd: process.env.NODE_ENV === 'production',
  // Accounts that skip the OTP email (store reviewers, QA). Code is fixed.
  reviewEmails: (process.env.REVIEW_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  reviewCode: process.env.REVIEW_CODE ?? '',
  // The store rating ask (lib/review-ask.ts). Off unless REVIEW_ASK=on: with few users yet, the owner asks nobody (2 Nov 2026).
  reviewAsk: reviewAskEnabled(process.env.REVIEW_ASK),
  // Firebase service account (JSON path) for push notifications. Push is off without it.
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? '',
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? '',
  // Google Play RTDN push auth: either a shared secret on the URL (?token=...), or Pub/Sub's
  // signed OIDC token from this service account (preferred: nothing secret in the URL).
  rtdnToken: process.env.RTDN_TOKEN ?? '',
  rtdnPushEmail: process.env.RTDN_PUSH_EMAIL ?? '',
  // Web Push (VAPID) for the web app. Browser push is off without the key pair.
  webPush: {
    publicKey: process.env.WEBPUSH_PUBLIC_KEY ?? '',
    privateKey: process.env.WEBPUSH_PRIVATE_KEY ?? '',
    subject: process.env.WEBPUSH_SUBJECT ?? 'mailto:support@hookstep.in',
  },
  // Razorpay Checkout for the web app. The account is shared with other products, so every
  // object we create carries notes.service = 'tablamigo'. Plan ids come from scripts/razorpay-plans.ts.
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID ?? '',
    keySecret: process.env.RAZORPAY_KEY_SECRET ?? '',
    planMonthly: process.env.RAZORPAY_PLAN_MONTHLY ?? '',
    planYearly: process.env.RAZORPAY_PLAN_YEARLY ?? '',
    // The 6-month plan (2 Nov 2026). Unset: the web sells only monthly and yearly, and its prices leave halfyearly out.
    planHalfyearly: process.env.RAZORPAY_PLAN_HALFYEARLY ?? '',
    // Tablamigo has no Razorpay webhook of its own: Hookpost's webhook (same Razorpay account) forwards our
    // events to POST /billing/razorpay/webhook, signed with this secret, which only the two servers hold.
    forwardSecret: process.env.TABLAMIGO_FORWARD_SECRET ?? '',
  },
  // Features added unreviewed between 1 and 3 Oct 2026 and switched off after the audit (audit-2026-10-03/PUNCHLIST.md).
  // Each stays off unless its env var is 'on'. The app hides the same features (apps/mobile/src/lib/config.ts FEATURES).
  features: {
    // Paid event tickets. Needs Razorpay Checkout in the app, refunds, host payouts (Route, KYC) and a decided money model
    // first. Even when on, a ticket is only issued for a Razorpay payment verified against an order made for that user and plan.
    paidEvents: process.env.FEATURE_PAID_EVENTS === 'on',
    // Tier 2 government-ID upload. The bucket is private and GET /media/* never serves id_doc/, but ID images still need
    // an admin review screen and a legal view on Aadhaar before this is turned on.
    idVerification: process.env.FEATURE_ID_VERIFICATION === 'on',
    // Voice notes in chats. The app's button sent a hard-coded demo URL, and a voice message can't be run through the contact
    // shield or moderation. While off, the audio upload and kind voice/audio messages are refused (404 voice_notes_unavailable);
    // voice notes already sent stay readable. Turn on only with a recorder in the app, moderation and a privacy-policy line.
    voiceNotes: process.env.FEATURE_VOICE_NOTES === 'on',
  },
};

// Refuse to boot production with development defaults.
if (config.isProd) {
  if (config.jwtSecret === 'dev-only-secret-change-me' || config.jwtSecret.length < 32) throw new Error('JWT_SECRET must be set (32+ chars) in production');
  if (config.reviewEmails.length && config.reviewCode.length < 6) throw new Error('REVIEW_CODE must be 6+ digits when REVIEW_EMAILS is set');
  if (!config.resendKey) throw new Error('RESEND_API_KEY is required in production');
  if (!config.rtdnToken && !config.rtdnPushEmail) throw new Error('RTDN_TOKEN or RTDN_PUSH_EMAIL is required in production (Google Play notifications are refused without one)');
}
