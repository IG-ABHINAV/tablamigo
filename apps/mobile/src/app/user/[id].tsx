import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, View, ActivityIndicator, Linking } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, H1, Muted, Button, Avatar, Chip, Empty, BackButton, IconButton } from '../../components/ui';
import { PhotoGallery } from '../../components/PhotoGallery';
import { ProfilePromptsView } from '../../components/ProfilePrompts';
import { UserTimeline } from '../../components/UserTimeline';
import { api, ApiError } from '../../lib/api';
import { queryClient } from '../../lib/query';
import { momentFor, type Moment } from '../../lib/paywall-copy';
import { PaywallSheet } from '../../components/PaywallSheet';
import { ConnectSheet } from '../../components/ConnectSheet';
import { connectStatus, connectButton } from '../../lib/connect';
import { reportSheet } from '../../lib/safety';
import { COUNTRIES } from '../../lib/countries';
import { CountriesVisited } from '../../components/CountriesVisited';
import { C, F, R, flag, interestLabel, interestEmoji, travelStyleLabel, travelStyleEmoji } from '../../lib/theme';

export default function UserProfile() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useQuery({ queryKey: ['user', id], queryFn: () => api(`/users/${id}`) });
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me') });
  const [moment, setMoment] = useState<Moment | null>(null);
  const dm = useMutation({
    mutationFn: () => api(`/dm/${id}`, { method: 'POST' }), onSuccess: r => router.push(`/chat/${r.chatId}`),
    onError: e => { const m = e instanceof ApiError ? momentFor(e.code, e.message, e.data) : null; if (m) setMoment(m); else Alert.alert(e instanceof ApiError ? e.message : 'No connection.'); },
  });
  // Connect is a request the other person accepts (API migration 077): none -> requested (cancel) -> connected, or incoming
  // (accept / decline). The sheet takes an optional note.
  const [connectOpen, setConnectOpen] = useState(false);
  const refreshConnection = () => {
    queryClient.invalidateQueries({ queryKey: ['user', id] });
    queryClient.invalidateQueries({ queryKey: ['connections'] });
    queryClient.invalidateQueries({ queryKey: ['connection-requests'] });
  };
  const sendConnect = useMutation({
    mutationFn: (message: string) => api(`/users/${id}/connect`, { method: 'POST', body: message ? { message } : {} }),
    onSuccess: () => { setConnectOpen(false); refreshConnection(); },
  });
  const removeConnect = useMutation({
    mutationFn: () => api(`/users/${id}/connect`, { method: 'DELETE' }),
    onSuccess: refreshConnection,
    onError: e => Alert.alert(e instanceof ApiError ? e.message : 'No connection. Try again.'),
  });
  const respond = useMutation({
    mutationFn: (action: 'accept' | 'decline') => api(`/connections/requests/${u?.incomingRequestId}/respond`, { method: 'POST', body: { action } }),
    onSuccess: refreshConnection,
    onError: e => { refreshConnection(); Alert.alert(e instanceof ApiError ? e.message : 'No connection. Try again.'); },
  });
  const u = q.data;
  // A deleted, banned or blocked account is a 404: say so instead of spinning forever.
  if (!u) return <SafeAreaView style={{ flex: 1, justifyContent: 'center', backgroundColor: C.bg }}>
    {q.isError ? <Empty emoji="🧭" title="This profile isn't available" body={q.error instanceof ApiError && q.error.status === 404 ? 'The account may have been deleted.' : 'Check your connection and try again.'}
      action={<Button title="Go back" onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)')} style={{ marginTop: 12, paddingHorizontal: 28 }} />} />
      : <ActivityIndicator color={C.primary} />}
  </SafeAreaView>;
  const self = me.data?.id === u.id;
  const status = connectStatus(u);
  const btn = status === 'incoming' ? null : connectButton(status);
  const memberSinceText = u.memberSince ? new Date(u.memberSince).toLocaleDateString([], { month: 'short', year: 'numeric' }) : null;

  return (
    // The bottom bar pads itself for the system navigation bar (Android draws edge to edge), so only the top edge here.
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top']}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 8 }}>
        <BackButton />
        {!self ? <IconButton name="ellipsis-horizontal" label="More options" size={24} edge="right" onPress={() => reportSheet({ type: 'user', id: u.id, userId: u.id, userName: u.name })} /> : null}
      </View>
      <ScrollView contentContainerStyle={{ padding: 24, alignItems: 'center', gap: 14, paddingBottom: 140 + insets.bottom }}>
        <PhotoGallery photos={u.photos} fallbackPhotoUrl={u.photoUrl} name={u.name} size={128} />
        <H1 style={{ textAlign: 'center' }}>{u.name}{u.age ? `, ${u.age}` : ''} {u.idVerified ? '🛡️' : u.verified ? '✅' : ''}</H1>
        <Muted>{flag(u.homeCountry)} From {COUNTRIES.find(c => c[0] === u.homeCountry)?.[1] ?? u.homeCountry}{u.city ? ` · now in ${u.city}` : ''}</Muted>

        {/* Member Badges: Member since, Response rate, Verified */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
          {u.isBoosted ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#FEF3C7', paddingHorizontal: 10, paddingVertical: 4, borderRadius: R.pill }}>
              <T style={{ fontSize: 12 }}>⚡</T>
              <T style={{ fontSize: 12, fontFamily: F.b, color: '#D97706' }}>Spotlight Boosted</T>
            </View>
          ) : null}
          {u.idVerified ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#F59E0B', paddingHorizontal: 10, paddingVertical: 4, borderRadius: R.pill }}>
              <T style={{ fontSize: 12 }}>🛡️</T>
              <T style={{ fontSize: 12, fontFamily: F.b, color: '#B45309' }}>ID Verified</T>
            </View>
          ) : u.verified ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#ECFDF5', paddingHorizontal: 10, paddingVertical: 4, borderRadius: R.pill }}>
              <Ionicons name="shield-checkmark" size={14} color="#059669" />
              <T style={{ fontSize: 12, fontFamily: F.b, color: '#059669' }}>Selfie Verified</T>
            </View>
          ) : null}
          {memberSinceText ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: C.bgSoft, paddingHorizontal: 10, paddingVertical: 4, borderRadius: R.pill }}>
              <Ionicons name="calendar-outline" size={13} color={C.ink2} />
              <Muted style={{ fontSize: 12 }}>Member since {memberSinceText}</Muted>
            </View>
          ) : null}
          {u.responseRate != null ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: C.primarySoft, paddingHorizontal: 10, paddingVertical: 4, borderRadius: R.pill }}>
              <T style={{ fontSize: 12 }}>⚡</T>
              <T style={{ fontSize: 12, fontFamily: F.b, color: C.primaryDark }}>{u.responseRate}% reply rate</T>
            </View>
          ) : null}
        </View>

        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          {[
            [u.activitiesJoined, u.activitiesJoined === 1 ? 'plan joined' : 'plans joined'],
            [u.vouches, u.vouches === 1 ? 'thumbs-up' : 'thumbs-ups'],
            [u.connectionsCount, u.connectionsCount === 1 ? 'connection' : 'connections'],
          ].map(([n, l]) => (
            <View key={l} style={{ minWidth: 95, paddingHorizontal: 12, paddingVertical: 10, borderRadius: R.md, backgroundColor: C.bgSoft, alignItems: 'center' }}><T style={{ fontFamily: F.xb, fontSize: 18 }}>{n ?? 0}</T><Muted style={{ fontSize: 11 }}>{l}</Muted></View>
          ))}
        </View>

        {/* Social Links (Instagram handle or lock prompt) */}
        {u.instagram ? (
          <Pressable
            onPress={() => Linking.openURL(`https://instagram.com/${u.instagram}`)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8, borderRadius: R.pill, backgroundColor: '#FDF2F8', borderWidth: 1, borderColor: '#FBCFE8' }}
          >
            <Ionicons name="logo-instagram" size={18} color="#DB2777" />
            <T style={{ fontFamily: F.b, fontSize: 13, color: '#DB2777' }}>@{u.instagram}</T>
          </Pressable>
        ) : u.instagramLocked ? (
          <Pressable
            onPress={() => setMoment({ emoji: '🤝', title: 'Connect on Instagram', body: 'Instagram handles and contact details are available to Plus members or travelers who have met through a plan.', reason: 'contacts' })}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: R.pill, backgroundColor: C.bgSoft }}
          >
            <Ionicons name="lock-closed" size={13} color={C.ink2} />
            <Muted style={{ fontSize: 12 }}>Instagram: unlocked with Plus or plan meetup</Muted>
          </Pressable>
        ) : null}

        {u.sharedTravelStyle?.length ? (
          <View style={{ backgroundColor: C.primarySoft, paddingHorizontal: 14, paddingVertical: 6, borderRadius: R.pill, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <T style={{ fontSize: 13 }}>✨</T>
            <T style={{ fontSize: 13, fontFamily: F.b, color: C.primaryDark }}>
              You both travel: {u.sharedTravelStyle.map((s: string) => travelStyleLabel(s)).join(', ')}
            </T>
          </View>
        ) : null}

        {u.bio ? <T style={{ textAlign: 'center', fontSize: 16, lineHeight: 24 }}>{u.bio}</T> : null}

        <ProfilePromptsView prompts={u.prompts} />

        {u.travelStyle?.length ? (
          <View style={{ width: '100%', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <Muted style={{ fontSize: 12, fontFamily: F.b, textTransform: 'uppercase' }}>Travel Style</Muted>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
              {u.travelStyle.map((s: string) => <Chip key={s} label={travelStyleLabel(s)} emoji={travelStyleEmoji(s)} />)}
            </View>
          </View>
        ) : null}

        {u.languages?.length ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
          <Ionicons name="chatbubbles-outline" size={16} color={C.ink2} /><T style={{ fontFamily: F.sb, color: C.ink2 }}>Speaks {u.languages.join(', ')}</T>
        </View> : null}
        {u.interests?.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>{u.interests.map((i: string) => <Chip key={i} label={interestLabel(i)} emoji={interestEmoji(i)} />)}</View> : null}
        <CountriesVisited codes={u.countriesVisited ?? []} center />

        {/* Travel & Meetup Timeline */}
        <View style={{ width: '100%', marginTop: 12, gap: 10 }}>
          <T style={{ fontFamily: F.b, fontSize: 17, textAlign: 'center' }}>🗺️ Travel & Meetup Journey</T>
          <UserTimeline userId={u.id} isSelf={self} />
        </View>
      </ScrollView>
      {!self ? (
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 + insets.bottom, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: C.line, flexDirection: 'row', gap: 10 }}>
          {status === 'incoming' ? (
            <>
              <Button title="Accept" kind="primary" loading={respond.isPending && respond.variables === 'accept'} disabled={respond.isPending}
                onPress={() => respond.mutate('accept')} icon={<Ionicons name="checkmark" size={18} color="#fff" />} style={{ flex: 1 }} />
              <Button title="Decline" kind="ghost" loading={respond.isPending && respond.variables === 'decline'} disabled={respond.isPending}
                onPress={() => respond.mutate('decline')} style={{ flex: 1 }} />
            </>
          ) : (
            <Button
              title={btn!.title}
              kind={btn!.primary ? 'primary' : 'ghost'}
              loading={removeConnect.isPending}
              onPress={() => status === 'none' ? setConnectOpen(true)
                : Alert.alert(status === 'requested' ? 'Cancel your request?' : `Remove ${u.name} from your connections?`, undefined, [
                    { text: 'Keep', style: 'cancel' },
                    { text: status === 'requested' ? 'Cancel request' : 'Remove', style: 'destructive', onPress: () => removeConnect.mutate() },
                  ])}
              icon={<Ionicons name={btn!.icon} size={18} color={btn!.primary ? '#fff' : C.ink} />}
              style={{ flex: 1 }}
            />
          )}
          <Button
            title="Message"
            kind="dark"
            loading={dm.isPending}
            onPress={() => dm.mutate()}
            icon={<Ionicons name="chatbubble" size={18} color="#fff" />}
            style={{ flex: status === 'incoming' ? 0.9 : 1 }}
          />
        </View>
      ) : null}
      <ConnectSheet person={connectOpen ? u : null} onClose={() => { setConnectOpen(false); sendConnect.reset(); }}
        sending={sendConnect.isPending} onSend={note => sendConnect.mutate(note)}
        error={sendConnect.error ? (sendConnect.error instanceof ApiError ? sendConnect.error.message : 'No connection. Try again.') : null} />
      <PaywallSheet moment={moment} onClose={() => setMoment(null)} />
    </SafeAreaView>
  );
}
