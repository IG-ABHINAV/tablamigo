import React from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { T, Muted } from './ui';
import { api } from '../lib/api';
import { liveCity, liveLine, type SocialProof } from '../lib/social-proof';
import { C, F, R, flag } from '../lib/theme';

/**
 * Explore's live counts for the person's city (lib/social-proof.ts), above the plan list. Renders nothing until the city has
 * 10+ upcoming trips from real travellers, and nothing when the call fails.
 */
export function LiveCity({ city }: { city: string | null }) {
  const q = useQuery({ queryKey: ['social-proof'], queryFn: () => api<SocialProof>('/public/social-proof'), staleTime: 5 * 60_000, retry: false });
  const c = liveCity(q.data, city);
  if (!c) return null;
  const others = (q.data?.trending ?? []).filter(t => t.cityKey !== c.cityKey).slice(0, 3);
  return (
    <View style={{ padding: 14, borderRadius: R.lg, backgroundColor: C.primarySoft, gap: 4, marginBottom: 4 }} accessibilityRole="summary">
      <T style={{ fontFamily: F.b, fontSize: 15 }}>🔥 {c.city} is busy</T>
      <Muted style={{ fontSize: 13 }}>{liveLine(c)}</Muted>
      {others.length ? <Muted style={{ fontSize: 12.5 }}>Trending trips: {others.map(t => `${flag(t.countryCode)} ${t.city}`).join(' · ')}</Muted> : null}
    </View>
  );
}
