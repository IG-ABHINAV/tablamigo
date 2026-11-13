import React, { useState } from 'react';
import { FlatList, Pressable, ScrollView, View, RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { T, H1, Muted, Avatar, Empty, Button, Chip } from '../../components/ui';
import { api } from '../../lib/api';
import { C, F, R } from '../../lib/theme';
import { chatPreview } from '../../lib/chat-preview';

const ago = (iso?: string) => {
  if (!iso) return ''; const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'now'; if (m < 60) return `${m}m`; if (m < 1440) return `${Math.round(m / 60)}h`; return `${Math.round(m / 1440)}d`;
};

export default function Chats() {
  const q = useQuery({ queryKey: ['chats'], queryFn: () => api('/chats') });
  const all = q.data?.chats ?? [];
  // Plan chats, DMs, city chats, trip group chats, and women-only safe spaces
  const [tab, setTab] = useState<'all' | 'activity' | 'dm' | 'city' | 'trip' | 'women' | 'requests'>('all');
  const requests = all.filter((c: any) => c.isRequest);
  const womenList = all.filter((c: any) => c.womenOnly);
  const baseTabs = [['all', 'All'], ['activity', 'Plans'], ['dm', 'Direct'], ['city', 'City'], ['trip', 'Trips']] as const;
  const tabs = [
    ...baseTabs.map(([id, label]) => {
      const list = id === 'all' ? all : all.filter((c: any) => c.kind === id);
      return { id: id as any, label, n: list.length, unread: list.reduce((a: number, c: any) => a + (c.unread ? 1 : 0), 0) };
    }).filter(t => t.id === 'all' || t.n > 0),
    ...(womenList.length > 0 ? [{ id: 'women' as const, label: '🌸 Women', n: womenList.length, unread: womenList.reduce((a: number, c: any) => a + (c.unread ? 1 : 0), 0) }] : []),
    ...(requests.length > 0 ? [{ id: 'requests' as const, label: 'Requests', n: requests.length, unread: requests.length }] : [])
  ];
  const chats = tab === 'all' ? all : tab === 'requests' ? requests : tab === 'women' ? womenList : all.filter((c: any) => c.kind === tab);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top']}>
      <H1 style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 }}>Chats</H1>
      {tabs.length > 2 ? <View><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 8, gap: 8 }}>
        {tabs.map(t => <Chip key={t.id} label={t.unread ? `${t.label} · ${t.unread}` : t.label} active={tab === t.id} onPress={() => setTab(t.id)} />)}
      </ScrollView></View> : null}
      <FlatList data={chats} keyExtractor={(c: any) => c.id} refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={C.primary} />}
        contentContainerStyle={{ paddingBottom: 40, flexGrow: 1 }}
        ListEmptyComponent={q.isLoading ? null : <Empty emoji="💬" title="No chats yet" body="Join a plan or trip circle and its group chat shows up here." action={<Button title="Find plans" onPress={() => router.push('/(tabs)')} style={{ marginTop: 12, paddingHorizontal: 28 }} />} />}
        renderItem={({ item: c }: any) => (
          <Pressable onPress={() => router.push(`/chat/${c.id}`)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 12, backgroundColor: pressed ? C.bgSoft : C.bg })}>
            {c.kind === 'dm' ? <Avatar uri={c.photoUrl} name={c.title} size={54} />
              : <View style={{ width: 54, height: 54, borderRadius: 18, backgroundColor: c.kind === 'city' ? C.womenSoft : c.kind === 'trip' ? '#E0F2FE' : C.primarySoft, alignItems: 'center', justifyContent: 'center' }}><T style={{ fontSize: 26 }}>{c.emoji ?? (c.kind === 'trip' ? '✈️' : '💬')}</T></View>}
            <View style={{ flex: 1, gap: 3 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                  <T numberOfLines={1} style={{ fontFamily: F.b, fontSize: 16, flexShrink: 1 }}>{c.title}</T>
                  {c.womenOnly ? (
                    <View style={{ backgroundColor: '#FDF2F8', borderWidth: 1, borderColor: '#FBCFE8', borderRadius: R.pill, paddingHorizontal: 6, paddingVertical: 1 }}>
                      <T style={{ fontSize: 10, fontFamily: F.b, color: '#DB2777' }}>🌸 WOMEN</T>
                    </View>
                  ) : null}
                  {c.isRequest ? (
                    <View style={{ backgroundColor: C.primarySoft, borderRadius: R.pill, paddingHorizontal: 6, paddingVertical: 1 }}>
                      <T style={{ fontSize: 10, fontFamily: F.b, color: C.primaryDark }}>REQUEST</T>
                    </View>
                  ) : null}
                </View>
                <Muted style={{ fontSize: 12 }}>{ago(c.lastMessage?.createdAt ?? c.lastMessageAt)}</Muted>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <T numberOfLines={1} style={{ flex: 1, color: c.unread ? C.ink : C.ink2, fontFamily: c.unread ? F.sb : F.r, fontSize: 14 }}>
                  {chatPreview(c)}
                </T>
                {c.unread ? <View style={{ minWidth: 22, height: 22, borderRadius: 11, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 }}><T style={{ color: '#fff', fontFamily: F.b, fontSize: 12 }}>{c.unread}</T></View> : null}
              </View>
            </View>
          </Pressable>
        )} />
    </SafeAreaView>
  );
}
