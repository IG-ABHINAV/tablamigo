import React, { useState } from 'react';
import { Alert, FlatList, Pressable, ScrollView, View, ActivityIndicator } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, H1, H2, Muted, Avatar, Empty, Button, Pill, BackButton } from '../../components/ui';
import { when } from '../../components/format';
import { CityTipsSection } from '../../components/CityTipsSection';
import { api, ApiError } from '../../lib/api';
import { useOpenDm } from '../../lib/dm';
import { queryClient } from '../../lib/query';
import { arrivalLabel, byArrival } from '../../lib/arrivals';
import { C, F, R, flag, shadow } from '../../lib/theme';

export default function CityPage() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const [joiningChat, setJoiningChat] = useState(false);
  const { openDm, openingId, dmSheet } = useOpenDm();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<any>('/me') });
  const isWoman = me.data?.gender === 'woman';

  const q = useQuery({
    queryKey: ['city-guide', slug],
    queryFn: () => api<any>(`/cities/${slug}`),
    enabled: !!slug
  });
  const hereNow = useQuery({
    queryKey: ['city-here-now', slug],
    queryFn: () => api<any>(`/cities/${slug}/here-now`),
    enabled: !!slug && q.data?.guide === true
  });

  const city = q.data;
  // Off by default for everyone (migration 053); this is the only place to turn it on, next to the list it puts you in.
  const myHereNow = useQuery({ queryKey: ['me-here-now'], queryFn: () => api<any>('/me/here-now') });
  const setHereNow = useMutation({
    mutationFn: (optIn: boolean) => api<any>('/me/here-now', { method: 'PUT', body: { optIn } }),
    onSuccess: r => { queryClient.setQueryData(['me-here-now'], r); queryClient.invalidateQueries({ queryKey: ['city-here-now'] }); },
    onError: e => Alert.alert("Couldn't change that", e instanceof ApiError ? e.message : 'No connection.'),
  });
  const visible = !!myHereNow.data?.optIn;

  const handleJoinChat = async (womenOnly: boolean) => {
    try {
      setJoiningChat(true);
      const res = await api<any>(`/cities/${slug}/join-chat`, {
        method: 'POST',
        body: { womenOnly }
      });
      if (res?.chatId) {
        router.push(`/chat/${res.chatId}` as any);
      }
    } catch (e) {
      // Free accounts join a city chat once they're in the city or a trip there is a few days away.
      if (e instanceof ApiError && e.code === 'plus_required') router.push('/paywall?reason=city_chat');
      else Alert.alert("Couldn't join the chat", e instanceof ApiError ? e.message : 'No connection.');
    } finally {
      setJoiningChat(false);
    }
  };

  if (q.isLoading) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={C.primary} />
      </SafeAreaView>
    );
  }

  if (!city) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg, padding: 20 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={12} style={{ marginBottom: 20 }}>
          <Ionicons name="chevron-back" size={28} color={C.ink} />
        </Pressable>
        <Empty emoji="🏙️" title="Nothing here yet" body="Nobody has posted a plan, a trip or a moment from this place yet." />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top']}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8 }}>
        <BackButton />
        <T style={{ fontFamily: F.b, fontSize: 16 }}>{city.guide === false ? city.city : `${city.city} City Hub`}</T>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 100, gap: 20 }}>
        {/* City Hero Banner */}
        <View style={{ paddingHorizontal: 20, paddingTop: 10, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <T style={{ fontSize: 36 }}>{city.emoji}</T>
            <View style={{ flex: 1 }}>
              <H1>{city.city}</H1>
              <Muted style={{ fontSize: 14 }}>{city.countryCode ? `${flag(city.countryCode)} ` : ''}{city.country ?? ''}{city.guide !== false ? `${city.country ? ' · ' : ''}${city.travelersCount || 0} travelers visiting` : ''}</Muted>
            </View>
          </View>
          {city.intro ? (
            <T style={{ fontSize: 15, color: C.ink2, lineHeight: 22, marginTop: 4 }}>
              {city.intro}
            </T>
          ) : null}
        </View>

        {/* Quick Actions */}
        <View style={{ paddingHorizontal: 20, flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {/* A place without a guide has no city chat (the API opens one for guides only). */}
          {city.guide !== false ? (
            <Button
              title="💬 City Chat"
              onPress={() => handleJoinChat(false)}
              loading={joiningChat}
              style={{ flex: 1, minWidth: 120 }}
            />
          ) : null}
          {isWoman && city.guide !== false ? (
            <Button
              title="🌸 Women's Chat"
              kind="women"
              onPress={() => handleJoinChat(true)}
              loading={joiningChat}
              style={{ flex: 1, minWidth: 140 }}
            />
          ) : null}
          <Button
            title="➕ Post Plan"
            kind="ghost"
            onPress={() => router.push('/activity/new')}
            style={{ flex: 1, minWidth: 110 }}
          />
        </View>

        {/* Upcoming Plans */}
        <View style={{ gap: 12 }}>
          <View style={{ paddingHorizontal: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <H2>Upcoming Plans in {city.city} ({city.activities?.length || 0})</H2>
          </View>
          {city.activities?.length ? (
            <View style={{ paddingHorizontal: 20, gap: 10 }}>
              {city.activities.map((a: any) => (
                <Pressable
                  key={a.id}
                  onPress={() => router.push(`/activity/${a.id}`)}
                  style={[{ backgroundColor: '#fff', borderRadius: R.lg, padding: 16, borderWidth: 1, borderColor: C.line, gap: 8 }, shadow]}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                      <T style={{ fontSize: 24 }}>{a.emoji || '✨'}</T>
                      <T style={{ fontFamily: F.b, fontSize: 16, flex: 1 }} numberOfLines={1}>{a.title}</T>
                    </View>
                    <Pill bg={C.primarySoft} fg={C.primaryDark}>{a.category}</Pill>
                  </View>
                  <Muted style={{ fontSize: 13 }}>📍 {a.placeName} · {when(a.startsAt)}</Muted>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Avatar uri={a.host.photoUrl} name={a.host.name} size={28} cc={a.host.homeCountry} />
                      <T style={{ fontSize: 13, fontFamily: F.m }}>Hosted by {a.host.name} {a.host.verified ? '✅' : ''}</T>
                    </View>
                    <T style={{ fontSize: 13, fontFamily: F.sb, color: C.go }}>👥 {a.going}{a.maxPeople ? `/${a.maxPeople}` : ''} going</T>
                  </View>
                </Pressable>
              ))}
            </View>
          ) : (
            <View style={{ paddingHorizontal: 20 }}>
              <View style={{ backgroundColor: '#fff', borderRadius: R.lg, padding: 20, alignItems: 'center', gap: 8, borderWidth: 1, borderColor: C.line }}>
                <T style={{ fontSize: 28 }}>🧭</T>
                <T style={{ fontFamily: F.b, fontSize: 15 }}>No plans posted yet</T>
                <Muted style={{ textAlign: 'center', fontSize: 13 }}>Be the first to post a coffee, food, or sunset plan in {city.city}!</Muted>
                <Button title="Post a Plan" onPress={() => router.push('/activity/new')} style={{ marginTop: 8 }} />
              </View>
            </View>
          )}
        </View>

        {/* Travelers Visiting Soon */}
        {city.visitingTravelers?.length ? (
          <View style={{ gap: 12 }}>
            <View style={{ paddingHorizontal: 20 }}>
              <H2>Here now & landing soon ({city.visitingTravelers.length})</H2>
            </View>
            <FlatList
              horizontal
              data={byArrival(city.visitingTravelers)}
              keyExtractor={(u: any) => u.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 20, gap: 12 }}
              renderItem={({ item: u }: any) => (
                <Pressable
                  onPress={() => router.push(`/user/${u.id}`)}
                  style={[{ width: 140, backgroundColor: '#fff', borderRadius: R.lg, padding: 12, alignItems: 'center', gap: 6, borderWidth: 1, borderColor: C.line }, shadow]}
                >
                  <Avatar uri={u.photoUrl} name={u.name} size={48} cc={u.homeCountry} />
                  <T style={{ fontFamily: F.b, fontSize: 14, textAlign: 'center' }} numberOfLines={1}>{u.name}{u.age ? `, ${u.age}` : ''}</T>
                  <Muted style={{ fontSize: 11, textAlign: 'center' }}>{flag(u.homeCountry)} {arrivalLabel(u.tripStartDate?.slice(0, 10)) ?? ''}</Muted>
                </Pressable>
              )}
            />
          </View>
        ) : null}

        {/* Who's Here Now: people who chose to be listed, and the switch to be listed. Curated guides only (the API lists
            no people for a place without one). */}
        {city.guide !== false ? <View style={{ gap: 12 }}>
          <View style={{ paddingHorizontal: 20, gap: 8 }}>
            <H2>Who's Here Now 📍{(hereNow.data?.travelers ?? []).length ? ` (${hereNow.data.count})` : ''}</H2>
            <Pressable accessibilityRole="switch" accessibilityState={{ checked: visible }} accessibilityLabel="Show me in Who's here now"
              disabled={!myHereNow.data || setHereNow.isPending} onPress={() => setHereNow.mutate(!visible)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: R.md, backgroundColor: visible ? C.goSoft : '#fff', borderWidth: 1, borderColor: C.line }}>
              <Ionicons name={visible ? 'eye' : 'eye-off-outline'} size={20} color={visible ? C.go : C.ink2} />
              <View style={{ flex: 1 }}>
                <T style={{ fontFamily: F.b, fontSize: 14 }}>{visible ? "You're listed in Who's here now" : "Show me in Who's here now"}</T>
                <Muted style={{ fontSize: 12 }}>{visible ? 'Travelers in the city you\'re in can see you and say hi. Tap to hide.' : 'Let travelers in the city you\'re in see you\'re around and say hi. Off by default.'}</Muted>
              </View>
              <View style={{ width: 40, height: 24, borderRadius: 12, backgroundColor: visible ? C.go : C.line, padding: 2, alignItems: visible ? 'flex-end' : 'flex-start' }}>
                <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' }} />
              </View>
            </Pressable>
          </View>
        {(hereNow.data?.travelers ?? []).length ? (
            <FlatList
              horizontal
              data={hereNow.data.travelers}
              keyExtractor={(u: any) => u.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 20, gap: 12 }}
              renderItem={({ item: u }: any) => (
                <Pressable
                  onPress={() => router.push(`/user/${u.id}`)}
                  style={[{ width: 160, backgroundColor: '#fff', borderRadius: R.lg, padding: 12, alignItems: 'center', gap: 6, borderWidth: 1, borderColor: C.line }, shadow]}
                >
                  <Avatar uri={u.photoUrl} name={u.name} size={48} cc={u.homeCountry} />
                  <T style={{ fontFamily: F.b, fontSize: 14, textAlign: 'center' }} numberOfLines={1}>{u.name}{u.age ? `, ${u.age}` : ''}</T>
                  {u.status ? (
                    <View style={{ backgroundColor: C.primarySoft, borderRadius: R.sm, paddingHorizontal: 6, paddingVertical: 2, maxWidth: 140 }}>
                      <T style={{ fontSize: 11, fontFamily: F.m, color: C.primaryDark }} numberOfLines={1}>{u.status}</T>
                    </View>
                  ) : (
                    <Muted style={{ fontSize: 11, textAlign: 'center' }}>In {city.city} now</Muted>
                  )}
                  <Button
                    title="Say Hi"
                    kind="ghost"
                    loading={openingId === u.id}
                    onPress={() => openDm(u.id)}
                    style={{ minHeight: 28, paddingVertical: 2, paddingHorizontal: 12, marginTop: 2 }}
                  />
                </Pressable>
              )}
            />
        ) : (
          <Muted style={{ paddingHorizontal: 20, fontSize: 13 }}>Nobody has chosen to be listed in {city.city} right now.</Muted>
        )}
        </View> : null}

        {/* Neighborhoods to Explore */}
        {city.areas?.length ? (
          <View style={{ paddingHorizontal: 20, gap: 12 }}>
            <H2>Top Neighborhoods & Hangouts</H2>
            <View style={{ gap: 10 }}>
              {city.areas.map(([name, desc]: [string, string], i: number) => (
                <View key={i} style={{ backgroundColor: '#fff', borderRadius: R.md, padding: 14, borderWidth: 1, borderColor: C.line, gap: 4 }}>
                  <T style={{ fontFamily: F.b, fontSize: 15, color: C.ink }}>📍 {name}</T>
                  <T style={{ fontSize: 13, color: C.ink2, lineHeight: 18 }}>{desc}</T>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* Community Local Tips & Hidden Gems */}
        {city.guide !== false ? <CityTipsSection slug={city.slug} cityName={city.city} /> : null}

        {/* Safety Tips */}
        {city.safety?.length ? (
          <View style={{ paddingHorizontal: 20, gap: 12 }}>
            <H2>Solo Traveler Safety</H2>
            <View style={{ backgroundColor: '#FEF3C7', borderRadius: R.lg, padding: 16, borderWidth: 1, borderColor: '#FDE68A', gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <T style={{ fontSize: 20 }}>🛡️</T>
                <T style={{ fontFamily: F.b, fontSize: 15, color: '#92400E' }}>Local Safety Advice</T>
              </View>
              {city.safety.map((tip: string, i: number) => (
                <T key={i} style={{ fontSize: 13, color: '#78350F', lineHeight: 18 }}>• {tip}</T>
              ))}
            </View>
          </View>
        ) : null}

        {/* Solo Female Traveler Safety */}
        {isWoman && city.womenSafety?.length ? (
          <View style={{ paddingHorizontal: 20, gap: 12 }}>
            <H2>Solo Female Travel Safety 🌸</H2>
            <View style={{ backgroundColor: '#FDF4FF', borderRadius: R.lg, padding: 16, borderWidth: 1, borderColor: '#F5D0FE', gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <T style={{ fontSize: 20 }}>🌸</T>
                <T style={{ fontFamily: F.b, fontSize: 15, color: '#86198F' }}>Women Nomads Safety ({city.city})</T>
              </View>
              {city.womenSafety.map((tip: string, i: number) => (
                <T key={i} style={{ fontSize: 13, color: '#701A75', lineHeight: 18 }}>• {tip}</T>
              ))}
            </View>
          </View>
        ) : null}

        {/* Best Season */}
        {city.bestSeason ? (
          <View style={{ paddingHorizontal: 20, gap: 8 }}>
            <H2>When to Visit</H2>
            <View style={{ backgroundColor: '#fff', borderRadius: R.md, padding: 14, borderWidth: 1, borderColor: C.line }}>
              <T style={{ fontSize: 14, color: C.ink2, lineHeight: 20 }}>☀️ {city.bestSeason}</T>
            </View>
          </View>
        ) : null}
      </ScrollView>
      {dmSheet}
    </SafeAreaView>
  );
}
