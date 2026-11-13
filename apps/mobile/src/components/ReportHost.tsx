import React, { useState } from 'react';
import { Pressable, View, ActivityIndicator } from 'react-native';
import { Modal } from './Modal';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { T, Muted } from './ui';
import { api, ApiError } from '../lib/api';
import { REASONS, REPORT_WHAT, useReport } from '../lib/safety';
import { queryClient } from '../lib/query';
import { C, F, R } from '../lib/theme';

/** Report / block bottom sheet. Android's Alert shows at most three buttons, so this is a real sheet. */
export function ReportHost() {
  const { target, close } = useReport();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<'reported' | 'blocked' | null>(null);
  const [error, setError] = useState('');
  const insets = useSafeAreaInsets();

  const dismiss = () => { setError(''); close(); };
  const finish = () => { const wasBlock = done === 'blocked'; setDone(null); dismiss(); if (wasBlock && router.canGoBack()) router.back(); };
  // A failed report or block says so and stays open to try again; it used to close without a word.
  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : "Couldn't send that. Check your connection and try again.");
  const report = async (reason: string) => {
    if (!target) return;
    setBusy(reason); setError('');
    try { await api('/reports', { body: { targetType: target.type, targetId: target.id, reason } }); setDone('reported'); } catch (e) { fail(e); } finally { setBusy(null); }
  };
  const block = async () => {
    if (!target?.userId) return;
    setBusy('block'); setError('');
    try { await api(`/blocks/${target.userId}`, { method: 'POST' }); await queryClient.invalidateQueries(); setDone('blocked'); } catch (e) { fail(e); } finally { setBusy(null); }
  };

  return (
    <Modal visible={!!target} transparent animationType="slide" onRequestClose={done ? finish : dismiss} statusBarTranslucent>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(22,22,29,0.45)' }} onPress={done ? finish : dismiss} />
      <View style={{ backgroundColor: C.bg, borderTopLeftRadius: R.xl, borderTopRightRadius: R.xl, padding: 20, paddingBottom: 20 + insets.bottom, gap: 4 }}>
        <View style={{ alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: C.line, marginBottom: 12 }} />
        {done ? (
          <View style={{ alignItems: 'center', gap: 8, paddingVertical: 12 }}>
            <T style={{ fontSize: 40 }}>{done === 'blocked' ? '🚫' : '🙏'}</T>
            <T style={{ fontFamily: F.xb, fontSize: 20 }}>{done === 'blocked' ? `${target?.userName ?? 'They'} can't see you now` : 'Thanks for telling us'}</T>
            <Muted style={{ textAlign: 'center' }}>{done === 'blocked' ? "You won't see each other's plans, profiles or messages. They aren't notified." : 'Our team reviews every report, usually within 24 hours. They won’t know it was you.'}</Muted>
            <Pressable onPress={finish} style={{ marginTop: 12, height: 50, alignSelf: 'stretch', borderRadius: R.pill, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center' }}>
              <T style={{ color: '#fff', fontFamily: F.b }}>Done</T>
            </Pressable>
          </View>
        ) : (
          <>
            <T style={{ fontFamily: F.xb, fontSize: 20 }}>{target ? `What's wrong with ${REPORT_WHAT[target.type]}?` : "What's wrong?"}</T>
            <Muted style={{ marginBottom: 8 }}>Reports are anonymous.</Muted>
            {error ? <T style={{ color: C.danger, fontFamily: F.sb, marginBottom: 6 }}>{error}</T> : null}
            {REASONS.map(r => (
              <Pressable key={r.id} onPress={() => report(r.id)} disabled={!!busy}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 4, borderRadius: R.sm, backgroundColor: pressed ? C.bgSoft : 'transparent' })}>
                <T style={{ fontSize: 20, width: 28, textAlign: 'center' }}>{r.emoji}</T>
                <T style={{ flex: 1, fontFamily: F.sb, fontSize: 16 }}>{r.label}</T>
                {busy === r.id ? <ActivityIndicator color={C.primary} /> : null}
              </Pressable>
            ))}
            {target?.userId ? (
              <Pressable onPress={block} disabled={!!busy}
                style={{ marginTop: 10, height: 52, borderRadius: R.pill, backgroundColor: '#FDECEC', flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' }}>
                {busy === 'block' ? <ActivityIndicator color={C.danger} /> : <T style={{ color: C.danger, fontFamily: F.b, fontSize: 16 }}>Block {target.userName ?? 'this person'}</T>}
              </Pressable>
            ) : null}
          </>
        )}
      </View>
    </Modal>
  );
}
