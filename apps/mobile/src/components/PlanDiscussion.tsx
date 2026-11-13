import React, { useState } from 'react';
import { Alert, FlatList, Pressable, View } from 'react-native';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, H2, Muted, Button, Input, Avatar, Pill } from './ui';
import { api, ApiError } from '../lib/api';
import { queryClient } from '../lib/query';
import { ReportButton } from './ReportButton';
import { C, F, R, flag, shadow } from '../lib/theme';

export function PlanDiscussion({ activityId, hostId, isHost }: { activityId: string; hostId: string; isHost: boolean }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<any>('/me') });
  const [text, setText] = useState('');
  const [replyingTo, setReplyingTo] = useState<{ id: string; name: string } | null>(null);

  const q = useQuery({
    queryKey: ['activity-comments', activityId],
    queryFn: () => api<any>(`/activities/${activityId}/comments`),
    enabled: !!activityId,
  });

  const postMutation = useMutation({
    mutationFn: () => api<any>(`/activities/${activityId}/comments`, {
      method: 'POST',
      body: {
        body: text.trim(),
        parentCommentId: replyingTo?.id ?? null,
      }
    }),
    onSuccess: () => {
      setText('');
      setReplyingTo(null);
      queryClient.invalidateQueries({ queryKey: ['activity-comments', activityId] });
      queryClient.invalidateQueries({ queryKey: ['activity', activityId] });
    },
    onError: (e: any) => {
      Alert.alert('Could not post question', e instanceof ApiError ? e.message : 'Please try again.');
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (commentId: string) => api<any>(`/activities/${activityId}/comments/${commentId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['activity-comments', activityId] });
      queryClient.invalidateQueries({ queryKey: ['activity', activityId] });
    }
  });

  const comments = q.data?.comments ?? [];

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <T style={{ fontSize: 18 }}>💬</T>
          <H2>Discussion & Questions ({comments.length})</H2>
        </View>
      </View>

      {/* Input box */}
      <View style={[{ backgroundColor: '#fff', borderRadius: R.lg, padding: 12, borderWidth: 1, borderColor: C.line, gap: 8 }, shadow]}>
        {replyingTo ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.primarySoft, paddingHorizontal: 10, paddingVertical: 4, borderRadius: R.sm }}>
            <T style={{ fontSize: 12, fontFamily: F.sb, color: C.primaryDark }}>Replying to {replyingTo.name}</T>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => setReplyingTo(null)} hitSlop={8}>
              <Ionicons name="close" size={16} color={C.primaryDark} />
            </Pressable>
          </View>
        ) : null}
        <Input
          value={text}
          onChangeText={setText}
          placeholder={isHost ? "Answer questions or post an update..." : "Ask the host a question before joining..."}
          maxLength={400}
        />
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
          <Button
            title={replyingTo ? "Post Reply" : "Ask Question"}
            kind="go"
            loading={postMutation.isPending}
            disabled={text.trim().length < 2}
            onPress={() => postMutation.mutate()}
            style={{ paddingHorizontal: 14, paddingVertical: 6, height: 34 }}
          />
        </View>
      </View>

      {/* Comments List */}
      {comments.length > 0 ? (
        <View style={{ gap: 8 }}>
          {comments.map((c: any) => {
            const isReply = !!c.parentCommentId;
            return (
              <View
                key={c.id}
                style={[
                  {
                    backgroundColor: c.author.isHost ? '#F8FAFC' : '#fff',
                    borderRadius: R.md,
                    padding: 12,
                    borderWidth: 1,
                    borderColor: c.author.isHost ? '#CBD5E1' : C.line,
                    marginLeft: isReply ? 20 : 0,
                    gap: 6
                  },
                  shadow
                ]}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Avatar uri={c.author.photoUrl} name={c.author.name} size={26} cc={c.author.homeCountry} />
                    <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink }}>
                      {c.author.name} {c.author.verified ? '✅' : ''} {flag(c.author.homeCountry)}
                    </T>
                    {c.author.isHost ? (
                      <View style={{ backgroundColor: '#EEF2FF', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 }}>
                        <T style={{ fontSize: 10, fontFamily: F.b, color: '#4F46E5' }}>HOST</T>
                      </View>
                    ) : null}
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Pressable
                      onPress={() => setReplyingTo({ id: c.id, name: c.author.name })}
                      hitSlop={8}
                    >
                      <T style={{ fontSize: 12, fontFamily: F.sb, color: C.primary }}>Reply</T>
                    </Pressable>
                    {c.author.id !== me.data?.id ? (
                      <ReportButton target={{ type: 'plan_comment', id: c.id, userId: c.author.id, userName: c.author.name }} size={15} />
                    ) : null}
                    {deleteMutation.isPending || !(c.author.id === me.data?.id || isHost) ? null : (
                      <Pressable accessibilityRole="button" accessibilityLabel="Delete"
                        onPress={() => {
                          Alert.alert('Delete comment?', 'This cannot be undone.', [
                            { text: 'Cancel', style: 'cancel' },
                            { text: 'Delete', style: 'destructive', onPress: () => deleteMutation.mutate(c.id) }
                          ]);
                        }}
                        hitSlop={8}
                      >
                        <Ionicons name="trash-outline" size={14} color={C.ink3} />
                      </Pressable>
                    )}
                  </View>
                </View>
                <T style={{ fontSize: 13.5, color: C.ink, lineHeight: 19 }}>{c.body}</T>
              </View>
            );
          })}
        </View>
      ) : (
        <View style={{ backgroundColor: '#fff', borderRadius: R.md, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: C.line, gap: 4 }}>
          <T style={{ fontSize: 13, color: C.ink2, textAlign: 'center' }}>
            No questions yet. Have a question about this meetup? Ask the host above!
          </T>
        </View>
      )}
    </View>
  );
}
