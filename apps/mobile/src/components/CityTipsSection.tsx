import React, { useState } from 'react';
import { Alert, FlatList, Pressable, ScrollView, View } from 'react-native';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { ModalSheet } from './ModalSheet';
import { T, H2, Muted, Button, Input, Chip, Avatar, Pill } from './ui';
import { api, ApiError } from '../lib/api';
import { queryClient } from '../lib/query';
import { ReportButton } from './ReportButton';
import { C, F, R, flag, shadow } from '../lib/theme';

export const TIP_CATEGORIES = [
  { id: 'all', label: 'All', emoji: '✨' },
  { id: 'food', label: 'Food', emoji: '🍜' },
  { id: 'sunset', label: 'Sunset', emoji: '🌅' },
  { id: 'coworking', label: 'Coworking', emoji: '💻' },
  { id: 'nightlife', label: 'Nightlife', emoji: '🪩' },
  { id: 'safety', label: 'Safety', emoji: '🛡️' },
  { id: 'transit', label: 'Transit', emoji: '🚇' },
  { id: 'general', label: 'General', emoji: '💡' },
] as const;

export function CityTipsSection({ slug, cityName }: { slug: string; cityName: string }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<any>('/me') });
  const [selectedCat, setSelectedCat] = useState<string>('all');
  const [addModalOpen, setAddModalOpen] = useState(false);

  // New tip form state
  const [newCat, setNewCat] = useState<'food' | 'sunset' | 'coworking' | 'nightlife' | 'safety' | 'transit' | 'general'>('general');
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newPlace, setNewPlace] = useState('');

  const q = useQuery({
    queryKey: ['city-tips', slug, selectedCat],
    queryFn: () => api<any>(`/cities/${slug}/tips${selectedCat !== 'all' ? `?category=${selectedCat}` : ''}`),
    enabled: !!slug,
  });

  const upvoteMutation = useMutation({
    mutationFn: (tipId: string) => api<any>(`/cities/tips/${tipId}/upvote`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['city-tips', slug] });
    },
  });

  const addTipMutation = useMutation({
    mutationFn: () => api<any>(`/cities/${slug}/tips`, {
      method: 'POST',
      body: {
        category: newCat,
        title: newTitle.trim(),
        body: newBody.trim(),
        placeName: newPlace.trim() || undefined,
      }
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['city-tips', slug] });
      setAddModalOpen(false);
      setNewTitle('');
      setNewBody('');
      setNewPlace('');
      Alert.alert('Tip posted! 💡', 'Thanks for helping other travelers with your local recommendation.');
    },
    onError: (e: any) => {
      Alert.alert('Could not post tip', e instanceof ApiError ? e.message : 'Please try again.');
    }
  });

  const tips = q.data?.tips ?? [];

  return (
    <View style={{ gap: 14 }}>
      {/* Header and Add button */}
      <View style={{ paddingHorizontal: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <T style={{ fontSize: 20 }}>💡</T>
          <H2>Traveler Tips & Gems ({tips.length})</H2>
        </View>
        <Button
          title="➕ Add Tip"
          kind="ghost"
          onPress={() => setAddModalOpen(true)}
          style={{ paddingHorizontal: 12, paddingVertical: 4, height: 32 }}
        />
      </View>

      {/* Category filters */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, gap: 8 }}>
        {TIP_CATEGORIES.map(cat => (
          <Chip
            key={cat.id}
            label={cat.label}
            emoji={cat.emoji}
            active={selectedCat === cat.id}
            onPress={() => setSelectedCat(cat.id)}
          />
        ))}
      </ScrollView>

      {/* Tips list */}
      {tips.length > 0 ? (
        <View style={{ paddingHorizontal: 20, gap: 10 }}>
          {tips.map((tip: any) => {
            const catMeta = TIP_CATEGORIES.find(c => c.id === tip.category);
            return (
              <View
                key={tip.id}
                style={[{ backgroundColor: '#fff', borderRadius: R.lg, padding: 14, borderWidth: 1, borderColor: C.line, gap: 8 }, shadow]}
              >
                {/* Author and Category */}
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Avatar uri={tip.author.photoUrl} name={tip.author.name} size={28} cc={tip.author.homeCountry} />
                    <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink }}>
                      {tip.author.name} {tip.author.verified ? '✅' : ''} {flag(tip.author.homeCountry)}
                    </T>
                  </View>
                  <Pill bg={C.primarySoft} fg={C.primaryDark}>
                    {catMeta?.emoji ?? '💡'} {catMeta?.label ?? tip.category}
                  </Pill>
                </View>

                {/* Title & Body */}
                <T style={{ fontFamily: F.b, fontSize: 15, color: C.ink }}>{tip.title}</T>
                <T style={{ fontSize: 13.5, color: C.ink2, lineHeight: 19 }}>{tip.body}</T>

                {tip.placeName ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                    <Ionicons name="location-outline" size={14} color={C.primary} />
                    <T style={{ fontSize: 12, fontFamily: F.m, color: C.ink2 }}>{tip.placeName}</T>
                  </View>
                ) : null}

                {/* Helpful button, and a report flag for other people's tips */}
                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 14, marginTop: 4 }}>
                  {tip.author.id !== me.data?.id ? <ReportButton target={{ type: 'city_tip', id: tip.id, userId: tip.author.id, userName: tip.author.name }} size={18} /> : null}
                  <Pressable
                    onPress={() => upvoteMutation.mutate(tip.id)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 6,
                      paddingHorizontal: 10,
                      paddingVertical: 4,
                      borderRadius: R.pill,
                      backgroundColor: tip.hasUpvoted ? C.goSoft : C.bgSoft,
                      borderWidth: 1,
                      borderColor: tip.hasUpvoted ? C.go : C.line
                    }}
                  >
                    <T style={{ fontSize: 12 }}>👍</T>
                    <T style={{ fontSize: 12, fontFamily: F.sb, color: tip.hasUpvoted ? C.go : C.ink2 }}>
                      Helpful{tip.helpfulCount > 0 ? ` (${tip.helpfulCount})` : ''}
                    </T>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>
      ) : (
        <View style={{ paddingHorizontal: 20 }}>
          <View style={{ backgroundColor: '#fff', borderRadius: R.lg, padding: 18, alignItems: 'center', gap: 6, borderWidth: 1, borderColor: C.line }}>
            <T style={{ fontSize: 24 }}>💡</T>
            <T style={{ fontFamily: F.b, fontSize: 14 }}>No tips in this category yet</T>
            <Muted style={{ fontSize: 12, textAlign: 'center' }}>
              Know a hidden gem or great cafe in {cityName}? Share it with other solo travelers!
            </Muted>
            <Button
              title="Post the first tip"
              kind="go"
              onPress={() => setAddModalOpen(true)}
              style={{ marginTop: 6, paddingHorizontal: 16, height: 34 }}
            />
          </View>
        </View>
      )}

      {/* Add Tip Modal Sheet */}
      <ModalSheet visible={addModalOpen} onClose={() => setAddModalOpen(false)}>
        <ScrollView style={{ maxHeight: 500 }} contentContainerStyle={{ gap: 12, paddingBottom: 20 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <H2>Share a Tip for {cityName} 💡</H2>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => setAddModalOpen(false)} hitSlop={8}>
              <Ionicons name="close" size={24} color={C.ink2} />
            </Pressable>
          </View>

          {/* Category Picker */}
          <T style={{ fontFamily: F.b, fontSize: 13, color: C.ink2 }}>Category</T>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {TIP_CATEGORIES.filter(c => c.id !== 'all').map(cat => (
              <Chip
                key={cat.id}
                label={cat.label}
                emoji={cat.emoji}
                active={newCat === cat.id}
                onPress={() => setNewCat(cat.id as any)}
              />
            ))}
          </ScrollView>

          {/* Title */}
          <T style={{ fontFamily: F.b, fontSize: 13, color: C.ink2, marginTop: 4 }}>Title / Hook</T>
          <Input
            value={newTitle}
            onChangeText={setNewTitle}
            placeholder="e.g. Best sunset view with cold drinks"
            maxLength={100}
          />

          {/* Place Name */}
          <T style={{ fontFamily: F.b, fontSize: 13, color: C.ink2, marginTop: 4 }}>Place / Venue (optional)</T>
          <Input
            value={newPlace}
            onChangeText={setNewPlace}
            placeholder="e.g. Rooftop 360, Old Town"
            maxLength={120}
          />

          {/* Body */}
          <T style={{ fontFamily: F.b, fontSize: 13, color: C.ink2, marginTop: 4 }}>Details & Advice</T>
          <Input
            value={newBody}
            onChangeText={setNewBody}
            placeholder="Give practical advice: best time to go, prices, safety tips, or what to order..."
            multiline
            numberOfLines={4}
            maxLength={500}
            style={{ height: 90 }}
          />

          <Button
            title="Post Tip"
            loading={addTipMutation.isPending}
            disabled={newTitle.trim().length < 3 || newBody.trim().length < 10}
            onPress={() => addTipMutation.mutate()}
            style={{ marginTop: 8 }}
          />
        </ScrollView>
      </ModalSheet>
    </View>
  );
}
