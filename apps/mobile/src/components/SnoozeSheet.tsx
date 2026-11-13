import React, { useState } from 'react';
import { ActivityIndicator, Pressable } from 'react-native';
import { T, Muted } from './ui';
import { ModalSheet } from './ModalSheet';
import { api } from '../lib/api';
import { queryClient } from '../lib/query';
import { C, F, R } from '../lib/theme';

const OPTIONS = [
  { id: '24h', label: '24 hours', emoji: '🌙' },
  { id: '3d', label: '3 days', emoji: '🏝️' },
  { id: '1w', label: '1 week', emoji: '🧳' },
  { id: 'indefinite', label: 'Until I turn it off', emoji: '🔕' },
] as const;

export const snoozeLabel = (until?: string | null) => until
  ? new Date(until).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
  : 'you turn it off';

export function SnoozeSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const pick = async (duration: string) => {
    setBusy(duration);
    try { await api('/me/snooze', { body: { duration } }); await queryClient.invalidateQueries({ queryKey: ['me'] }); onClose(); } catch {} finally { setBusy(null); }
  };
  return (
    <ModalSheet visible={visible} onClose={onClose}>
      <T style={{ fontFamily: F.xb, fontSize: 20 }}>Snooze for how long?</T>
      <Muted style={{ marginBottom: 8 }}>You won't show up in Travelers or on the map. Your chats and plans keep working.</Muted>
      {OPTIONS.map(o => (
        <Pressable key={o.id} onPress={() => pick(o.id)} disabled={!!busy}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 4, borderRadius: R.sm, backgroundColor: pressed ? C.bgSoft : 'transparent' })}>
          <T style={{ fontSize: 20, width: 28, textAlign: 'center' }}>{o.emoji}</T>
          <T style={{ flex: 1, fontFamily: F.sb, fontSize: 16 }}>{o.label}</T>
          {busy === o.id ? <ActivityIndicator color={C.primary} /> : null}
        </Pressable>
      ))}
    </ModalSheet>
  );
}
