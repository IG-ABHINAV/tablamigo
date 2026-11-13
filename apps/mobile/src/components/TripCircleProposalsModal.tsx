import React, { useState } from 'react';
import { FlatList, Pressable, View, TextInput, Alert, ScrollView } from 'react-native';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { ModalSheet } from './ModalSheet';
import { T, H2, Muted, Button, Chip } from './ui';
import { api } from '../lib/api';
import { queryClient } from '../lib/query';
import { ReportButton } from './ReportButton';
import { C, F, R } from '../lib/theme';

const CATEGORIES = [
  ['Drinks 🍷', 'drinks'],
  ['Food 🍜', 'food'],
  ['Outdoors 🏖️', 'outdoors'],
  ['Culture 🏛️', 'culture'],
  ['Nightlife 🌙', 'nightlife'],
  ['Coworking 💻', 'coworking'],
  ['Sports ⚽', 'sports'],
] as const;

export function TripCircleProposalsModal({
  tripId,
  visible,
  onClose,
}: {
  tripId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me') });
  const [isPitching, setIsPitching] = useState(false);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<'drinks'|'food'|'outdoors'|'culture'|'nightlife'|'coworking'|'sports'>('drinks');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);

  const q = useQuery({
    queryKey: ['circle-proposals', tripId],
    queryFn: () => api(`/trips/${tripId}/circle-proposals`),
    enabled: visible,
  });

  const voteMutation = useMutation({
    mutationFn: (proposalId: string) => api(`/trips/${tripId}/circle-proposals/${proposalId}/vote`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['circle-proposals', tripId] });
      queryClient.invalidateQueries({ queryKey: ['tripGroupChat', tripId] });
    },
    onError: () => Alert.alert('Vote failed', 'Please try again.'),
  });

  const pitchMutation = useMutation({
    mutationFn: (body: any) => api(`/trips/${tripId}/circle-proposals`, { method: 'POST', body }),
    onSuccess: () => {
      setIsPitching(false);
      setTitle('');
      queryClient.invalidateQueries({ queryKey: ['circle-proposals', tripId] });
      queryClient.invalidateQueries({ queryKey: ['tripGroupChat', tripId] });
      queryClient.invalidateQueries({ queryKey: ['chats'] });
    },
    onError: () => Alert.alert('Could not submit meetup idea', 'Please check the details and try again.'),
  });

  const proposals = q.data?.proposals ?? [];

  return (
    <ModalSheet visible={visible} onClose={onClose}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T style={{ fontSize: 22 }}>💡</T>
          <H2>Meetup Ideas</H2>
          {proposals.length > 0 ? (
            <View style={{ backgroundColor: C.primarySoft, borderRadius: R.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
              <T style={{ fontFamily: F.b, fontSize: 12, color: C.primaryDark }}>{proposals.length}</T>
            </View>
          ) : null}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={8} style={{ padding: 4 }}>
          <Ionicons name="close" size={24} color={C.ink2} />
        </Pressable>
      </View>

      {isPitching ? (
        <View style={{ gap: 10, padding: 14, backgroundColor: '#fff', borderRadius: R.lg, borderWidth: 1, borderColor: C.line, marginBottom: 12 }}>
          <T style={{ fontFamily: F.b, fontSize: 14 }}>Pitch a Meetup to the Circle</T>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Sunset drinks & live jazz at rooftop"
            placeholderTextColor={C.ink3}
            maxLength={120}
            style={{ backgroundColor: C.bgSoft, padding: 10, borderRadius: R.md, fontSize: 14, color: C.ink }}
          />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {CATEGORIES.map(([label, catKey]) => (
              <Chip
                key={catKey}
                label={label}
                active={category === catKey}
                onPress={() => setCategory(catKey as any)}
              />
            ))}
          </ScrollView>
          <TextInput
            value={date}
            onChangeText={setDate}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={C.ink3}
            style={{ backgroundColor: C.bgSoft, padding: 8, borderRadius: R.md, fontSize: 13, color: C.ink }}
          />
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <Pressable onPress={() => setIsPitching(false)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: R.md, backgroundColor: C.bgSoft }}>
              <T style={{ fontSize: 12, fontFamily: F.sb, color: C.ink2 }}>Cancel</T>
            </Pressable>
            <Pressable
              onPress={() => pitchMutation.mutate({ title, category, proposedDate: date })}
              disabled={pitchMutation.isPending || title.trim().length < 3}
              style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: R.md, backgroundColor: C.primary }}
            >
              <T style={{ fontSize: 12, fontFamily: F.b, color: '#fff' }}>
                {pitchMutation.isPending ? 'Pitching…' : 'Share Idea'}
              </T>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={{ marginBottom: 12 }}>
          <Button
            title="+ Pitch a Meetup Idea"
            kind="ghost"
            onPress={() => setIsPitching(true)}
            style={{ height: 40 }}
          />
        </View>
      )}

      <FlatList
        data={proposals}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ gap: 10, paddingBottom: 24 }}
        style={{ maxHeight: 380 }}
        ListEmptyComponent={
          q.isLoading ? null : (
            <View style={{ alignItems: 'center', paddingVertical: 24, gap: 6 }}>
              <T style={{ fontSize: 28 }}>💡</T>
              <T style={{ fontFamily: F.b, fontSize: 15 }}>No meetup ideas pitched yet</T>
              <Muted style={{ fontSize: 13, textAlign: 'center' }}>
                Have an activity in mind? Suggest it to everyone in this trip circle!
              </Muted>
            </View>
          )
        }
        renderItem={({ item }) => (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: 12,
              borderRadius: R.md,
              backgroundColor: '#fff',
              borderWidth: 1,
              borderColor: C.line,
              gap: 10,
            }}
          >
            <View style={{ flex: 1, gap: 3 }}>
              <T style={{ fontFamily: F.b, fontSize: 15 }}>{item.title}</T>
              <Muted style={{ fontSize: 12 }}>
                🗓️ {item.proposedDate} · Suggested by {item.proposer?.name ?? 'Traveler'}
              </Muted>
            </View>
            {item.proposer?.id && item.proposer.id !== me.data?.id ? (
              <ReportButton target={{ type: 'circle_proposal', id: item.id, userId: item.proposer.id, userName: item.proposer.name }} size={18} before={onClose} />
            ) : null}
            <Pressable
              onPress={() => voteMutation.mutate(item.id)}
              hitSlop={6}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: R.pill,
                backgroundColor: item.hasVoted ? C.primarySoft : C.bgSoft,
                borderWidth: 1,
                borderColor: item.hasVoted ? C.primary : C.line,
              }}
            >
              <Ionicons
                name={item.hasVoted ? 'heart' : 'heart-outline'}
                size={16}
                color={item.hasVoted ? C.primaryDark : C.ink2}
              />
              <T style={{ fontSize: 12, fontFamily: F.b, color: item.hasVoted ? C.primaryDark : C.ink }}>
                {item.voteCount}
              </T>
            </Pressable>
          </View>
        )}
      />
    </ModalSheet>
  );
}
