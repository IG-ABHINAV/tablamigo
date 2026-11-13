/**
 * Share links for a plan ("Share with someone you trust"): a public, read-only page of the plan's details at
 * /app/safe/<token> on the web app. It shows the venue, start time, host, who is going and who has checked in, as they
 * are when the page is opened. It does not show where anyone is: nothing here tracks a phone.
 *
 * The token is the only secret, so it is 24 random bytes (base64url, 32 characters). A link stops working when it
 * expires or when the person who shared it turns it off (routes/shares.ts).
 */
import crypto from 'node:crypto';
import { config } from './config.js';

export const SHARE_TOKEN_BYTES = 24;
/** What a token may look like when read from a URL: the 32 characters of a new one, or an older shorter one still in flight. */
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const newShareToken = () => crypto.randomBytes(SHARE_TOKEN_BYTES).toString('base64url');

const HOUR = 3600_000;
/** A link works until a day after the plan starts (the way home), at least 6 hours from now, and never more than 14 days. */
export const SHARE_AFTER_START_MS = 24 * HOUR;
export const SHARE_MIN_MS = 6 * HOUR;
export const SHARE_MAX_MS = 14 * 24 * HOUR;

export function shareExpiry(startsAt: Date | string, now = new Date()): Date {
  const wanted = new Date(startsAt).getTime() + SHARE_AFTER_START_MS;
  const t = Math.min(Math.max(wanted, now.getTime() + SHARE_MIN_MS), now.getTime() + SHARE_MAX_MS);
  return new Date(t);
}

/** The web app serves the page under /app, no sign-in needed (the site itself has no /safe or /m page). */
export const shareUrl = (token: string) => `${config.siteUrl}/app/safe/${token}`;
