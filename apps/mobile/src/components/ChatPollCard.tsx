import React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { T, Muted } from './ui';
import { C, F, R } from '../lib/theme';

export type Poll = { question: string; options: string[]; counts: number[]; myVote: number | null };

export function ChatPollCard({ poll, onVote }: { poll: Poll; onVote: (option: number) => void }) {
  const total = poll.counts.reduce((a, b) => a + b, 0);
  return (
    <View style={{ width: 252, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Ionicons name="stats-chart" size={13} color={C.primary} />
        <T style={{ fontFamily: F.b, fontSize: 12, color: C.primaryDark }}>Poll</T>
      </View>
      <T style={{ fontFamily: F.b, fontSize: 16, lineHeight: 21 }}>{poll.question}</T>
      {poll.options.map((o, i) => {
        const n = poll.counts[i] ?? 0; const mine = poll.myVote === i;
        return (
          <Pressable key={i} onPress={() => { if (mine) return; Haptics.selectionAsync().catch(() => {}); onVote(i); }}
            style={({ pressed }) => ({ borderRadius: R.sm, borderWidth: 1.5, borderColor: mine ? C.primary : C.line, overflow: 'hidden', opacity: pressed ? 0.8 : 1 })}>
            <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${total ? (n / total) * 100 : 0}%` as const, backgroundColor: mine ? C.primarySoft : C.bgSoft }} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10 }}>
              <Ionicons name={mine ? 'checkmark-circle' : 'ellipse-outline'} size={18} color={mine ? C.primary : C.ink3} />
              <T style={{ flex: 1, fontFamily: mine ? F.b : F.m, fontSize: 14.5 }}>{o}</T>
              <T style={{ fontFamily: F.b, fontSize: 13, color: mine ? C.primaryDark : C.ink2 }}>{n}</T>
            </View>
          </Pressable>
        );
      })}
      <Muted style={{ fontSize: 12 }}>{total} {total === 1 ? 'vote' : 'votes'} · {poll.myVote == null ? 'Tap to vote' : 'Tap another to change'}</Muted>
    </View>
  );
}
