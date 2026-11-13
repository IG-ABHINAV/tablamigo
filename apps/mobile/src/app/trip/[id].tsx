import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View, ActivityIndicator, Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, Muted, Avatar, Empty, Button, PlusBadge, AvatarStack, BackButton, IconButton } from '../../components/ui';
import { PaywallSheet } from '../../components/PaywallSheet';
import { tripMoment, type Moment } from '../../lib/paywall-copy';
import { TripHero } from '../../components/TripHero';
import { TripTimeline } from '../../components/TripTimeline';
import { TripSuggestedCompanions } from '../../components/TripSuggestedCompanions';
import { TripCircleDirectoryModal } from '../../components/TripCircleDirectoryModal';
import { TripCircleProposalsModal } from '../../components/TripCircleProposalsModal';
import { range } from '../../components/format';
import { api, ApiError } from '../../lib/api';
import { queryClient } from '../../lib/query';
import { C, F, R, shadow } from '../../lib/theme';
import { showTripCircle, EMPTY_CIRCLE_NOTE } from '../../lib/trip-circle';

export default function TripDetail() {
  const { id, hidden, total } = useLocalSearchParams<{ id: string; hidden?: string; total?: string }>();
  const trips = useQuery({ queryKey: ['trips'], queryFn: () => api('/trips') });
  const t = trips.data?.trips?.find((x: any) => x.id === id);
  const ov = useQuery({ queryKey: ['overlaps', id], queryFn: () => api(`/trips/${id}/overlaps`) });
  const groupChat = useQuery({
    queryKey: ['tripGroupChat', id],
    queryFn: () => api(`/trips/${id}/group-chat`),
    enabled: !!id,
  });
  const joinGroupChat = useMutation({
    mutationFn: () => api(`/trips/${id}/group-chat`, { method: 'POST' }),
    onSuccess: r => {
      queryClient.invalidateQueries({ queryKey: ['tripGroupChat', id] });
      queryClient.invalidateQueries({ queryKey: ['chats'] });
      router.push(`/chat/${r.chatId}`);
    },
    onError: e => {
      Alert.alert(e instanceof ApiError ? e.message : 'No connection.');
    },
  });
  const leaveGroupChat = useMutation({
    mutationFn: () => api(`/trips/${id}/group-chat`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tripGroupChat', id] });
      queryClient.invalidateQueries({ queryKey: ['chats'] });
    },
    onError: e => {
      Alert.alert(e instanceof ApiError ? e.message : 'No connection.');
    },
  });
  const chat = useMutation({
    mutationFn: () => api(`/trips/${id}/city-chat`, { method: 'POST' }),
    onSuccess: r => router.push(`/chat/${r.chatId}`),
    onError: e => {
      if (e instanceof ApiError && e.code === 'plus_required') router.push('/paywall?reason=city_chat');
      else Alert.alert(e instanceof ApiError ? e.message : 'No connection.');
    },
  });
  const scroll = useRef<ScrollView>(null); const listY = useRef(0);
  // Straight after adding a trip with more travelers than the free preview: say how many, once.
  const [moment, setMoment] = useState<Moment | null>(null); const shown = useRef(false);
  const [directoryVisible, setDirectoryVisible] = useState(false);
  const [proposalsVisible, setProposalsVisible] = useState(false);
  useEffect(() => {
    if (shown.current || !t || !Number(hidden)) return;
    shown.current = true; setMoment(tripMoment(Number(hidden), Number(total), t.city));
  }, [t, hidden, total]);
  if (!t) return <SafeAreaView style={{ flex: 1, justifyContent: 'center', backgroundColor: C.bg }}>
    {trips.isLoading ? <ActivityIndicator color={C.primary} /> : <Empty emoji="🧳" title="Trip not found" body="It may have ended or been removed." action={<Button title="Back to trips" onPress={() => router.back()} style={{ marginTop: 12, paddingHorizontal: 28 }} />} />}
  </SafeAreaView>;
  const faces = (ov.data?.travelers ?? []).map((u: any) => ({ id: u.id, name: u.name, photoUrl: u.photoUrl }));
  const seeAll = () => ov.data?.locked ? router.push('/paywall?reason=trip_pass&plan=pass') : scroll.current?.scrollTo({ y: listY.current, animated: true });
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 8 }}>
        <BackButton />
        <IconButton name="trash-outline" label="Delete" size={22} color={C.ink2} edge="right" onPress={() => Alert.alert('Remove this trip?', undefined, [{ text: 'Keep' }, { text: 'Remove', style: 'destructive', onPress: async () => { await api(`/trips/${id}`, { method: 'DELETE' }); queryClient.invalidateQueries({ queryKey: ['trips'] }); router.back(); } }])} />
      </View>
      <ScrollView ref={scroll} contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: 60 }}>
        <TripHero trip={t} faces={faces} total={ov.data?.total ?? 0} onSeeAll={seeAll} onChat={() => t.cityChatOpensOn ? router.push('/paywall?reason=city_chat') : chat.mutate()} chatLoading={chat.isPending} chatOpensOn={t.cityChatOpensOn ?? null} />
        {groupChat.data && !showTripCircle(groupChat.data) ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4 }}>
            <T style={{ fontSize: 18 }}>✈️</T><Muted style={{ flex: 1, fontSize: 13 }}>{EMPTY_CIRCLE_NOTE}</Muted>
          </View>
        ) : null}
        {groupChat.data && showTripCircle(groupChat.data) ? (
          <View style={[{ backgroundColor: '#fff', borderRadius: R.lg, padding: 16, gap: 12, borderWidth: 1, borderColor: C.line }, shadow]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
                <T style={{ fontSize: 22 }}>✈️</T>
              </View>
              <View style={{ flex: 1 }}>
                <T style={{ fontFamily: F.b, fontSize: 16 }}>{groupChat.data.title}</T>
                <Muted style={{ fontSize: 13 }}>
                  {groupChat.data.memberCount === 1 ? '1 traveler in this circle' : `${groupChat.data.memberCount} travelers in this circle`}
                </Muted>
              </View>
              {groupChat.data.members?.length ? (
                <AvatarStack
                  people={groupChat.data.members}
                  size={32}
                  max={4}
                  extra={Math.max(0, groupChat.data.memberCount - Math.min(4, groupChat.data.members.length))}
                />
              ) : null}
            </View>

            {groupChat.data.topic ? (
              <View style={{ backgroundColor: '#F0F9FF', borderRadius: R.md, padding: 10, borderWidth: 1, borderColor: '#BAE6FD', gap: 4 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <T style={{ fontSize: 12, fontFamily: F.b, color: '#0369A1' }}>🎯 Circle Topic</T>
                  {groupChat.data.topicAuthor ? <Muted style={{ fontSize: 11 }}>by {groupChat.data.topicAuthor}</Muted> : null}
                </View>
                <T style={{ fontSize: 13, color: '#0C4A6E' }}>{groupChat.data.topic}</T>
              </View>
            ) : null}

            {groupChat.data.isMember ? (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Pressable
                  onPress={() => setDirectoryVisible(true)}
                  style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: R.md, backgroundColor: C.bgSoft, borderWidth: 1, borderColor: C.line }}
                >
                  <Ionicons name="people-outline" size={16} color={C.ink2} />
                  <T style={{ fontSize: 12, fontFamily: F.sb, color: C.ink }}>Directory ({groupChat.data.memberCount})</T>
                </Pressable>
                <Pressable
                  onPress={() => setProposalsVisible(true)}
                  style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: R.md, backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#FDE68A' }}
                >
                  <T style={{ fontSize: 13 }}>💡</T>
                  <T style={{ fontSize: 12, fontFamily: F.sb, color: '#B45309' }}>Ideas ({groupChat.data.proposalsCount ?? 0})</T>
                </Pressable>
              </View>
            ) : null}

            <View style={{ gap: 8 }}>
              <Button
                title={groupChat.data.isMember ? 'Open Trip Circle Chat' : 'Join Trip Circle Chat'}
                loading={joinGroupChat.isPending}
                onPress={() => joinGroupChat.mutate()}
              />
              {groupChat.data.isMember ? (
                <Button
                  title="Leave Circle"
                  kind="ghost"
                  loading={leaveGroupChat.isPending}
                  onPress={() => {
                    Alert.alert(
                      'Leave Trip Circle?',
                      'You can always rejoin while your trip is active.',
                      [
                        { text: 'Stay', style: 'cancel' },
                        { text: 'Leave Circle', style: 'destructive', onPress: () => leaveGroupChat.mutate() },
                      ]
                    );
                  }}
                  style={{ height: 44 }}
                />
              ) : null}
            </View>
          </View>
        ) : null}
        {ov.data?.travelers?.length ? <TripTimeline trip={t} travelers={ov.data.travelers} /> : null}
        <TripSuggestedCompanions tripId={id} city={t.city} />
        <View style={{ gap: 12 }} onLayout={e => { listY.current = e.nativeEvent.layout.y; }}>
          {(ov.data?.travelers ?? []).map((u: any) => (
            <Pressable key={u.id} onPress={() => router.push(`/user/${u.id}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: R.md, backgroundColor: '#fff', borderWidth: 1, borderColor: C.line }}>
              <Avatar uri={u.photoUrl} name={u.name} size={46} cc={u.homeCountry} />
              <View style={{ flex: 1 }}><T style={{ fontFamily: F.b }}>{u.name}{u.age ? `, ${u.age}` : ''}{u.plus ? ' ' : ''}{u.plus ? <PlusBadge /> : null}</T><Muted style={{ fontSize: 13 }}>{range(u.startDate, u.endDate)}</Muted></View>
              <Ionicons name="chevron-forward" size={18} color={C.ink3} />
            </Pressable>
          ))}
          {ov.data?.locked ? <Pressable onPress={() => router.push('/paywall?reason=trip_pass&plan=pass')} style={{ padding: 16, borderRadius: R.md, backgroundColor: C.ink, alignItems: 'center', gap: 4 }}>
            <T style={{ color: '#fff', fontFamily: F.b }}>See all {ov.data.total} travelers</T><T style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>{ov.data.hiddenCount} more with a Trip Pass or Plus</T></Pressable> : null}
        </View>
      </ScrollView>
      <PaywallSheet moment={moment} onClose={() => setMoment(null)} />
      <TripCircleDirectoryModal tripId={id} visible={directoryVisible} onClose={() => setDirectoryVisible(false)} />
      <TripCircleProposalsModal tripId={id} visible={proposalsVisible} onClose={() => setProposalsVisible(false)} />
    </SafeAreaView>
  );
}
