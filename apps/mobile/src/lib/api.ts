import { API_URL } from './config';
import { useSession } from './session';

// What a person should read when the server sends only a code. Never show raw codes.
const FRIENDLY: Record<string, string> = {
  server_error: 'Something went wrong on our side. Try again in a moment.',
  rate_limited: "You're going a bit fast. Wait a moment and try again.",
  not_partner: 'Join the partner programme first.',
  too_large: "That's too big to send.",
  invalid_input: 'Some details look off. Check them and try again.',
  not_found: "This isn't available any more.",
  forbidden: "You can't do that here.",
  unauthorized: 'Please sign in again.',
  activity_over: 'This plan has already happened.',
  full: 'This plan is full.',
  plan_closed: 'The host closed this plan to new people.',
  women_only: 'This plan is for women only.',
  women_only_host: 'Only women can host women-only plans.',
  profile_incomplete: 'Finish your profile first.',
  under_18: 'You need to be 18 or older to use Tablamigo.',
  wrong_code: "That code isn't right. Check your email and try again.",
  code_expired: 'That code has expired. Ask for a new one.',
  too_many_codes: 'Too many codes requested. Try again in an hour.',
  plus_required: 'This needs Tablamigo Plus.',
  too_many_attempts: 'Too many wrong tries. Ask for a new code.',
  banned: 'This account is suspended.',
  no_connection: "You're offline. Check your connection and try again.",
  timeout: 'This is taking too long. Check your connection and try again.',
  google_failed: "Google sign-in didn't work this time. Try again, or use email instead.",
  google_unavailable: "Google sign-in isn't available here. Use email instead.",
  google_token_invalid: "We couldn't confirm your Google sign-in. Try again, or use email instead.",
  google_email_unverified: "Your Google account's email isn't verified yet. Use email instead.",
  too_many_trips: "You've added the maximum number of trips.",
  bad_dates: 'Check the dates: the trip has to end after it starts.',
  bad_time: 'Pick a time in the future.',
  duplicate_plan: 'The team already listed this plan.',
  host_cannot_leave: "You're the host. Cancel the plan instead of leaving it.",
  blocked: "You can't interact with this person.",
  not_a_member: 'Join the plan to see this chat.',
  ai_failed: "Couldn't come up with ideas right now. Try again.",
  ai_not_configured: 'Ideas are not available yet.',
  verify_failed: "We couldn't confirm the purchase yet. If you were charged, it will activate shortly.",
  checkout_failed: "Couldn't start the payment. Try again in a moment.",
  payments_unavailable: 'Payments are not available yet.',
  already_subscribed: 'You already have a Plus subscription.',
  plan_not_available: 'That plan is not available on the website yet. Pick another one.',
  cancel_failed: "Couldn't cancel right now. Try again in a moment.",
  bad_subscription: "This browser couldn't turn on notifications.",
  bad_ages: 'Pick a minimum age below the maximum.',
  plan_not_started: 'You can give a thumbs-up once the plan has started.',
  not_in_plan: 'You can only thumbs-up people who were on this plan with you.',
  bad_photo: "That photo didn't upload properly. Take it again.",
  camera_needed: 'Allow camera access to take your verification selfie. You can turn it on in Settings.',
  photo_needed: 'Add a profile photo first, so we have something to compare your selfie with.',
  already_verified: "You're already verified.",
  verification_pending: "We're still checking your last selfie. It takes a few seconds.",
  too_many_tries: "You've used today's 5 tries. Try again tomorrow.",
  message_blocked: "That message breaks our community rules, so it wasn't sent.",
  group_only: 'Polls are only for group chats.',
  no_location_in_city_chat: 'Live location works in plan chats and direct messages, not city chats.',
  no_location_in_trip_chat: 'Live location works in plan chats and direct messages, not trip circles.',
  bad_audio: "That voice note didn't upload properly.",
  city_not_found: "We don't have a guide for this city yet.",
  ticket_required: 'This is a ticketed event.',
  paid_events_unavailable: "Tickets aren't on sale yet.",
  payment_required: 'A completed payment is needed for a ticket.',
  payment_not_verified: "We couldn't confirm this payment, so no ticket was issued.",
  trip_pass_bundles_unavailable: 'Trip Pass bundles are not on sale.',
  id_verification_unavailable: 'Government ID verification is not available.',
  referral_new_accounts_only: 'Invite codes work in your first 14 days on Tablamigo.',
  invalid_code: "We couldn't find that invite code. Check it and try again.",
  city_unknown: "We couldn't tell which city you're in. Try again in a moment.",
  location_ended: 'This live location has already ended.',
  not_sender: 'Only the person sharing can change this.',
  dm_limit: 'Free accounts can start 1 new conversation a day. Replies are always free, and so are chats with people from your plans.',
  dm_wait_reply: 'Wait for them to reply before sending more.',
  reply_not_in_chat: "That message isn't available to reply to any more.",
  contact_shield: "For your safety, contact details unlock with Plus or once you've both joined the same plan.",
  launch_offer_free: 'Plus is free for everyone during the launch offer, so there is nothing to buy.',
  all_free: 'Everything in Tablamigo is free right now, so there is nothing to buy.',
  report_target_not_found: "This isn't available any more, so there's nothing to report.",
  cannot_report_own: "That's yours, so there's nothing to report.",
  running_late_too_early: "You can tell the group you're running late from an hour before the plan starts.",
  running_late_over: 'This plan started a while ago.',
};

export class ApiError extends Error {
  /** `data` is the whole error body, e.g. { feature, name } on a paywall error. */
  constructor(public status: number, public code: string, message?: string, public data: Record<string, any> = {}) {
    super(message ?? FRIENDLY[code] ?? FRIENDLY.server_error);
  }
}

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  const t = useSession.getState().tokens;
  if (!t) return false;
  const r = await fetch(`${API_URL}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: t.refreshToken }) });
  if (!r.ok) { await useSession.getState().setTokens(null); return false; }
  const j = await r.json();
  await useSession.getState().setTokens({ accessToken: j.accessToken, refreshToken: j.refreshToken });
  return true;
}

/**
 * How long a request may wait for the server's answer. React Native's fetch never gives up by itself, so on a stalled
 * connection a send button or a spinner used to wait forever (QA 1 Nov 2026: a chat message sat nowhere for 20+ s, with the
 * box already cleared). Uploads (raw bodies) get longer; AI plan ideas wait on OpenAI, which has no timeout of its own.
 */
export const REQUEST_TIMEOUT_MS = 45_000;
export const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * JSON fetch with bearer auth and one transparent token refresh on 401. A request that cannot reach the server throws
 * ApiError 'no_connection', one that waits longer than the timeout throws ApiError 'timeout': both with words a person
 * can read, never fetch's raw "Network request failed".
 */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; raw?: Blob; contentType?: string; auth?: boolean; timeoutMs?: number } = {}): Promise<T> {
  const doFetch = async () => {
    const t = useSession.getState().tokens;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? (opts.raw ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS));
    try {
      return await fetch(`${API_URL}${path}`, {
        method: opts.method ?? (opts.body || opts.raw ? 'POST' : 'GET'),
        headers: { ...(opts.raw ? { 'Content-Type': opts.contentType ?? 'application/octet-stream' } : opts.body ? { 'Content-Type': 'application/json' } : {}), ...(t && opts.auth !== false ? { Authorization: `Bearer ${t.accessToken}` } : {}) },
        body: opts.raw ?? (opts.body ? JSON.stringify(opts.body) : undefined),
        signal: ctl.signal,
      });
    } catch {
      throw new ApiError(0, ctl.signal.aborted ? 'timeout' : 'no_connection');
    } finally { clearTimeout(timer); }
  };
  let r = await doFetch();
  if (r.status === 401 && opts.auth !== false) {
    refreshing ??= refresh().finally(() => { refreshing = null; });
    if (await refreshing) r = await doFetch();
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j.error ?? 'error', j.message, j);
  return j as T;
}

/** Non-blocking client analytics event tracking */
export function trackEvent(event: string, properties?: Record<string, any>) {
  api('/analytics/events', { method: 'POST', body: { event, properties } }).catch(() => {});
}
