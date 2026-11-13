import React, { useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Pressable, TextInput, View } from 'react-native';
import { Modal } from './Modal';
import { useBottomInset } from '../lib/safe-edges';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, Muted, Avatar, Empty } from './ui';
import { api } from '../lib/api';
import { ReportButton } from './ReportButton';
import { queryClient } from '../lib/query';
import { C, F, R } from '../lib/theme';

type Props = {
  momentId: string | null;
  onClose: () => void;
};

export function MomentCommentsSheet({ momentId, onClose }: Props) {
  const bottomInset = useBottomInset();
  const [text, setText] = useState('');
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me') });

  const q = useQuery({
    queryKey: ['moment-comments', momentId],
    queryFn: () => api(`/moments/${momentId}/comments`),
    enabled: !!momentId,
  });

  const send = useMutation({
    mutationFn: () => api(`/moments/${momentId}/comments`, { method: 'POST', body: { body: text.trim() } }),
    onSuccess: () => {
      setText('');
      queryClient.invalidateQueries({ queryKey: ['moment-comments', momentId] });
      queryClient.invalidateQueries({ queryKey: ['moments'] });
    },
  });

  if (!momentId) return null;

  return (
    <Modal visible={!!momentId} transparent animationType="slide" onRequestClose={onClose}>
      {/* padding on Android too: with edge-to-edge the window no longer resizes for the keyboard, so undefined left the composer under it. */}
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <Pressable style={{ flex: 1, backgroundColor: C.overlay }} onPress={onClose} />
        <View style={{ backgroundColor: '#fff', borderTopLeftRadius: R.xl, borderTopRightRadius: R.xl, maxHeight: '80%', minHeight: 340, paddingBottom: bottomInset + 8 }}>
          <View style={{ alignItems: 'center', paddingVertical: 12 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: C.line }} />
            <T style={{ fontFamily: F.b, fontSize: 16, marginTop: 8 }}>Comments</T>
          </View>

          {q.isLoading ? (
            <ActivityIndicator style={{ paddingVertical: 40 }} color={C.primary} />
          ) : (
            <FlatList
              data={q.data?.comments ?? []}
              keyExtractor={(item: any) => item.id}
              contentContainerStyle={{ paddingHorizontal: 16, gap: 14, paddingBottom: 16 }}
              ListEmptyComponent={<Empty emoji="💬" title="No comments yet" body="Be the first traveler to say something!" />}
              renderItem={({ item }) => (
                <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                  <Avatar uri={item.userPhoto} name={item.userName} size={36} />
                  <View style={{ flex: 1, backgroundColor: C.bgSoft, padding: 10, borderRadius: R.md }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <T style={{ fontFamily: F.b, fontSize: 13 }}>{item.userName}</T>
                      {item.userVerified ? <T style={{ fontSize: 11 }}>✅</T> : null}
                      <Muted style={{ fontSize: 11, marginLeft: 'auto' }}>
                        {new Date(item.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                      </Muted>
                      {item.userId !== me.data?.id ? <View style={{ marginLeft: 8 }}><ReportButton target={{ type: 'moment_comment', id: item.id, userId: item.userId, userName: item.userName }} before={onClose} /></View> : null}
                    </View>
                    <T style={{ fontSize: 13.5, color: C.ink, marginTop: 3, lineHeight: 18 }}>{item.body}</T>
                  </View>
                </View>
              )}
            />
          )}

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.line }}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Add a comment..."
              placeholderTextColor={C.ink3}
              style={{ flex: 1, backgroundColor: C.bgSoft, borderRadius: R.pill, paddingHorizontal: 16, paddingVertical: 9, fontSize: 14, color: C.ink, fontFamily: F.r }}
              maxLength={500}
            />
            <Pressable accessibilityRole="button" accessibilityLabel="Send comment"
              onPress={() => text.trim() && send.mutate()}
              disabled={!text.trim() || send.isPending}
              style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: text.trim() ? C.primary : C.bgSoft, alignItems: 'center', justifyContent: 'center' }}
            >
              {send.isPending ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="arrow-up" size={20} color={text.trim() ? '#fff' : C.ink3} />}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
