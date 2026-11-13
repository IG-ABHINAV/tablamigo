import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { T, Muted, Avatar } from './ui';
import { ModalSheet } from './ModalSheet';
import { api, ApiError } from '../lib/api';
import { queryClient } from '../lib/query';
import { C, F, R } from '../lib/theme';

export type VouchMember = { id: string; name?: string | null; photoUrl?: string | null; homeCountry?: string | null };

/** Thumbs-up for the people you met on a plan. Only works once the plan has started (the API checks). */
export function VouchSheet({ activityId, members, visible, onClose }: { activityId: string; members: VouchMember[]; visible: boolean; onClose: () => void }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me') });
  const given = useQuery({ queryKey: ['vouches', activityId], queryFn: () => api<{ given: string[] }>(`/vouches/${activityId}`), enabled: visible });
  const [busy, setBusy] = useState<string | null>(null); const [err, setErr] = useState('');
  const others = members.filter(m => m.id !== me.data?.id);
  const vouch = async (m: VouchMember) => {
    setBusy(m.id); setErr('');
    try {
      await api('/vouches', { body: { activityId, userId: m.id } });
      queryClient.setQueryData(['vouches', activityId], (d: any) => ({ given: [...(d?.given ?? []), m.id] }));
      queryClient.invalidateQueries({ queryKey: ['user', m.id] });
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'No connection.'); } finally { setBusy(null); }
  };
  return (
    <ModalSheet visible={visible} onClose={onClose}>
      <T style={{ fontFamily: F.xb, fontSize: 20 }}>How was the meetup?</T>
      <Muted style={{ marginBottom: 8 }}>Give a thumbs-up to people you'd happily meet again. It shows on their profile.</Muted>
      {err ? <T style={{ color: C.danger, marginBottom: 6 }}>{err}</T> : null}
      <ScrollView contentContainerStyle={{ gap: 4 }}>
        {others.length ? others.map(m => {
          const done = given.data?.given.includes(m.id);
          return (
            <View key={m.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 }}>
              <Avatar uri={m.photoUrl} name={m.name} size={44} cc={m.homeCountry} />
              <T style={{ flex: 1, fontFamily: F.sb, fontSize: 16 }}>{m.name}</T>
              <Pressable onPress={() => vouch(m)} disabled={done || !!busy || given.isLoading}
                style={{ height: 40, minWidth: 92, paddingHorizontal: 14, borderRadius: R.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: done ? C.goSoft : C.primarySoft }}>
                {busy === m.id ? <ActivityIndicator color={C.primary} /> : <T style={{ fontFamily: F.b, color: done ? C.go : C.primaryDark }}>{done ? '👍 Sent' : '👍 Thumbs up'}</T>}
              </Pressable>
            </View>
          );
        }) : <Muted>Nobody else was on this plan.</Muted>}
      </ScrollView>
    </ModalSheet>
  );
}
