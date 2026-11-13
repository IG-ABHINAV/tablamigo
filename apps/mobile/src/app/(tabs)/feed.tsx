import React, { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Pressable, RefreshControl, Share, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, H1, Muted, Avatar, Chip, Empty, Button } from '../../components/ui';
import { NewMomentModal } from '../../components/NewMomentModal';
import { MomentCommentsSheet } from '../../components/MomentCommentsSheet';
import { ReportButton } from '../../components/ReportButton';
import { PhotoViewer } from '../../components/PhotoViewer';
import { feedPhotos, placeRoute, type ViewerPhoto } from '../../lib/photo-viewer';
import { api, ApiError, trackEvent } from '../../lib/api';
import { queryClient } from '../../lib/query';
import { useHere } from '../../lib/useHere';
import { momentLink } from '../../lib/share';
import { C, F, R, flag } from '../../lib/theme';

export default function Feed() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me') });
  // Nearby needs a real place (lib/where.ts); without one that tab waits for it instead of showing another city.
  const { here } = useHere();
  const [scope, setScope] = useState<'all' | 'city' | 'nearby' | 'following'>('all');
  const [composeVisible, setComposeVisible] = useState(false);
  const [activeCommentsMomentId, setActiveCommentsMomentId] = useState<string | null>(null);
  // The photo viewer: every photo in the loaded feed, so a swipe moves to the next post's photo.
  const [viewer, setViewer] = useState<{ photos: ViewerPhoto[]; index: number } | null>(null);

  const cityName = me.data?.city ?? null;

  const q = useQuery({
    queryKey: ['moments', scope, cityName, here?.lat, here?.lng],
    queryFn: () => {
      let url = `/moments?scope=${scope}`;
      if (scope === 'city' && cityName) url += `&city=${encodeURIComponent(cityName)}`;
      if (scope === 'nearby' && here) url += `&lat=${here.lat}&lng=${here.lng}&radiusKm=50`;
      return api(url);
    },
    enabled: scope !== 'nearby' || !!here,
  });

  const likeMutation = useMutation({
    mutationFn: ({ id, liked }: { id: string; liked: boolean }) =>
      api(`/moments/${id}/like`, { method: liked ? 'DELETE' : 'POST' }),
    onMutate: async ({ id, liked }) => {
      await queryClient.cancelQueries({ queryKey: ['moments'] });
      queryClient.setQueriesData({ queryKey: ['moments'] }, (old: any) => {
        if (!old?.moments) return old;
        return {
          ...old,
          moments: old.moments.map((m: any) =>
            m.id === id
              ? {
                  ...m,
                  likedByMe: !liked,
                  likesCount: Math.max(0, m.likesCount + (!liked ? 1 : -1))
                }
              : m
          )
        };
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['moments'] });
    }
  });

  const shareMoment = async (m: any) => {
    const url = momentLink(m.id);
    trackEvent('moment_shared', { momentId: m.id, city: m.city });
    try {
      await Share.share({
        message: `${m.userName}'s travel moment in ${m.city || 'Tablamigo'}: "${m.caption}"\n\n${url}`,
        url
      });
    } catch { /* cancelled */ }
  };

  const myCityLabel = cityName ? `${cityName} 📍` : 'City';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bgSoft }} edges={['top']}>
      {/* Top Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: C.line }}>
        <H1 style={{ fontSize: 22 }}>Travel Feed ✨</H1>
        <Pressable
          onPress={() => setComposeVisible(true)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: R.pill }}
        >
          <Ionicons name="add" size={18} color="#fff" />
          <T style={{ color: '#fff', fontFamily: F.b, fontSize: 13.5 }}>Share</T>
        </Pressable>
      </View>

      {/* Scope Filter Chips */}
      <View style={{ backgroundColor: '#fff', paddingVertical: 10, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: C.line }}>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={[
            { id: 'all', label: 'All Stories 🌍' },
            ...(cityName ? [{ id: 'city', label: myCityLabel }] : []),
            { id: 'nearby', label: 'Nearby (50 km) 🧭' },
            { id: 'following', label: 'Friends 👥' },
          ]}
          keyExtractor={item => item.id}
          contentContainerStyle={{ gap: 8 }}
          renderItem={({ item }) => (
            <Chip
              label={item.label}
              active={scope === item.id}
              onPress={() => setScope(item.id as any)}
            />
          )}
        />
      </View>

      {/* Feed List */}
      <FlatList
        data={q.data?.moments ?? []}
        keyExtractor={(item: any) => item.id}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={C.primary} />}
        contentContainerStyle={{ padding: 14, gap: 14, paddingBottom: 60 }}
        ListEmptyComponent={
          q.isLoading ? (
            <ActivityIndicator style={{ paddingVertical: 60 }} color={C.primary} />
          ) : (
            <Empty
              emoji="📸"
              title={scope === 'city' ? `No moments in ${cityName} yet` : 'Quiet in the feed'}
              body="Post the first photo from your trip or ask travelers nearby for recs!"
              action={<Button title="Share a Moment" onPress={() => setComposeVisible(true)} style={{ marginTop: 14 }} />}
            />
          )
        }
        renderItem={({ item: m }: any) => {
          const isSelf = me.data?.id === m.userId;
          return (
            <View style={{ backgroundColor: '#fff', borderRadius: R.lg, overflow: 'hidden', borderWidth: 1, borderColor: C.line, gap: 10 }}>
              {/* Author Header */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingTop: 14 }}>
                <Pressable onPress={() => router.push(`/user/${m.userId}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
                  <Avatar uri={m.userPhoto} name={m.userName} size={42} cc={m.userCountry} />
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                      <T style={{ fontFamily: F.b, fontSize: 15 }}>{m.userName}</T>
                      {m.userCountry ? <T style={{ fontSize: 13 }}>{flag(m.userCountry)}</T> : null}
                      {m.userVerified ? <T style={{ fontSize: 11 }}>✅</T> : null}
                      {m.isBoosted ? (
                        <View style={{ backgroundColor: '#FEF3C7', paddingHorizontal: 6, paddingVertical: 1.5, borderRadius: 4 }}>
                          <T style={{ color: '#D97706', fontSize: 10, fontFamily: F.b }}>⚡ Spotlight</T>
                        </View>
                      ) : null}
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
                      {m.city && placeRoute(m.city, m.countryCode) ? (
                        <Pressable accessibilityRole="link" accessibilityLabel={`Open ${m.city}`} hitSlop={6} onPress={() => router.push(placeRoute(m.city, m.countryCode) as any)}>
                          <Muted style={{ fontSize: 12, color: C.primaryDark, fontFamily: F.sb }}>📍 {m.city}</Muted>
                        </Pressable>
                      ) : m.city ? <Muted style={{ fontSize: 12 }}>📍 {m.city}</Muted> : null}
                      <Muted style={{ fontSize: 12 }}>
                        {m.city ? ' · ' : ''}{new Date(m.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                      </Muted>
                    </View>
                  </View>
                </Pressable>

                {!isSelf ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <Pressable
                      onPress={() => router.push(`/user/${m.userId}`)}
                      style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: R.pill, backgroundColor: C.bgSoft }}
                    >
                      <T style={{ fontSize: 12, fontFamily: F.b, color: C.ink }}>Profile</T>
                    </Pressable>
                    <ReportButton target={{ type: 'moment', id: m.id, userId: m.userId, userName: m.userName }} size={18} />
                  </View>
                ) : null}
              </View>

              {/* Photo Image */}
              {m.imageUrl ? (
                <Pressable accessibilityRole="imagebutton" accessibilityLabel={`Open ${m.userName}'s photo`}
                  onPress={() => setViewer(feedPhotos(q.data?.moments ?? [], m.id))}
                  style={{ width: '100%', height: 280, backgroundColor: C.bgSoft }}>
                  <Image source={{ uri: m.imageUrl }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                </Pressable>
              ) : null}

              {/* Caption & Category */}
              <View style={{ paddingHorizontal: 14, gap: 6 }}>
                {m.category && m.category !== 'general' ? (
                  <View style={{ alignSelf: 'flex-start', backgroundColor: C.primarySoft, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
                    <T style={{ fontSize: 11, fontFamily: F.b, color: C.primaryDark, textTransform: 'capitalize' }}>
                      {m.category}
                    </T>
                  </View>
                ) : null}
                <T style={{ fontSize: 14.5, color: C.ink, lineHeight: 21 }}>{m.caption}</T>
              </View>

              {/* Action Bar */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingBottom: 12, paddingTop: 4, borderTopWidth: 1, borderTopColor: C.bgSoft }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                  {/* Like Button */}
                  <Pressable
                    onPress={() => likeMutation.mutate({ id: m.id, liked: m.likedByMe })}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
                    hitSlop={8}
                  >
                    <Ionicons
                      name={m.likedByMe ? 'heart' : 'heart-outline'}
                      size={22}
                      color={m.likedByMe ? '#EF4444' : C.ink2}
                    />
                    <T style={{ fontSize: 13, fontFamily: F.sb, color: m.likedByMe ? '#EF4444' : C.ink2 }}>
                      {m.likesCount || 0}
                    </T>
                  </Pressable>

                  {/* Comment Button */}
                  <Pressable
                    onPress={() => setActiveCommentsMomentId(m.id)}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
                    hitSlop={8}
                  >
                    <Ionicons name="chatbubble-outline" size={20} color={C.ink2} />
                    <T style={{ fontSize: 13, fontFamily: F.sb, color: C.ink2 }}>
                      {m.commentsCount || 0}
                    </T>
                  </Pressable>
                </View>

                {/* Share Button */}
                <Pressable onPress={() => shareMoment(m)} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }} hitSlop={8}>
                  <Ionicons name="share-social-outline" size={20} color={C.ink2} />
                  <T style={{ fontSize: 13, fontFamily: F.sb, color: C.ink2 }}>Share</T>
                </Pressable>
              </View>
            </View>
          );
        }}
      />

      {/* New Moment Modal */}
      <NewMomentModal
        visible={composeVisible}
        onClose={() => setComposeVisible(false)}
        defaultCity={cityName}
      />

      <PhotoViewer photos={viewer?.photos ?? []} index={viewer ? viewer.index : null} onClose={() => setViewer(null)} />

      {/* Comments Sheet */}
      <MomentCommentsSheet
        momentId={activeCommentsMomentId}
        onClose={() => setActiveCommentsMomentId(null)}
      />
    </SafeAreaView>
  );
}
