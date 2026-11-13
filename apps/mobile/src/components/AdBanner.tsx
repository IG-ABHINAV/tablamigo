// NOT MOUNTED ANYWHERE, ON PURPOSE. The Play Console "Contains ads" declaration is No, and AdSense was never integrated, so
// no screen shows this banner (it used to be the footer of the Explore list). Nothing imports this file, so Metro leaves
// it out of the bundle. Before importing it again: change the declaration to "Contains ads", add the ads disclosure to
// the Data safety form, and check the partner placements against Play's Ads policy.
import React from 'react';
import { View, Pressable, Linking } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, Muted } from './ui';
import { api } from '../lib/api';
import { C, F, R } from '../lib/theme';

interface AdBannerProps {
  city?: string | null;
  style?: any;
}

export function AdBanner({ city, style }: AdBannerProps) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me') });
  // Both hooks run on every render; the early returns come after them (a hook after an early return crashes React the
  // moment `plus` flips). Plus subscribers never see any ads, so their query stays off.
  const plus = !!me.data?.plus;
  const adsQ = useQuery({
    queryKey: ['active-ads', city],
    queryFn: () => api(`/ads/active${city ? `?city=${encodeURIComponent(city)}` : ''}`),
    staleTime: 5 * 60_000,
    enabled: !plus,
  });

  if (plus) return null;

  // Only real, active sponsored_ads rows. There is no made-up "Sponsored Partner" fallback: with no paying
  // partner the banner renders nothing.
  const ad = adsQ.data?.ads?.[0];
  if (!ad) return null;

  return (
    <Pressable
      onPress={() => Linking.openURL(ad.targetUrl).catch(() => {})}
      style={[
        {
          backgroundColor: '#fff',
          borderRadius: R.lg,
          padding: 14,
          marginVertical: 10,
          borderWidth: 1,
          borderColor: '#FED7AA',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          shadowColor: '#EA580C',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.05,
          shadowRadius: 8,
          elevation: 2,
        },
        style,
      ]}
    >
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 14,
          backgroundColor: '#FFF7ED',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <T style={{ fontSize: 24 }}>{ad.emoji}</T>
      </View>

      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <View
            style={{
              backgroundColor: '#FFEDD5',
              paddingHorizontal: 6,
              paddingVertical: 1,
              borderRadius: 4,
            }}
          >
            <T style={{ fontSize: 10, fontFamily: F.b, color: '#C2410C' }}>
              {ad.badgeText}
            </T>
          </View>
          <Muted style={{ fontSize: 11 }}>Free Tier Ad</Muted>
        </View>
        <T style={{ fontFamily: F.b, fontSize: 13, color: C.ink }} numberOfLines={1}>
          {ad.title}
        </T>
        <Muted style={{ fontSize: 11 }} numberOfLines={1}>
          {ad.subtitle}
        </Muted>
      </View>

      <View
        style={{
          backgroundColor: '#FFF7ED',
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderRadius: R.md,
          borderWidth: 1,
          borderColor: '#FDBA74',
        }}
      >
        <T style={{ fontSize: 11, fontFamily: F.b, color: '#C2410C' }}>{ad.ctaText} →</T>
      </View>
    </Pressable>
  );
}
