import React, { useState } from 'react';
import { ActivityIndicator, Alert, Image, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { Modal } from './Modal';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { T, Muted, Button, Chip } from './ui';
import { api, ApiError } from '../lib/api';
import { pickAndUpload } from '../lib/upload';
import { queryClient } from '../lib/query';
import { useLocation } from '../lib/location';
import { C, F, R } from '../lib/theme';

type Props = {
  visible: boolean;
  onClose: () => void;
  defaultCity?: string | null;
};

const CATEGORIES = [
  { id: 'general', label: 'Story', emoji: '✨' },
  { id: 'meetup', label: 'Meetup', emoji: '🍹' },
  { id: 'tip', label: 'Travel Tip', emoji: '💡' },
  { id: 'recommendation', label: 'Must-Visit', emoji: '⭐' },
  { id: 'question', label: 'Ask Locals', emoji: '❓' },
];

export function NewMomentModal({ visible, onClose, defaultCity }: Props) {
  const insets = useSafeAreaInsets();
  const [caption, setCaption] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [category, setCategory] = useState('general');
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const pos = useLocation(s => s.pos);

  const pickPhoto = async () => {
    try {
      setUploading(true);
      const url = await pickAndUpload('chat');
      if (url) setImageUrl(url);
    } catch (e: any) {
      Alert.alert('Upload failed', e.message || 'Could not upload photo.');
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    if (!imageUrl) {
      Alert.alert('Photo needed', 'Add a travel photo for your moment.');
      return;
    }
    if (!caption.trim()) {
      Alert.alert('Caption needed', 'Write a short caption or story.');
      return;
    }

    try {
      setSubmitting(true);
      await api('/moments', {
        method: 'POST',
        body: {
          imageUrl,
          caption: caption.trim(),
          category,
          city: defaultCity || undefined,
          lat: pos?.lat,
          lng: pos?.lng,
        }
      });
      queryClient.invalidateQueries({ queryKey: ['moments'] });
      setCaption('');
      setImageUrl(null);
      setCategory('general');
      onClose();
    } catch (e: any) {
      Alert.alert('Could not post', e instanceof ApiError ? e.message : 'Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#fff', paddingTop: Platform.OS === 'ios' ? 12 : insets.top }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <Pressable onPress={onClose} hitSlop={10}>
            <T style={{ color: C.ink2, fontFamily: F.sb, fontSize: 16 }}>Cancel</T>
          </Pressable>
          <T style={{ fontFamily: F.b, fontSize: 17 }}>New Travel Moment</T>
          <Pressable onPress={submit} disabled={submitting || !imageUrl || !caption.trim()} hitSlop={10}>
            {submitting ? (
              <ActivityIndicator size="small" color={C.primary} />
            ) : (
              <T style={{ color: imageUrl && caption.trim() ? C.primary : C.ink3, fontFamily: F.b, fontSize: 16 }}>Post</T>
            )}
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
          {/* Photo Picker Box */}
          {imageUrl ? (
            <View style={{ width: '100%', height: 260, borderRadius: R.lg, overflow: 'hidden', backgroundColor: C.bgSoft, position: 'relative' }}>
              <Image source={{ uri: imageUrl }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
              <Pressable accessibilityRole="button" accessibilityLabel="Close"
                onPress={() => setImageUrl(null)}
                style={{ position: 'absolute', top: 12, right: 12, width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' }}
              >
                <Ionicons name="close" size={20} color="#fff" />
              </Pressable>
            </View>
          ) : (
            <Pressable
              onPress={pickPhoto}
              disabled={uploading}
              style={{ width: '100%', height: 220, borderRadius: R.lg, borderWidth: 1.5, borderColor: C.line, borderStyle: 'dashed', backgroundColor: C.bgSoft, alignItems: 'center', justifyContent: 'center', gap: 8 }}
            >
              {uploading ? (
                <ActivityIndicator color={C.primary} />
              ) : (
                <>
                  <View style={{ width: 50, height: 50, borderRadius: 25, backgroundColor: C.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name="camera" size={26} color={C.primaryDark} />
                  </View>
                  <T style={{ fontFamily: F.b, fontSize: 15, color: C.ink }}>Select Travel Photo</T>
                  <Muted style={{ fontSize: 12 }}>Show other travelers what you're up to</Muted>
                </>
              )}
            </Pressable>
          )}

          {/* Caption Input */}
          <View style={{ gap: 6 }}>
            <T style={{ fontFamily: F.b, fontSize: 14, color: C.ink }}>Caption & Story</T>
            <TextInput
              value={caption}
              onChangeText={setCaption}
              placeholder="What's happening? Sunset drinks, finding travel buddies, cafe recs..."
              placeholderTextColor={C.ink3}
              multiline
              maxLength={1000}
              style={{ backgroundColor: C.bgSoft, borderRadius: R.md, padding: 12, fontSize: 15, minHeight: 90, color: C.ink, fontFamily: F.r, textAlignVertical: 'top' }}
            />
          </View>

          {/* Category Chips */}
          <View style={{ gap: 8 }}>
            <T style={{ fontFamily: F.b, fontSize: 14, color: C.ink }}>Topic</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {CATEGORIES.map(c => (
                <Chip
                  key={c.id}
                  label={c.label}
                  emoji={c.emoji}
                  active={category === c.id}
                  onPress={() => setCategory(c.id)}
                />
              ))}
            </View>
          </View>

          {defaultCity ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.bgSoft, padding: 12, borderRadius: R.md }}>
              <Ionicons name="location" size={16} color={C.primary} />
              <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink }}>Posting from {defaultCity}</T>
            </View>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
