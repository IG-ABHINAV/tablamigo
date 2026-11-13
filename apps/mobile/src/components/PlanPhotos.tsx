import React, { useState } from 'react';
import { Alert, Image, Pressable, ScrollView, View } from 'react-native';
import { Modal } from './Modal';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, Muted, Button, Input } from './ui';
import { PhotoViewer } from './PhotoViewer';
import { planPhotos } from '../lib/photo-viewer';
import { api, ApiError } from '../lib/api';
import { pickAndUpload } from '../lib/upload';
import { queryClient } from '../lib/query';
import { C, F, R } from '../lib/theme';

const EMOJIS = ['❤️', '🔥', '🙌', '👏', '😍'] as const;

export function PlanPhotos({ activityId, canAdd, isHost }: { activityId: string; canAdd: boolean; isHost?: boolean }) {
  const q = useQuery({
    queryKey: ['activityPhotos', activityId],
    queryFn: () => api(`/activities/${activityId}/photos`),
  });

  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me') });
  const [captionModal, setCaptionModal] = useState(false);
  const [pendingUrl, setPendingUrl] = useState('');
  const [caption, setCaption] = useState('');
  const [uploading, setUploading] = useState(false);

  // Lightbox state
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Only photos with a url, so the thumbnails, the viewer and its reactions and delete all count the same list.
  const photos: any[] = (q.data?.photos ?? []).filter((p: any) => !!p?.url);
  const viewerPhotos = planPhotos(photos);

  const addPhotoMutation = useMutation({
    mutationFn: (body: { url: string; caption?: string }) =>
      api(`/activities/${activityId}/photos`, { method: 'POST', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['activityPhotos', activityId] });
      queryClient.invalidateQueries({ queryKey: ['activity', activityId] });
      setCaptionModal(false);
      setPendingUrl('');
      setCaption('');
    },
    onError: (e: any) =>
      Alert.alert('Upload failed', e instanceof ApiError ? e.message : 'Could not add photo.'),
  });

  const deletePhotoMutation = useMutation({
    mutationFn: (photoId: string) => api(`/activities/${activityId}/photos/${photoId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['activityPhotos', activityId] });
      queryClient.invalidateQueries({ queryKey: ['activity', activityId] });
      setLightboxIndex(null);
    },
    onError: (e: any) =>
      Alert.alert('Delete failed', e instanceof ApiError ? e.message : 'Could not delete photo.'),
  });

  const reactMutation = useMutation({
    mutationFn: ({ photoId, emoji }: { photoId: string; emoji: string }) =>
      api(`/activities/${activityId}/photos/${photoId}/react`, { method: 'POST', body: { emoji } }),
    onSuccess: (data, vars) => {
      // Optimistically update query data
      queryClient.setQueryData(['activityPhotos', activityId], (old: any) => {
        if (!old?.photos) return old;
        return {
          ...old,
          photos: old.photos.map((p: any) => {
            if (p.id !== vars.photoId) return p;
            return {
              ...p,
              myReaction: data.myReaction,
              reactionsCount: data.reactionsCount,
              reactions: data.reactions,
            };
          }),
        };
      });
    },
    onError: (e: any) =>
      Alert.alert('Reaction failed', e instanceof ApiError ? e.message : 'Could not update reaction.'),
  });

  const handlePick = async () => {
    try {
      setUploading(true);
      const url = await pickAndUpload('avatar').catch(() => null);
      if (url) {
        setPendingUrl(url);
        setCaptionModal(true);
      }
    } finally {
      setUploading(false);
    }
  };

  if (!photos.length && !canAdd) return null;

  return (
    <View style={{ gap: 12, marginTop: 4 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View>
          <T style={{ fontFamily: F.b, fontSize: 17 }}>📸 Meetup Photos ({photos.length})</T>
          <Muted style={{ fontSize: 12 }}>Shared memories & highlights</Muted>
        </View>
        {canAdd && photos.length < 10 ? (
          <Pressable
            onPress={handlePick}
            disabled={uploading}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              backgroundColor: C.primarySoft,
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: R.pill,
            }}
          >
            <Ionicons name="camera" size={16} color={C.primaryDark} />
            <T style={{ color: C.primaryDark, fontFamily: F.b, fontSize: 13 }}>
              {uploading ? 'Uploading...' : 'Add photo'}
            </T>
          </Pressable>
        ) : null}
      </View>

      {photos.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 12, paddingVertical: 4 }}
        >
          {photos.map((p, idx) => {
            const hasReactions = (p.reactionsCount ?? 0) > 0;
            return (
              <Pressable
                key={p.id}
                onPress={() => setLightboxIndex(idx)}
                style={{
                  width: 140,
                  borderRadius: R.md,
                  overflow: 'hidden',
                  backgroundColor: C.bgSoft,
                  borderWidth: 1,
                  borderColor: C.line,
                }}
              >
                <View style={{ position: 'relative' }}>
                  <Image source={{ uri: p.url }} style={{ width: '100%', height: 130 }} resizeMode="cover" />
                  {hasReactions ? (
                    <View
                      style={{
                        position: 'absolute',
                        bottom: 6,
                        right: 6,
                        backgroundColor: 'rgba(0,0,0,0.65)',
                        borderRadius: R.pill,
                        paddingHorizontal: 6,
                        paddingVertical: 2,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 2,
                      }}
                    >
                      <T style={{ fontSize: 11 }}>{p.myReaction || p.reactions?.[0]?.emoji || '❤️'}</T>
                      <T style={{ fontSize: 10, color: '#fff', fontFamily: F.b }}>{p.reactionsCount}</T>
                    </View>
                  ) : null}
                </View>
                <View style={{ padding: 6, backgroundColor: '#fff', gap: 2 }}>
                  <T numberOfLines={1} style={{ fontSize: 11, fontFamily: F.b }}>
                    {p.user?.name || 'Traveler'}
                  </T>
                  {p.caption ? (
                    <Muted numberOfLines={1} style={{ fontSize: 10 }}>
                      {p.caption}
                    </Muted>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : (
        <View style={{ padding: 16, backgroundColor: C.bgSoft, borderRadius: R.md, alignItems: 'center', gap: 6 }}>
          <T style={{ fontSize: 24 }}>📷</T>
          <T style={{ fontFamily: F.sb, color: C.ink2, textAlign: 'center' }}>No photos yet</T>
          <Muted style={{ fontSize: 12, textAlign: 'center' }}>
            Were you there? Share a snapshot from the plan!
          </Muted>
        </View>
      )}

      {/* Full-screen viewer: swipe between the plan's photos, pinch to zoom; reactions below, delete for its author or the host. */}
      <PhotoViewer
        photos={viewerPhotos}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
        actions={(_, i) => {
          const photo = photos[i];
          if (!photo || !(photo.user?.id === me.data?.id || isHost)) return null;
          return (
            <Pressable accessibilityRole="button" accessibilityLabel="Delete photo" hitSlop={8}
              onPress={() => {
                Alert.alert('Delete photo?', 'This photo will be permanently removed from the meetup album.', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Delete', style: 'destructive', onPress: () => deletePhotoMutation.mutate(photo.id) },
                ]);
              }}>
              <Ionicons name="trash-outline" size={22} color="#ff6b6b" />
            </Pressable>
          );
        }}
        footer={(_, i) => {
          const photo = photos[i];
          if (!photo) return null;
          return (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
              {EMOJIS.map((emoji) => {
                const isActive = photo.myReaction === emoji;
                const countForEmoji = photo.reactions?.find((r: any) => r.emoji === emoji)?.count ?? 0;
                return (
                  <Pressable
                    key={emoji}
                    accessibilityRole="button"
                    accessibilityLabel={`React ${emoji}`}
                    onPress={() => reactMutation.mutate({ photoId: photo.id, emoji })}
                    style={{
                      flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 8, borderRadius: R.pill,
                      backgroundColor: isActive ? C.primary : 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: isActive ? C.primaryDark : 'transparent', gap: 4,
                    }}
                  >
                    <T style={{ fontSize: 18 }}>{emoji}</T>
                    {countForEmoji > 0 ? <T style={{ fontSize: 12, fontFamily: F.b, color: isActive ? '#fff' : '#ddd' }}>{countForEmoji}</T> : null}
                  </Pressable>
                );
              })}
            </View>
          );
        }}
      />

      {/* Caption Modal for new uploads */}
      <Modal visible={captionModal} transparent animationType="fade" onRequestClose={() => setCaptionModal(false)}>
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.5)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 20,
          }}
        >
          <View
            style={{
              width: '100%',
              maxWidth: 360,
              backgroundColor: '#fff',
              borderRadius: R.lg,
              padding: 20,
              gap: 14,
            }}
          >
            <T style={{ fontFamily: F.b, fontSize: 18 }}>Add a photo caption</T>
            {pendingUrl ? (
              <Image
                source={{ uri: pendingUrl }}
                style={{ width: '100%', height: 160, borderRadius: R.md }}
                resizeMode="cover"
              />
            ) : null}
            <Input
              value={caption}
              onChangeText={setCaption}
              placeholder="e.g. Best sunset view in town!"
              maxLength={200}
            />
            <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end', marginTop: 6 }}>
              <Button title="Cancel" kind="ghost" onPress={() => setCaptionModal(false)} />
              <Button
                title="Post photo"
                loading={addPhotoMutation.isPending}
                onPress={() =>
                  addPhotoMutation.mutate({ url: pendingUrl, caption: caption.trim() || undefined })
                }
              />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
