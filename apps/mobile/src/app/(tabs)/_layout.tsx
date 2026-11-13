import React, { useEffect, useRef, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { AppState, Platform, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Empty, Button } from '../../components/ui';
import { getSocket } from '../../lib/socket';
import { queryClient } from '../../lib/query';
import { registerPush } from '../../lib/push';
import { startPlayPurchases } from '../../lib/play-billing';
import { useSession } from '../../lib/session';
import { useAllFree } from '../../lib/useAllFree';
import { ADS, startAds } from '../../lib/ads';
import { needsAdsNotice, markAdsNoticeSeen, type NoticeStore } from '../../lib/ads-notice';
import { AdsNotice } from '../../components/AdsNotice';
import { showsAds } from '../../lib/ads-config';
import { C, F, tabBarHeight } from '../../lib/theme';
import { columnStyle } from '../../lib/wide';

// The tab bar calls this as a render function with { focused, color }; named so it has a display name.
const tabIcon = (name: any, focusedName: any) => function TabIcon({ focused, color }: any) {
  return <Ionicons name={focused ? focusedName : name} size={24} color={color} />;
};

export default function TabsLayout() {
  // The tabs mount for a moment before the root Gate redirects a signed-out user.
  // Don't let that moment fire permission prompts or API calls.
  const tokens = useSession(s => s.tokens);
  // Android draws edge to edge (SDK 57), so the system navigation bar (3-button or gesture handle) sits over the bottom of the
  // window: the tab bar grows by that inset and keeps its own 72 px above it. iPhone home indicator and the web's
  // env(safe-area-inset-bottom) come through the same inset.
  const insets = useSafeAreaInsets();
  // Wide web windows: list tabs are a centred column (lib/wide.ts); Explore keeps the map full width.
  const column = columnStyle(Platform.OS, useWindowDimensions().width, C.line);
  const scene = column ? { sceneStyle: { backgroundColor: C.bg, ...column } } : {};
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me'), enabled: !!tokens });
  const ready = !!tokens && !!me.data?.onboarded;
  const chats = useQuery({ queryKey: ['chats'], queryFn: () => api('/chats'), refetchInterval: 60_000, enabled: ready });
  const unread = (chats.data?.chats ?? []).reduce((a: number, c: any) => a + (c.unread || 0), 0);
  useEffect(() => {
    if (!ready) return;
    const s = getSocket(); if (!s) return;
    const bump = () => queryClient.invalidateQueries({ queryKey: ['chats'] });
    s.on('message:new', bump); s.on('chat:new', bump); s.on('activity:joined', bump);
    return () => { s.off('message:new', bump); s.off('chat:new', bump); s.off('activity:joined', bump); };
  }, [ready]);
  // Settles once push is set up (registerPush never asks since 1 Nov 2026 and catches its own errors); the ads notice and
  // consent form below still wait for it.
  const pushAsked = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!ready) return;
    // A sign-out before registerPush resolves runs the cleanup first: remove its listeners when it does (they leaked before).
    let sub: { remove(): void } | undefined;
    let gone = false;
    pushAsked.current = registerPush().then(s => { if (gone) s.remove(); else sub = s; });
    return () => { gone = true; sub?.remove(); };
  }, [ready]);
  // Google Play purchases are verified from here until sign-out, not only while the paywall is open: a UPI payment can settle
  // after the paywall closed, and Play refunds a purchase nobody acknowledges within 3 days (lib/play-billing.ts). Android only.
  // While everything is free nothing can be bought, so Play Billing stays unconnected, as on the paywall.
  const free = useAllFree();
  const selling = ready && free.ready && !free.allFree;
  useEffect(() => (selling ? startPlayPurchases() : undefined), [selling]);
  // Ads (ADS_ENABLED builds only): Google's consent step, then the SDK, only for a free account, so the consent form never shows
  // during sign-in or onboarding, or to Plus members. Retried on return to the foreground until it works. No-op without ads.
  const adsWanted = ready && showsAds(me.data);
  // The first time, a one-time notice comes first (lib/ads-notice.ts): the policy promises to say so in the app before ads start.
  const [notice, setNotice] = useState<'checking' | 'show' | 'done'>('checking');
  useEffect(() => {
    if (!adsWanted || notice !== 'checking') return;
    let live = true;
    pushAsked.current.then(() => needsAdsNotice(noticeStore, ADS.enabled, true)).then(n => { if (live) setNotice(n ? 'show' : 'done'); });
    return () => { live = false; };
  }, [adsWanted, notice]);
  useEffect(() => {
    if (!adsWanted || notice !== 'done') return;
    startAds();
    const sub = AppState.addEventListener('change', st => { if (st === 'active') startAds(); });
    return () => sub.remove();
  }, [adsWanted, notice]);
  // Signed in but /me failed (offline, API down): a way to retry instead of an empty page. Auth errors are the Gate's.
  if (!ready && tokens && me.isError && !(me.error instanceof ApiError && [401, 403].includes(me.error.status))) return (
    <View style={{ flex: 1, justifyContent: 'center', backgroundColor: C.bg }}>
      <Empty emoji="📡" title="Can't reach Tablamigo" body={me.error instanceof ApiError && me.error.code !== 'no_connection' ? me.error.message : 'Check your connection and try again.'}
        action={<Button title="Try again" loading={me.isFetching} onPress={() => me.refetch()} style={{ marginTop: 12, paddingHorizontal: 28 }} />} />
    </View>
  );
  if (!ready) return null;
  return (
    <>
    <AdsNotice visible={adsWanted && notice === 'show'} createdAt={me.data?.createdAt} onDone={() => { markAdsNoticeSeen(noticeStore); setNotice('done'); }} />
    <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: C.primary, tabBarInactiveTintColor: C.ink3,
      tabBarStyle: { height: tabBarHeight(insets.bottom), paddingTop: 8, paddingBottom: 12 + insets.bottom, borderTopColor: C.line, backgroundColor: '#fff' },
      tabBarLabelStyle: { fontFamily: F.sb, fontSize: 11 }, sceneStyle: { backgroundColor: column ? C.bgSoft : C.bg } }}>
      <Tabs.Screen name="index" options={{ title: 'Explore', tabBarIcon: tabIcon('compass-outline', 'compass') }} />
      <Tabs.Screen name="feed" options={{ ...scene, title: 'Feed', tabBarIcon: tabIcon('sparkles-outline', 'sparkles') }} />
      <Tabs.Screen name="trips" options={{ ...scene, title: 'Trips', tabBarIcon: tabIcon('airplane-outline', 'airplane') }} />
      <Tabs.Screen name="chats" options={{ ...scene, title: 'Chats', tabBarIcon: tabIcon('chatbubbles-outline', 'chatbubbles'), tabBarBadge: unread ? (unread > 99 ? '99+' : unread) : undefined, tabBarBadgeStyle: { backgroundColor: C.primary, fontFamily: F.b, fontSize: 10 } }} />
      <Tabs.Screen name="profile" options={{ ...scene, title: 'Profile', tabBarIcon: tabIcon('person-circle-outline', 'person-circle') }} />
    </Tabs>
    </>
  );
}

const noticeStore: NoticeStore = { get: k => SecureStore.getItemAsync(k), set: k => SecureStore.setItemAsync(k, 'seen') };
