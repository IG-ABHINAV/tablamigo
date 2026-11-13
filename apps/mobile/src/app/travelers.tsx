import React, { useState } from 'react';
import { FlatList, Pressable, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, H1, Muted, Avatar, Chip, Empty, PlusBadge, BackButton } from '../components/ui';
import { km } from '../components/format';
import { api } from '../lib/api';
import { useHere } from '../lib/useHere';
import { NoPlace, PlaceNote } from '../components/NoPlace';
import { COUNTRIES } from '../lib/countries';
import { C, F, R } from '../lib/theme';

const cname = (cc: string) => COUNTRIES.find(c => c[0] === cc)?.[1] ?? cc;
const AGES = [['Any age', ''], ['18-25', '&min_age=18&max_age=25'], ['26-35', '&min_age=26&max_age=35'], ['36-45', '&min_age=36&max_age=45'], ['46+', '&min_age=46']];
const TRAVEL_STYLE_OPTIONS = [
  ['Foodie 🍜', 'foodie'],
  ['Hiker 🥾', 'hiker'],
  ['Night owl 🌙', 'night owl'],
  ['Culture 🏛️', 'culture'],
  ['Party 🎉', 'party'],
];

export default function Travelers() {
  // A real place or nothing: never a made-up city (lib/where.ts).
  const { here, settled } = useHere();
  const pos = here ?? { lat: 0, lng: 0 };
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me') });
  const [ages, setAges] = useState('');
  const [womenOnly, setWomenOnly] = useState(false);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [selectedStyle, setSelectedStyle] = useState<string | null>(null);

  const isPlusUser = !!me.data?.plus;

  const handleAdvancedFilter = (apply: () => void) => {
    if (!isPlusUser) {
      router.push('/paywall?reason=advanced_filters');
      return;
    }
    apply();
  };

  const advQs = `${verifiedOnly ? '&verified_only=true' : ''}${selectedStyle ? `&travel_style=${encodeURIComponent(selectedStyle)}` : ''}`;

  const q = useQuery({
    queryKey: ['travelers-full', pos.lat.toFixed(2), pos.lng.toFixed(2), ages, womenOnly, verifiedOnly, selectedStyle],
    queryFn: () => api(`/travelers?lat=${pos.lat}&lng=${pos.lng}${ages}${womenOnly ? '&women_only=true' : ''}${advQs}`),
    enabled: !!here,
  });
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 8 }}>
        <BackButton />
      </View>
      {!here ? <NoPlace settled={settled} /> : <>
      <View style={{ paddingHorizontal: 20, gap: 2, paddingBottom: 10 }}>
        <H1>{q.data?.count ?? '…'} travelers in the area</H1>
        <Muted>Active in the last 3 days</Muted>
        <PlaceNote here={here} style={{ marginTop: 8, alignSelf: 'flex-start' }} />
      </View>
      <View style={{ gap: 8 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
          {me.data?.gender === 'woman' ? (
            <Chip label="Women only 🌸" active={womenOnly} onPress={() => setWomenOnly(v => !v)} />
          ) : null}
          {AGES.map(([label, qs]) => <Chip key={label} label={label} active={ages === qs} onPress={() => setAges(qs)} />)}
        </ScrollView>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
          <Chip
            label={isPlusUser ? 'Verified only ✨' : 'Verified only 🔒'}
            active={verifiedOnly}
            onPress={() => handleAdvancedFilter(() => setVerifiedOnly(v => !v))}
          />
          {TRAVEL_STYLE_OPTIONS.map(([label, styleVal]) => (
            <Chip
              key={styleVal}
              label={isPlusUser ? label : `${label} 🔒`}
              active={selectedStyle === styleVal}
              onPress={() => handleAdvancedFilter(() => setSelectedStyle(prev => prev === styleVal ? null : styleVal))}
            />
          ))}
        </ScrollView>
      </View>
      {/* GET /travelers `wider`: nobody within 30 km, so the nearest travelers further out, nearest first. */}
      <FlatList data={q.data?.travelers?.length ? q.data.travelers : q.data?.wider?.travelers ?? []} keyExtractor={(u: any) => u.id} contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 60 }}
        ListHeaderComponent={!q.data?.travelers?.length && q.data?.wider?.travelers?.length ? <Muted style={{ paddingBottom: 4 }}>Nobody within 30 km yet. The nearest travelers, up to {q.data.wider.radiusKm} km away:</Muted> : null}
        ListEmptyComponent={q.isLoading ? null : <Empty emoji="🧭" title={ages ? 'Nobody that age nearby' : 'Quiet around here'} body={ages ? 'Try another age range.' : 'Post a plan. Travelers arriving today will see it.'} />}
        renderItem={({ item: u }: any) => (
          <Pressable onPress={() => router.push(`/user/${u.id}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: R.lg, backgroundColor: u.boosted ? '#FFFDF5' : '#fff', borderWidth: 1, borderColor: u.boosted ? '#FCD34D' : C.line }}>
            <View><Avatar uri={u.photoUrl} name={u.name} size={54} cc={u.homeCountry} />{u.online ? <View style={{ position: 'absolute', top: 1, right: 1, width: 14, height: 14, borderRadius: 7, backgroundColor: C.go, borderWidth: 2, borderColor: '#fff' }} /> : null}</View>
            <View style={{ flex: 1, gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                <T style={{ fontFamily: F.b, fontSize: 16 }}>{u.name}{u.age ? `, ${u.age}` : ''} {u.verified ? '✅ ' : ''}{u.plus ? <PlusBadge /> : null}</T>
                {u.boosted ? (
                  <View style={{ backgroundColor: '#FEF3C7', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                    <T style={{ color: '#D97706', fontSize: 11, fontFamily: F.b }}>⚡ Spotlight</T>
                  </View>
                ) : null}
              </View>
              <Muted style={{ fontSize: 13 }}>{cname(u.homeCountry)} · {km(u.distanceM)} away</Muted>
              {u.travelStyle?.length ? (
                <T style={{ fontSize: 11.5, color: '#4B5563' }}>🎒 {u.travelStyle.slice(0, 3).join(' · ')}</T>
              ) : null}
              {u.shared ? <T style={{ fontSize: 12.5, color: C.primaryDark, fontFamily: F.sb }}>✓ {u.shared} shared interest{u.shared === 1 ? '' : 's'}</T> : null}
            </View>
            <Ionicons name="chevron-forward" size={18} color={C.ink3} />
          </Pressable>
        )} />
      </>}
    </SafeAreaView>
  );
}
