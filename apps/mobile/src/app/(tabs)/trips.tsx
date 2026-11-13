import React from 'react';
import { FlatList, Pressable, ScrollView, View, RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, H1, H2, Muted, Avatar, AvatarStack, Empty, Button } from '../../components/ui';
import { range, daysUntil } from '../../components/format';
import { api } from '../../lib/api';
import { useOpenDm } from '../../lib/dm';
import { TripTrendingCard, type TrendingCity } from '../../components/TripTrendingCard';
import { C, F, R, flag, shadow, travelStyleLabel } from '../../lib/theme';

export default function Trips() {
  const mine = useQuery({ queryKey: ['trips'], queryFn: () => api('/trips') });
  const { openDm, openingId, dmSheet } = useOpenDm();
  const trending = useQuery({ queryKey: ['trending'], queryFn: () => api('/trips/trending') });
  const trips = mine.data?.trips ?? [];
  const buddies = useQuery({ queryKey: ['buddies'], queryFn: () => api('/travelers/buddies'), enabled: trips.length > 0 });
  const friendsTrips = useQuery({ queryKey: ['connections-trips'], queryFn: () => api('/connections/trips') });
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: 120 }} refreshControl={<RefreshControl refreshing={mine.isRefetching} onRefresh={() => { mine.refetch(); trending.refetch(); friendsTrips.refetch(); }} tintColor={C.primary} />}>
        <View style={{ paddingHorizontal: 20, paddingTop: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <H1>Trips ✈️</H1>
          <Pressable accessibilityRole="button" accessibilityLabel="Add a trip" onPress={() => router.push('/trip/new')} style={{ backgroundColor: C.primary, width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }}><Ionicons name="add" size={26} color="#fff" /></Pressable>
        </View>
        <Muted style={{ paddingHorizontal: 20, marginTop: 4 }}>Meet people before you land.</Muted>

        {(trending.data?.cities ?? []).length ? <>
          <H2 style={{ paddingHorizontal: 20, marginTop: 24, marginBottom: 12 }}>Trending with travelers</H2>
          <FlatList horizontal data={trending.data.cities} keyExtractor={(c: TrendingCity) => c.cityKey} showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingHorizontal: 20 }}
            renderItem={({ item: c }: { item: TrendingCity }) => (
              <TripTrendingCard c={c} onPress={() => router.push(`/city/${c.cityKey}` as any)} />
            )} />
        </> : null}

        {(friendsTrips.data?.trips ?? []).length ? (
          <>
            <View style={{ paddingHorizontal: 20, marginTop: 24, marginBottom: 12 }}>
              <H2>🌍 Friends Traveling Soon</H2>
              <Muted style={{ fontSize: 13, marginTop: 2 }}>See where connections you met are heading next</Muted>
            </View>
            <FlatList
              horizontal
              data={friendsTrips.data.trips}
              keyExtractor={(item: any) => item.tripId}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 12, paddingHorizontal: 20 }}
              renderItem={({ item: ft }: { item: any }) => (
                <Pressable
                  onPress={() => router.push(`/user/${ft.friendId}`)}
                  style={[{ width: 230, backgroundColor: '#fff', borderRadius: R.lg, padding: 14, gap: 10, borderWidth: 1, borderColor: ft.isOverlapping ? '#34D399' : C.line }, shadow]}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Avatar uri={ft.friendPhotoUrl} name={ft.friendName} size={42} cc={ft.friendHomeCountry} />
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <T style={{ fontFamily: F.b, fontSize: 15 }} numberOfLines={1}>{ft.friendName}</T>
                        {ft.friendVerified ? <T style={{ fontSize: 12 }}>✅</T> : null}
                      </View>
                      <Muted style={{ fontSize: 11 }}>{ft.isMutual ? 'Mutual friend' : 'Connected friend'}</Muted>
                    </View>
                  </View>

                  <View style={{ backgroundColor: ft.isOverlapping ? '#ECFDF5' : C.bgSoft, borderRadius: R.md, padding: 10, gap: 4 }}>
                    <T style={{ fontFamily: F.b, fontSize: 14, color: ft.isOverlapping ? '#065F46' : C.ink }}>
                      {flag(ft.countryCode)} {ft.friendName.split(' ')[0]} is going to {ft.city}
                    </T>
                    <Muted style={{ fontSize: 11 }}>📅 {range(ft.startDate, ft.endDate)}</Muted>
                    {ft.isOverlapping ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                        <T style={{ fontSize: 11, fontFamily: F.b, color: '#059669' }}>🤝 You overlap in {ft.city}!</T>
                      </View>
                    ) : null}
                  </View>

                  <Button
                    title={`Message ${ft.friendName.split(' ')[0]}`}
                    kind={ft.isOverlapping ? 'primary' : 'ghost'}
                    loading={openingId === ft.friendId}
                    onPress={() => openDm(ft.friendId)}
                    style={{ minHeight: 32, paddingVertical: 4 }}
                  />
                </Pressable>
              )}
            />
          </>
        ) : null}

        {(buddies.data?.buddies ?? []).length ? (
          <>
            <View style={{ paddingHorizontal: 20, marginTop: 24, marginBottom: 12 }}>
              <H2>✨ Suggested Travel Buddies</H2>
              <Muted style={{ fontSize: 13, marginTop: 2 }}>Travelers in your destination sharing your dates & vibe</Muted>
            </View>
            <FlatList
              horizontal
              data={buddies.data.buddies}
              keyExtractor={(b: any) => b.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 12, paddingHorizontal: 20 }}
              renderItem={({ item: b }: { item: any }) => (
                <Pressable
                  onPress={() => router.push(`/user/${b.id}`)}
                  style={[{ width: 220, backgroundColor: '#fff', borderRadius: R.lg, padding: 14, gap: 10, borderWidth: 1, borderColor: C.line }, shadow]}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Avatar uri={b.photoUrl} name={b.name} size={44} cc={b.homeCountry} />
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <T style={{ fontFamily: F.b, fontSize: 15 }} numberOfLines={1}>{b.name}{b.age ? `, ${b.age}` : ''}</T>
                        {b.verified ? <T style={{ fontSize: 12 }}>✅</T> : null}
                      </View>
                      <Muted style={{ fontSize: 11 }}>{flag(b.countryCode)} in {b.city}</Muted>
                    </View>
                  </View>
                  <View style={{ backgroundColor: C.primarySoft, borderRadius: R.md, paddingHorizontal: 8, paddingVertical: 4 }}>
                    <T style={{ fontFamily: F.b, fontSize: 11, color: C.primaryDark }}>
                      🗓️ {b.overlapDays} days overlapping
                    </T>
                  </View>
                  {b.matchingStyles?.length ? (
                    <T style={{ fontSize: 11, color: C.ink2 }} numberOfLines={1}>
                      Matches: {b.matchingStyles.map((s: string) => travelStyleLabel(s)).join(', ')}
                    </T>
                  ) : null}
                  <Button
                    title="View Profile"
                    kind="ghost"
                    onPress={() => router.push(`/user/${b.id}`)}
                    style={{ minHeight: 32, paddingVertical: 4 }}
                  />
                </Pressable>
              )}
            />
          </>
        ) : null}

        <H2 style={{ paddingHorizontal: 20, marginTop: 28, marginBottom: 12 }}>Your trips</H2>
        {trips.length === 0 && !mine.isLoading ? <Empty emoji="🧳" title="Where are you heading next?" body="Add a trip and see who'll be there on the same dates." action={<Button title="Add a trip" onPress={() => router.push('/trip/new')} style={{ marginTop: 12, paddingHorizontal: 28 }} />} /> : null}
        <View style={{ gap: 12, paddingHorizontal: 20 }}>
          {trips.map((t: any) => {
            const d = daysUntil(t.startDate);
            return (
              <Pressable key={t.id} onPress={() => router.push(`/trip/${t.id}`)} style={[{ padding: 16, borderRadius: R.lg, backgroundColor: '#fff', gap: 12 }, shadow]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <T style={{ fontSize: 34 }}>{flag(t.countryCode)}</T>
                  <View style={{ flex: 1 }}><T style={{ fontFamily: F.b, fontSize: 18 }}>{t.city}</T><Muted>📅 {range(t.startDate, t.endDate)}</Muted></View>
                  <View style={{ backgroundColor: d <= 0 ? C.goSoft : C.primarySoft, borderRadius: R.pill, paddingHorizontal: 10, paddingVertical: 4 }}>
                    <T style={{ fontFamily: F.b, fontSize: 12, color: d <= 0 ? C.go : C.primaryDark }}>{d <= 0 ? "You're here" : `in ${d} day${d === 1 ? '' : 's'}`}</T>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <AvatarStack people={t.overlapFaces} size={30} extra={Math.max(0, t.overlapCount - t.overlapFaces.length)} />
                  <T style={{ fontFamily: F.sb, color: C.ink2, flex: 1 }}>{t.overlapCount ? `${t.overlapCount} traveler${t.overlapCount === 1 ? '' : 's'} there on your dates` : 'Be the first on these dates'}</T>
                </View>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
      {dmSheet}
    </SafeAreaView>
  );
}
