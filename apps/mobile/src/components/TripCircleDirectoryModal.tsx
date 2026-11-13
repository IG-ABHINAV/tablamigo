import React from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { ModalSheet } from './ModalSheet';
import { T, H2, Muted, Avatar, PlusBadge } from './ui';
import { range } from './format';
import { api } from '../lib/api';
import { COUNTRIES } from '../lib/countries';
import { C, F, R } from '../lib/theme';

const cname = (cc: string) => COUNTRIES.find(c => c[0] === cc)?.[1] ?? cc;

export function TripCircleDirectoryModal({
  tripId,
  visible,
  onClose,
}: {
  tripId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: ['circle-directory', tripId],
    queryFn: () => api(`/trips/${tripId}/circle-directory`),
    enabled: visible,
  });

  const members = q.data?.members ?? [];

  return (
    <ModalSheet visible={visible} onClose={onClose}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T style={{ fontSize: 22 }}>👥</T>
          <H2>Circle Directory</H2>
          {members.length > 0 ? (
            <View style={{ backgroundColor: C.primarySoft, borderRadius: R.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
              <T style={{ fontFamily: F.b, fontSize: 12, color: C.primaryDark }}>{q.data?.totalMembers ?? members.length}</T>
            </View>
          ) : null}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={8} style={{ padding: 4 }}>
          <Ionicons name="close" size={24} color={C.ink2} />
        </Pressable>
      </View>

      {q.data?.topic ? (
        <View style={{ backgroundColor: '#F0F9FF', borderWidth: 1, borderColor: '#BAE6FD', borderRadius: R.md, padding: 10, marginBottom: 12 }}>
          <T style={{ fontSize: 11, fontFamily: F.b, color: '#0369A1' }}>🎯 ACTIVE CIRCLE TOPIC</T>
          <T style={{ fontSize: 13, color: '#0C4A6E', marginTop: 2 }}>{q.data.topic}</T>
        </View>
      ) : null}

      <FlatList
        data={members}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ gap: 10, paddingBottom: 24 }}
        style={{ maxHeight: 420 }}
        renderItem={({ item: u }) => (
          <Pressable
            onPress={() => {
              onClose();
              router.push(`/user/${u.id}`);
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              padding: 12,
              borderRadius: R.md,
              backgroundColor: '#fff',
              borderWidth: 1,
              borderColor: C.line,
            }}
          >
            <Avatar uri={u.photoUrl} name={u.name} size={44} cc={u.homeCountry} />
            <View style={{ flex: 1, gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <T style={{ fontFamily: F.b, fontSize: 15 }}>{u.name}</T>
                {u.verified ? <T style={{ fontSize: 12 }}>✅</T> : null}
                {u.isPlus ? <PlusBadge /> : null}
              </View>
              {u.startDate && u.endDate ? (
                <Muted style={{ fontSize: 12 }}>🗓️ {range(u.startDate, u.endDate)}</Muted>
              ) : null}
              <Muted style={{ fontSize: 11 }}>{cname(u.homeCountry)}</Muted>
              {u.travelStyle?.length ? (
                <T style={{ fontSize: 11, color: '#4B5563' }}>🎒 {u.travelStyle.slice(0, 3).join(' · ')}</T>
              ) : null}
            </View>
            <Ionicons name="chevron-forward" size={16} color={C.ink3} />
          </Pressable>
        )}
        // Free accounts see the same preview as a trip's overlap list; the rest is a Trip Pass or Plus.
        ListFooterComponent={q.data?.locked ? (
          <Pressable
            onPress={() => { onClose(); router.push('/paywall?reason=trip_pass&plan=pass'); }}
            style={{ padding: 16, borderRadius: R.md, backgroundColor: C.ink, alignItems: 'center', gap: 4 }}
          >
            <T style={{ color: '#fff', fontFamily: F.b }}>See all {q.data.totalMembers} members</T>
            <T style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>{q.data.hiddenCount} more with a Trip Pass or Plus</T>
          </Pressable>
        ) : null}
      />
    </ModalSheet>
  );
}
