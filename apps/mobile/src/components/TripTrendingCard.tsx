import React from 'react';
import { Pressable, View } from 'react-native';
import { T, Muted, AvatarStack } from './ui';
import { range } from './format';
import { C, F, R, flag } from '../lib/theme';

export type TrendingCity = {
  city: string; countryCode: string; cityKey: string; travelers: number;
  firstDate?: string | null; lastDate?: string | null; faces?: { id: string; name?: string | null; photoUrl?: string | null }[];
};

export function TripTrendingCard({ c, onPress }: { c: TrendingCity; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ width: 160, padding: 14, borderRadius: R.lg, backgroundColor: '#fff', borderWidth: 1, borderColor: C.line, gap: 6 }}>
      <T style={{ fontSize: 30 }}>{flag(c.countryCode)}</T>
      <T style={{ fontFamily: F.b, fontSize: 16 }} numberOfLines={1}>{c.city}</T>
      <Muted style={{ fontSize: 12.5 }} numberOfLines={1}>{c.firstDate && c.lastDate ? range(c.firstDate, c.lastDate) : 'Next 30 days'}</Muted>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}>
        {c.faces?.length ? <AvatarStack people={c.faces} size={24} max={3} /> : null}
        <T style={{ fontFamily: F.sb, fontSize: 13, color: C.primary }}>{c.travelers} going</T>
      </View>
    </Pressable>
  );
}
