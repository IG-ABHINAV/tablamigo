import React, { useState } from 'react';
import { FlatList, Pressable, View, RefreshControl, ActivityIndicator, Alert } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, H1, Muted, Button, Avatar, Chip, Empty, PlusBadge, BackButton } from '../components/ui';
import { range } from '../components/format';
import { api, ApiError } from '../lib/api';
import { queryClient } from '../lib/query';
import { COUNTRIES } from '../lib/countries';
import { C, F, R, flag, travelStyleLabel, travelStyleEmoji } from '../lib/theme';

type Req = { id: string; userId: string; name: string; photoUrl?: string | null; homeCountry?: string | null; message?: string | null };
type BuddyReq = { id: string; senderId: string; senderName: string; senderPhotoUrl?: string | null; senderCountry?: string | null; introNote?: string | null; city?: string | null };
type Incoming = { kind: 'connect' | 'buddy'; id: string; userId: string; name: string; photoUrl?: string | null; homeCountry?: string | null; note?: string | null; context: string | null };

export default function Connections() {
  const [filter, setFilter] = useState<'all' | 'trips'>('all');
  const q = useQuery({ queryKey: ['connections'], queryFn: () => api('/connections') });
  // Connect requests (API migration 077) and trip buddy requests waiting for an answer, above the list.
  const reqs = useQuery({ queryKey: ['connection-requests'], queryFn: () => api<{ received: Req[]; sent: Req[] }>('/connections/requests') });
  const buddies = useQuery({ queryKey: ['buddy-requests'], queryFn: () => api<{ received: BuddyReq[] }>('/travel-buddies/requests') });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['connections'] });
    queryClient.invalidateQueries({ queryKey: ['connection-requests'] });
    queryClient.invalidateQueries({ queryKey: ['buddy-requests'] });
  };
  const answer = useMutation({
    mutationFn: ({ r, action }: { r: { id: string; kind: 'connect' | 'buddy' }; action: 'accept' | 'decline' }) =>
      api(r.kind === 'connect' ? `/connections/requests/${r.id}/respond` : `/travel-buddies/requests/${r.id}/respond`, { method: 'POST', body: { action } }),
    onSettled: refresh,
    onError: e => Alert.alert(e instanceof ApiError ? e.message : 'No connection. Try again.'),
  });
  const cancel = useMutation({
    mutationFn: (userId: string) => api(`/users/${userId}/connect`, { method: 'DELETE' }),
    onSettled: refresh,
    onError: e => Alert.alert(e instanceof ApiError ? e.message : 'No connection. Try again.'),
  });
  const incoming: Incoming[] = [
    ...(reqs.data?.received ?? []).map(r => ({ kind: 'connect' as const, id: r.id, userId: r.userId, name: r.name, photoUrl: r.photoUrl, homeCountry: r.homeCountry, note: r.message, context: null })),
    ...(buddies.data?.received ?? []).map(r => ({ kind: 'buddy' as const, id: r.id, userId: r.senderId, name: r.senderName, photoUrl: r.senderPhotoUrl, homeCountry: r.senderCountry, note: r.introNote, context: r.city ? `Travel buddy · ${r.city}` : 'Travel buddy' })),
  ];
  const sent = reqs.data?.sent ?? [];

  const dm = useMutation({
    mutationFn: (targetId: string) => api(`/dm/${targetId}`, { method: 'POST' }),
    onSuccess: r => router.push(`/chat/${r.chatId}`),
    onError: e => Alert.alert(e instanceof ApiError ? e.message : 'Could not start conversation.')
  });

  const list = q.data?.connections ?? [];
  const filtered = list.filter((c: any) => {
    if (filter === 'trips') return (c.upcomingTrips?.length ?? 0) > 0;
    return true;
  });

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top']}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 }}>
        <BackButton />
        <T style={{ fontFamily: F.b, fontSize: 17 }}>My Connections</T>
        <View style={{ width: 28 }} />
      </View>

      <View style={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: 12 }}>
        <H1>Travel Network 👥</H1>
        <Muted style={{ marginTop: 2 }}>Keep in touch with friends and track where they travel.</Muted>
      </View>

      {/* Wraps on narrow phones (iPhone SE, 320pt): the three chips are 338pt wide in one row. */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 20, paddingBottom: 12 }}>
        <Chip label={`All (${list.length})`} active={filter === 'all'} onPress={() => setFilter('all')} />
        <Chip label="Upcoming Trips ✈️" active={filter === 'trips'} onPress={() => setFilter('trips')} />
      </View>

      {q.isLoading ? (
        <ActivityIndicator color={C.primary} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item: any) => item.id}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 80, gap: 12 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={refresh} tintColor={C.primary} />}
          ListHeaderComponent={incoming.length || sent.length ? (
            <View style={{ gap: 10, marginBottom: 6 }}>
              {incoming.length ? <T style={{ fontFamily: F.b, fontSize: 15 }}>Requests · {incoming.length}</T> : null}
              {incoming.map(r => (
                <View key={`${r.kind}-${r.id}`} testID="incoming-request" style={{ backgroundColor: '#fff', borderRadius: R.lg, padding: 14, borderWidth: 1, borderColor: C.primarySoft, gap: 10 }}>
                  <Pressable onPress={() => router.push(`/user/${r.userId}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <Avatar uri={r.photoUrl} name={r.name} size={44} cc={r.homeCountry} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T numberOfLines={1} style={{ fontFamily: F.b, fontSize: 15 }}>{r.name}</T>
                      <Muted numberOfLines={1} style={{ fontSize: 12 }}>{r.context ?? 'Wants to connect'}</Muted>
                    </View>
                  </Pressable>
                  {r.note ? <T style={{ fontSize: 14, lineHeight: 20, color: C.ink2 }} numberOfLines={4}>“{r.note}”</T> : null}
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <Button title="Accept" kind="primary" style={{ flex: 1, height: 40 }} disabled={answer.isPending}
                      loading={answer.isPending && answer.variables?.r.id === r.id && answer.variables.action === 'accept'} onPress={() => answer.mutate({ r, action: 'accept' })} />
                    <Button title="Decline" kind="ghost" style={{ flex: 1, height: 40 }} disabled={answer.isPending}
                      loading={answer.isPending && answer.variables?.r.id === r.id && answer.variables.action === 'decline'} onPress={() => answer.mutate({ r, action: 'decline' })} />
                  </View>
                </View>
              ))}
              {sent.length ? <T style={{ fontFamily: F.b, fontSize: 15, marginTop: incoming.length ? 8 : 0 }}>Sent · {sent.length}</T> : null}
              {sent.map(r => (
                <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: R.lg, padding: 12, borderWidth: 1, borderColor: C.line }}>
                  <Pressable onPress={() => router.push(`/user/${r.userId}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                    <Avatar uri={r.photoUrl} name={r.name} size={36} cc={r.homeCountry} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T numberOfLines={1} style={{ fontFamily: F.sb, fontSize: 14 }}>{r.name}</T>
                      <Muted style={{ fontSize: 12 }}>Requested</Muted>
                    </View>
                  </Pressable>
                  <Button title="Cancel" kind="ghost" style={{ height: 36 }} loading={cancel.isPending && cancel.variables === r.userId} onPress={() => cancel.mutate(r.userId)} />
                </View>
              ))}
              <T style={{ fontFamily: F.b, fontSize: 15, marginTop: 8 }}>Connections</T>
            </View>
          ) : null}
          ListEmptyComponent={
            <Empty
              emoji="🤝"
              title={filter === 'all' ? "No connections yet" : "No matches"}
              body={filter === 'all'
                ? "Connect with travelers you meet on plans or see in trips to stay updated on where they travel."
                : "None of your connections match this filter."}
              action={filter === 'all' ? <Button title="Discover travelers" onPress={() => router.push('/travelers')} style={{ marginTop: 12, paddingHorizontal: 24 }} /> : undefined}
            />
          }
          renderItem={({ item: c }: { item: any }) => {
            const nextTrip = c.upcomingTrips?.[0];
            return (
              <Pressable
                onPress={() => router.push(`/user/${c.id}`)}
                style={{ backgroundColor: '#fff', borderRadius: R.lg, padding: 16, borderWidth: 1, borderColor: C.line, gap: 12 }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <Avatar uri={c.photoUrl} name={c.name} size={52} cc={c.homeCountry} />
                  <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <T numberOfLines={1} style={{ fontFamily: F.b, fontSize: 16, flexShrink: 1 }}>{c.name}{c.age ? `, ${c.age}` : ''}</T>
                      {c.verified ? <T style={{ fontSize: 14 }}>✅</T> : null}
                      {c.plus ? <PlusBadge /> : null}
                    </View>
                    <Muted style={{ fontSize: 12 }}>
                      {flag(c.homeCountry)} {COUNTRIES.find(x => x[0] === c.homeCountry)?.[1] ?? c.homeCountry}
                    </Muted>
                  </View>
                  <Button
                    title="Chat"
                    kind="ghost"
                    onPress={() => dm.mutate(c.id)}
                    loading={dm.isPending && dm.variables === c.id}
                    icon={<Ionicons name="chatbubble-outline" size={15} color={C.ink} />}
                    style={{ paddingHorizontal: 12, paddingVertical: 6, minHeight: 34 }}
                  />
                </View>

                {nextTrip ? (
                  <View style={{ backgroundColor: C.bgSoft, borderRadius: R.md, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <T style={{ fontSize: 18 }}>{flag(nextTrip.countryCode)}</T>
                    <View style={{ flex: 1 }}>
                      <T style={{ fontFamily: F.b, fontSize: 13 }}>Next trip: {nextTrip.city}</T>
                      <Muted style={{ fontSize: 11 }}>📅 {range(nextTrip.startDate, nextTrip.endDate)}</Muted>
                    </View>
                    {c.upcomingTrips.length > 1 ? (
                      <View style={{ backgroundColor: C.primarySoft, borderRadius: R.pill, paddingHorizontal: 8, paddingVertical: 3 }}>
                        <T style={{ fontFamily: F.b, fontSize: 11, color: C.primaryDark }}>+{c.upcomingTrips.length - 1} more</T>
                      </View>
                    ) : null}
                  </View>
                ) : null}

                {c.travelStyle?.length ? (
                  <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                    {c.travelStyle.slice(0, 3).map((s: string) => (
                      <View key={s} style={{ backgroundColor: '#F3F4F6', borderRadius: R.pill, paddingHorizontal: 8, paddingVertical: 3, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <T style={{ fontSize: 11 }}>{travelStyleEmoji(s)}</T>
                        <T style={{ fontSize: 11, fontFamily: F.m, color: C.ink2 }}>{travelStyleLabel(s)}</T>
                      </View>
                    ))}
                  </View>
                ) : null}
              </Pressable>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}
