import React, { useEffect } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, H1, Avatar, Empty, BackButton } from '../components/ui';
import { api } from '../lib/api';
import { queryClient } from '../lib/query';
import { C, F, R } from '../lib/theme';

type Notice = {
  id: string; kind: string; body: string; createdAt: string; readAt: string | null; locked: boolean;
  actorId: string | null; actorName: string | null; actorPhotoUrl: string | null; activityId: string | null; chatId: string | null;
};

const ICONS: Record<string, React.ComponentProps<typeof Ionicons>['name']> = {
  join: 'people', vouch: 'thumbs-up', profile_view: 'eye', verified: 'shield-checkmark', verify_rejected: 'shield-outline', cancelled: 'close-circle',
  connection_request: 'person-add', connection_accepted: 'people', buddy_request: 'person-add', buddy_accepted: 'people',
};

const ago = (iso: string) => {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? 'Just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : m < 2880 ? 'Yesterday' : `${Math.floor(m / 1440)} days ago`;
};

function open(n: Notice) {
  if (n.kind === 'profile_view') return router.push(n.locked ? '/paywall?reason=viewers' : '/viewers');
  if (n.kind === 'verified' || n.kind === 'verify_rejected') return router.push('/verify');
  // Requests are answered on the requests list; an accepted one opens the person.
  if (n.kind === 'connection_request' || n.kind === 'buddy_request') return router.push('/connections');
  if ((n.kind === 'connection_accepted' || n.kind === 'buddy_accepted' || n.kind === 'connection') && n.actorId) return router.push(`/user/${n.actorId}`);
  if (n.activityId) return router.push(`/activity/${n.activityId}`);
  if (n.chatId) router.push(`/chat/${n.chatId}`);
}

// Locked profile views come without a name or photo, so this is a placeholder, not a blurred real face.
function Face({ n }: { n: Notice }) {
  if (n.locked) return (
    <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: '#C0AEDE', alignItems: 'center', justifyContent: 'center', opacity: 0.8 }}>
      <Ionicons name="person" size={24} color="rgba(22,22,29,0.25)" />
      <View style={{ position: 'absolute', right: -2, bottom: -2, width: 20, height: 20, borderRadius: 10, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' }}>
        <Ionicons name="lock-closed" size={10} color="#fff" />
      </View>
    </View>
  );
  if (n.actorId) return <Avatar uri={n.actorPhotoUrl} name={n.actorName} size={48} />;
  return (
    <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: n.kind === 'verified' ? C.goSoft : C.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={ICONS[n.kind] ?? 'notifications'} size={22} color={n.kind === 'verified' ? C.go : C.primaryDark} />
    </View>
  );
}

export default function Inbox() {
  const q = useQuery({ queryKey: ['inbox', 'list'], queryFn: () => api<{ notifications: Notice[] }>('/inbox') });
  const list = q.data?.notifications ?? [];
  // Section headers ride along as rows so the FlatList stays flat.
  const section = (iso: string) => { const days = (new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000; return days < 1 ? 'Today' : days < 7 ? 'This week' : 'Earlier'; };
  const rows: (Notice | { header: string; id: string })[] = [];
  for (const n of list) { const h = section(n.createdAt); if (!rows.some(r => 'header' in r && r.header === h)) rows.push({ header: h, id: `h${h}` }); rows.push(n); }
  const hasUnread = list.some(n => !n.readAt);
  // Mark read once the list is on screen, so this visit still shows the dots; only the bell count refreshes.
  useEffect(() => {
    if (!hasUnread) return;
    api('/inbox/read', { body: {} }).then(() => queryClient.invalidateQueries({ queryKey: ['inbox', 'unread'] })).catch(() => {});
  }, [hasUnread, q.dataUpdatedAt]);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
        <BackButton />
      </View>
      <View style={{ paddingHorizontal: 20, paddingBottom: 10 }}><H1>Notifications</H1></View>
      <FlatList data={rows} keyExtractor={n => n.id} contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 60 }}
        refreshing={q.isRefetching} onRefresh={() => q.refetch()}
        ListEmptyComponent={q.isLoading ? null : <Empty emoji="🔔" title="All quiet" body="Nothing yet. Join a plan and things will start happening here." />}
        renderItem={({ item: n, index }) => 'header' in n ? <T style={{ fontFamily: F.b, fontSize: 13, letterSpacing: 0.6, color: C.ink2, textTransform: 'uppercase', marginTop: index ? 10 : 0 }}>{n.header}</T> : (
          <Pressable onPress={() => open(n)} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: R.lg, backgroundColor: n.readAt ? '#fff' : C.bgSoft, borderWidth: 1, borderColor: C.line }}>
            <Face n={n} />
            <View style={{ flex: 1, gap: 2 }}>
              <T style={{ fontFamily: n.readAt ? F.m : F.b, fontSize: 15, lineHeight: 20 }}>{n.body}</T>
              <T style={{ color: C.ink3, fontSize: 13 }}>{ago(n.createdAt)}</T>
            </View>
            {n.readAt ? <Ionicons name="chevron-forward" size={18} color={C.ink3} /> : <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: C.primary }} />}
          </Pressable>
        )} />
    </SafeAreaView>
  );
}
