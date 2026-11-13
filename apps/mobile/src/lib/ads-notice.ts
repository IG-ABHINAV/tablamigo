// The one-time notice before the first ad. The privacy policy promises: "If we change this policy in a meaningful way, we'll
// tell you in the app before the change takes effect" (apps/web/src/privacy.html, section 9). Ads are such a change, so in a
// build with ads a free account sees this once, and Google's consent step and the SDK (lib/ads.ts startAds) wait until it is
// dismissed. Plain TypeScript (the storage is passed in), so tests/unit/ads-notice.test.mjs can drive it.

export const ADS_NOTICE_KEY = 'tablamigo.ads-notice.v1';

export const ADS_NOTICE = {
  title: 'A small change: one ad for free accounts',
  body: 'Tablamigo stays free to join, chat and meet people. To keep it that way, free accounts now see one Google ad at the end of the Explore list of plans. No ads in chats, messages, plans or your profile, and none at all with Plus.',
  privacy: "Google's ad service collects some device data to show and measure ads. Our Privacy Policy says what, and where you're asked, you can choose.",
};

/**
 * The same notice for someone who has just joined: to them ads are not a change, so "A small change ... now see" read oddly
 * as the first thing a brand-new account was shown (QA 1 Nov 2026). Same facts, same privacy line, same links.
 */
export const ADS_NOTICE_NEW = {
  ...ADS_NOTICE,
  title: 'One ad for free accounts',
  body: 'Tablamigo is free to join, chat and meet people. To keep it that way, free accounts see one Google ad at the end of the Explore list of plans. No ads in chats, messages, plans or your profile, and none at all with Plus.',
};

/** Which wording: the "change" one for accounts older than a week, the plain one for newer accounts (or when the date is unknown). */
export function adsNoticeCopy(createdAt?: string | null, now = new Date()) {
  const t = createdAt ? new Date(createdAt).getTime() : NaN;
  return Number.isFinite(t) && now.getTime() - t > 7 * 86_400_000 ? ADS_NOTICE : ADS_NOTICE_NEW;
}

export type NoticeStore = { get(key: string): Promise<string | null>; set(key: string, v: string): Promise<void> };

/** Whether the notice still has to be shown: only in a build with ads, only to an account that would see them, only once. */
export async function needsAdsNotice(store: NoticeStore, buildHasAds: boolean, accountSeesAds: boolean): Promise<boolean> {
  if (!buildHasAds || !accountSeesAds) return false;
  try { return (await store.get(ADS_NOTICE_KEY)) !== 'seen'; }
  // Storage unreadable: show it again rather than risk ads before anyone was told.
  catch { return true; }
}

export async function markAdsNoticeSeen(store: NoticeStore): Promise<void> {
  try { await store.set(ADS_NOTICE_KEY, 'seen'); } catch { /* shown again next start: harmless */ }
}
