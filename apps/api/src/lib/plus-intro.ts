/**
 * The soft paywall right after onboarding (NomadTable teardown gap 4, 1 Nov 2026). Tablamigo showed Plus only when someone hit a
 * locked action; this is one Plus screen, once, after the "what now" screen (apps/mobile/src/app/start.tsx), with a clear "Not
 * now" that blocks nothing.
 *
 * Once per account, decided here and nowhere else: the first POST /me/plus-intro writes users.plus_intro_seen_at, and only the
 * call that wrote it can answer show = true. A second device, a reinstall or a replayed request finds it written and gets false.
 * It is written even when the answer is false (a Plus account, everything free), so the screen can't turn up weeks later
 * either. An admin looking at the account (impersonation) never uses it up.
 */
import { sql } from './db.js';
import { config } from './config.js';
import { clock } from './clock.js';
import { isPlus, allFree, launchOffer } from './plus.js';

/** Only a new account is offered it: the screen follows onboarding, which every account sees once, on its first days. */
export const PLUS_INTRO_NEW_ACCOUNT_DAYS = 7;

export type PlusIntro = { show: boolean; reason: 'show' | 'seen' | 'plus' | 'nothing_to_sell' | 'not_new' | 'impersonated' };

export async function claimPlusIntro(userId: string, opts: { impersonated?: boolean; now?: Date } = {}): Promise<PlusIntro> {
  if (opts.impersonated) return { show: false, reason: 'impersonated' };
  const now = opts.now ?? clock.now();
  const [u] = await sql`update users set plus_intro_seen_at = ${now}
    where id = ${userId} and plus_intro_seen_at is null and deleted_at is null
    returning created_at`;
  if (!u) return { show: false, reason: 'seen' };
  // Nothing is sold while everything is free or the launch offer gives everyone Plus.
  if (allFree() || launchOffer(now).active) return { show: false, reason: 'nothing_to_sell' };
  if (await isPlus(userId)) return { show: false, reason: 'plus' };
  if (now.getTime() - new Date(u.createdAt).getTime() > PLUS_INTRO_NEW_ACCOUNT_DAYS * 86_400_000) return { show: false, reason: 'not_new' };
  return { show: true, reason: 'show' };
}

/** The yearly plan's Play trial offer the app may use, or null (no trial text, no trial purchase). */
export const yearlyTrialOfferId = () => config.playYearlyTrialOfferId;
