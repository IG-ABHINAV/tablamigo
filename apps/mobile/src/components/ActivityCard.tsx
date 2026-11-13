import React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { C, F, R, shadow } from '../lib/theme';
import { T, Muted, AvatarStack, Pill } from './ui';
import { when, km } from './format';
import { planTitleAfterVerb } from '../lib/plan-title';
import type { QuickJoin } from '../lib/useQuickJoin';

export type Activity = {
  id: string; title: string; emoji: string; category: string; placeName: string; city?: string | null; startsAt: string; going: number; maxPeople?: number | null;
  womenOnly: boolean; joined: boolean; closed?: boolean; distanceM?: number; host: { id: string; name: string; photoUrl?: string | null; homeCountry?: string | null };
  members: { id: string; name: string; photoUrl?: string | null }[]; lat: number; lng: number; chatId?: string;
  isPaid?: boolean; ticketPricePaise?: number | null;
  savedNotes?: string | null; cachedAt?: string;
};

/**
 * `onOpen` runs before the plan opens (a sheet that shows the card closes itself first). With `quickJoin` (lib/useQuickJoin.tsx)
 * a plan the person can join shows a Join button that joins and opens the group chat without the plan page.
 */
export function ActivityCard({ a, compact, onOpen, quickJoin }: { a: Activity; compact?: boolean; onOpen?: () => void; quickJoin?: QuickJoin }) {
  const soon = when(a.startsAt);
  const left = a.maxPeople ? a.maxPeople - a.going : null;
  // A social-proof tag: filling up fast beats a big number.
  const popular = left != null && left > 0 && left <= 2 ? 'Almost full' : a.going >= 5 ? '🔥 Popular' : null;
  return (
    <Pressable onPress={() => { onOpen?.(); router.push(`/activity/${a.id}`); }}
      style={({ pressed }) => [{ backgroundColor: C.card, borderRadius: R.lg, padding: 16, gap: 12, borderWidth: 1, borderColor: C.line, transform: [{ scale: pressed ? 0.985 : 1 }] }, compact ? null : shadow]}>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: C.bgSoft, alignItems: 'center', justifyContent: 'center' }}>
          <T style={{ fontSize: 28 }}>{a.emoji}</T>
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <T numberOfLines={2} style={{ fontSize: 16, lineHeight: 21 }}>
            <T style={{ fontFamily: F.b, color: C.primary }}>{a.host.name}</T>
            <T style={{ fontFamily: F.m }}> wants to </T>
            <T style={{ fontFamily: F.b }}>{planTitleAfterVerb(a.title)}</T>
          </T>
          <Muted numberOfLines={1}>📍 {a.placeName}{a.distanceM != null ? ` · ${km(a.distanceM)}` : ''}</Muted>
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', rowGap: 8, columnGap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <AvatarStack people={a.members} size={28} extra={Math.max(0, a.going - a.members.length)} />
          <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink2 }}>{a.going} going{a.maxPeople ? ` · ${a.maxPeople - a.going} spots left` : ''}</T>
        </View>
        <View style={{ flexDirection: 'row', gap: 6, marginLeft: 'auto' }}>
          {a.isPaid && a.ticketPricePaise ? <Pill bg="#FEF3C7" fg="#B45309">🎟️ ₹{Math.round(a.ticketPricePaise / 100)}</Pill> : null}
          {popular ? <Pill bg="#FFF4D6" fg="#9A6700">{popular}</Pill> : null}
          {a.womenOnly ? <Pill bg={C.womenSoft} fg={C.women}>Women only</Pill> : null}
          <Pill bg={soon === 'Happening now' ? C.goSoft : C.primarySoft} fg={soon === 'Happening now' ? C.go : C.primaryDark}>{soon}</Pill>
        </View>
      </View>
      {quickJoin?.can(a) ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Join ${a.host.name}'s plan`} disabled={!!quickJoin.joiningId}
          onPress={() => { onOpen?.(); quickJoin.join(a.id); }}
          style={({ pressed }) => ({ height: 40, borderRadius: R.pill, backgroundColor: C.go, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, opacity: pressed || quickJoin.joiningId ? 0.7 : 1 })}>
          {quickJoin.joiningId === a.id ? <ActivityIndicator color="#fff" size="small" /> : <T style={{ color: '#fff', fontFamily: F.b, fontSize: 14.5 }}>Join · open the group chat</T>}
        </Pressable>
      ) : null}
    </Pressable>
  );
}
