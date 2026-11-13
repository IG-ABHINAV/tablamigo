import React, { useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { Modal } from './Modal';
import { useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, H1, Muted, Button, Chip, Input } from './ui';
import { api, ApiError } from '../lib/api';
import { queryClient } from '../lib/query';
import { C, F, R } from '../lib/theme';

const HOST_TAGS = [
  'Friendly',
  'Great Communicator',
  'Welcoming',
  'On-Time',
  'Great Recommendations',
  'Fun Group Vibe'
];

export function RateHostModal({
  activityId,
  hostName,
  visible,
  onClose
}: {
  activityId: string;
  hostName: string;
  visible: boolean;
  onClose: () => void;
}) {
  const [rating, setRating] = useState<number>(5);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<string>('');

  const rateMutation = useMutation({
    mutationFn: () => api(`/activities/${activityId}/rate`, {
      method: 'POST',
      body: {
        rating,
        tags: selectedTags,
        feedback: feedback.trim() || undefined
      }
    }),
    onSuccess: () => {
      Alert.alert('Thank you!', 'Your private rating helps keep Tablamigo meetups great.');
      queryClient.invalidateQueries({ queryKey: ['activity', activityId] });
      onClose();
    },
    onError: (e: any) => Alert.alert('Rating failed', e instanceof ApiError ? e.message : 'Could not submit rating.')
  });

  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <View style={{ backgroundColor: '#fff', borderTopLeftRadius: R.xl, borderTopRightRadius: R.xl, padding: 24, gap: 16, maxHeight: '90%' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <H1 style={{ fontSize: 22 }}>How was {hostName} as host?</H1>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={12}>
              <Ionicons name="close" size={24} color={C.ink} />
            </Pressable>
          </View>
          <Muted>Private feedback to help recognize great hosts and keep meetups safe.</Muted>

          {/* Star selector */}
          <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 12, paddingVertical: 10 }}>
            {[1, 2, 3, 4, 5].map((s) => (
              <Pressable key={s} onPress={() => setRating(s)} hitSlop={8}>
                <Ionicons
                  name={s <= rating ? 'star' : 'star-outline'}
                  size={36}
                  color={s <= rating ? '#F59E0B' : C.ink3}
                />
              </Pressable>
            ))}
          </View>

          {/* Compliment tags */}
          <View style={{ gap: 8 }}>
            <T style={{ fontFamily: F.b, fontSize: 14 }}>What made them a great host?</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {HOST_TAGS.map((tag) => {
                const active = selectedTags.includes(tag);
                return (
                  <Chip
                    key={tag}
                    label={tag}
                    active={active}
                    onPress={() => setSelectedTags(v => v.includes(tag) ? v.filter(x => x !== tag) : [...v, tag])}
                  />
                );
              })}
            </View>
          </View>

          {/* Optional notes */}
          <View style={{ gap: 6 }}>
            <T style={{ fontFamily: F.b, fontSize: 14 }}>Private note (optional)</T>
            <Input
              value={feedback}
              onChangeText={setFeedback}
              placeholder="e.g. Elena made sure everyone found the table easily"
              maxLength={400}
              multiline
            />
          </View>

          <Button
            title="Submit Private Rating"
            loading={rateMutation.isPending}
            onPress={() => rateMutation.mutate()}
            style={{ marginTop: 6 }}
          />
        </View>
      </View>
    </Modal>
  );
}
