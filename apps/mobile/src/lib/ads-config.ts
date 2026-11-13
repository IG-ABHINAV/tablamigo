// Who sees an ad, and what the build says about ads. Plain TypeScript, no React imports, so e2e-web/ads.test.mjs can import it.
// The build's settings come from app.config.js (`extra.ads`, from ads-env.js); the account's from GET /me.

export type AdsExtra = { enabled: boolean; bannerUnitId: string; testIds: boolean };

/**
 * The build's ad settings. Ads exist only in an Android build made with ADS_ENABLED=on, the only build that links the Google
 * Mobile Ads SDK (react-native.config.js). Anything else (iOS, the web app, an older build without `extra.ads`) has none.
 */
export function readAdsExtra(extra: unknown, platform: string): AdsExtra {
  const x = extra as Partial<AdsExtra> | null | undefined;
  const unit = typeof x?.bannerUnitId === 'string' ? x.bannerUnitId : '';
  const enabled = platform === 'android' && x?.enabled === true && unit.length > 0;
  return { enabled, bannerUnitId: enabled ? unit : '', testIds: x?.testIds === true };
}

/**
 * Where the one ad goes: the Explore list's banner exists only after the last plan of a list that has plans, and only once the
 * person has scrolled that list themselves. Until then the list may be closed or half open with its end off screen, and an ad
 * must not be requested where nobody can see it.
 */
export function exploreAdSlot(plans: number, scrolledByUser: boolean): boolean {
  return plans > 0 && scrolledByUser === true;
}

/**
 * Whether this account sees ads: only a free account. GET /me says `plus: true` for a subscription, a Trip Pass, comped days
 * (invite rewards, launch offer, the Play reviewer) and whenever everything is free (apps/api/src/lib/plus.ts isPlus). Until
 * /me has answered, or if it has no `plus` field, the answer is no, so a Plus member never sees an ad while it loads.
 */
export function showsAds(me: unknown): boolean {
  const m = me as { plus?: unknown; allFree?: unknown } | null | undefined;
  return !!m && typeof m === 'object' && m.plus === false && m.allFree !== true;
}

/**
 * The "Remove ads" link under the Explore banner (components/ExploreAd.tsx): plain text in the app's own style, outside the ad's
 * box and below it with a gap, so it never reads as part of the ad (AdMob: content next to an ad must not look like it or invite
 * clicks on it). It renders only together with the banner, so it follows showsAds: never for Plus, a Trip Pass, comped days,
 * while everything is free, or before /me has answered. It opens the paywall with its own reason, recorded like the others.
 */
export const REMOVE_ADS_LINK = { label: 'Remove ads · Get Plus', href: '/paywall?reason=remove_ads' } as const;
