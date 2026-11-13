import React, { useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { Modal } from './Modal';
import { useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, H1, Muted, Button, Chip, Input } from './ui';
import { api, ApiError } from '../lib/api';
import { queryClient } from '../lib/query';
import { C, F, R } from '../lib/theme';

const QUICK_MINUTES = [5, 10, 15, 20, 30, 45, 60];

export function RunningLateModal({
  activityId,
  visible,
  initialMins = 15,
  initialNote = '',
  onClose,
}: {
  activityId: string;
  visible: boolean;
  initialMins?: number;
  initialNote?: string;
  onClose: () => void;
}) {
  const [mins, setMins] = useState<number>(initialMins || 15);
  const [note, setNote] = useState<string>(initialNote || '');

  const lateMutation = useMutation({
    mutationFn: () =>
      api(`/activities/${activityId}/running-late`, {
        method: 'POST',
        body: {
          mins,
          note: note.trim() || undefined,
        },
      }),
    onSuccess: (res: any) => {
      Alert.alert(
        'Update Sent! ⏰',
        `The group and host have been informed that you are running ~${res.runningLateMins}m late.`
      );
      queryClient.invalidateQueries({ queryKey: ['activity', activityId] });
      queryClient.invalidateQueries({ queryKey: ['chats'] });
      onClose();
    },
    onError: (e: any) =>
      Alert.alert('Could not update status', e instanceof ApiError ? e.message : 'Error sending update.'),
  });

  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <View style={{ backgroundColor: '#fff', borderTopLeftRadius: R.xl, borderTopRightRadius: R.xl, padding: 24, gap: 16 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T style={{ fontSize: 24 }}>⏰</T>
              <H1 style={{ fontSize: 20 }}>Running late?</H1>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={12}>
              <Ionicons name="close" size={24} color={C.ink} />
            </Pressable>
          </View>

          <Muted style={{ fontSize: 13 }}>
            Keep the group posted so they know to wait for you. We will announce this in the plan group chat.
          </Muted>

          <View style={{ gap: 8 }}>
            <T style={{ fontFamily: F.b, fontSize: 14 }}>About how many minutes?</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {QUICK_MINUTES.map(m => (
                <Chip
                  key={m}
                  label={`${m}m`}
                  active={mins === m}
                  onPress={() => setMins(m)}
                />
              ))}
            </View>
          </View>

          <View style={{ gap: 8 }}>
            <T style={{ fontFamily: F.b, fontSize: 14 }}>Quick reason (optional)</T>
            <Input
              value={note}
              onChangeText={setNote}
              placeholder="e.g. Traffic near metro, cab delayed..."
              maxLength={100}
            />
          </View>

          <Button
            title={`Tell the group (~${mins}m late)`}
            kind="go"
            loading={lateMutation.isPending}
            onPress={() => lateMutation.mutate()}
          />
        </View>
      </View>
    </Modal>
  );
}
