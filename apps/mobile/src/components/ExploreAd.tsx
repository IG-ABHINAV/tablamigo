// The app's one ad placement: a Google AdMob inline adaptive banner at the END of the Explore tab's list of plans, after the last
// plan card, with space and an "Advertisement" label between them. It scrolls with the list like any row, so it never floats over
// content and never sits next to the tab bar or between a plan card and its buttons (AdMob's banner guidance on accidental clicks).
// Not on the map, the empty or starter list, welcome, sign-in, onboarding, chats, direct messages, plan pages, the join flow, the
// paywall or Plus screens. Shown only in a build with ADS_ENABLED=on, after Google's consent step (lib/ads.ts), and only to free
// accounts (lib/ads-config.ts showsAds). There are no interstitial, app-open or rewarded ads anywhere in the app. Under the banner,
// a gap and then the app's own "Remove ads · Get Plus" link (lib/ads-config.ts REMOVE_ADS_LINK), shown only with the banner.
import React, { useEffect, useState } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ADS, gma, useAds } from '../lib/ads';
import { REMOVE_ADS_LINK, showsAds } from '../lib/ads-config';
import { T } from './ui';
import { C, F } from '../lib/theme';

export function ExploreAd() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me') });
  const ready = useAds(s => s.ready);
  const { width } = useWindowDimensions();
  // No fill or an error: give the space back instead of leaving an empty labelled box, and ask again a minute later (the Explore
  // tab stays mounted, so waiting for a remount would mean no banner for the rest of the session).
  const [failed, setFailed] = useState(false);
  // The Remove ads link waits for the banner itself, so it never sits under an empty gap.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!failed) return;
    const t = setTimeout(() => setFailed(false), 60_000);
    return () => clearTimeout(t);
  }, [failed]);
  if (!gma || !ready || failed || !showsAds(me.data)) return null;
  const { BannerAd, BannerAdSize } = gma;
  return (
    <View style={{ marginTop: 28, alignItems: 'center', gap: 6 }}>
      <T style={{ fontFamily: F.b, fontSize: 11, letterSpacing: 0.6, color: C.ink3, textTransform: 'uppercase' }}>Advertisement</T>
      {/* The list has 16 px padding each side. 250 is the tallest it may get (a medium rectangle), well under a screen. */}
      <BannerAd unitId={ADS.bannerUnitId} size={BannerAdSize.INLINE_ADAPTIVE_BANNER} width={Math.max(0, width - 32)} maxHeight={250}
        onAdLoaded={() => setLoaded(true)} onAdFailedToLoad={() => { setLoaded(false); setFailed(true); }} />
      {/* Ours, not the ad's: outside the banner, 14 px below it, plain text in the app's colours, no box or button look. */}
      {loaded ? <Pressable accessibilityRole="link" onPress={() => router.push(REMOVE_ADS_LINK.href as any)} hitSlop={8}
        style={{ marginTop: 14, minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 }}>
        <T style={{ fontFamily: F.b, fontSize: 13, color: C.primaryDark }}>{REMOVE_ADS_LINK.label}</T>
      </Pressable> : null}
    </View>
  );
}
