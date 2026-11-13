import React, { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, View } from 'react-native';
import { Modal } from './Modal';
import { useBottomInset } from '../lib/safe-edges';
import { Ionicons } from '@expo/vector-icons';
import { T, Muted, Input, Button } from './ui';
import { ApiError } from '../lib/api';
import { C, F, R } from '../lib/theme';

// The server's error message is just the code; rebuilding the ApiError picks the friendly text.
export const chatError = (e: unknown) => e instanceof ApiError ? new ApiError(e.status, e.code).message : e instanceof TypeError ? 'No connection.' : (e as Error).message;

const DURATIONS = [{ minutes: 15, label: '15 minutes' }, { minutes: 60, label: '1 hour' }, { minutes: 480, label: '8 hours' }] as const;

type Props = {
  visible: boolean; group: boolean; city?: boolean; onClose: () => void; onPhoto: () => void;
  onVoice?: () => void;
  onPoll: (question: string, options: string[]) => Promise<void>; onLocation: (minutes: number) => Promise<void>;
};

/** One tappable line of the sheet. A module-level component (it used to be declared inside ChatAttachSheet, so every render made a new component type and remounted the rows). */
function Row({ icon, label, sub, onPress, k, busy }: { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; sub?: string; onPress: () => void; k?: string; busy: string | null }) {
  return (
    <Pressable onPress={onPress} disabled={!!busy}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 4, borderRadius: R.sm, backgroundColor: pressed ? C.bgSoft : 'transparent' })}>
      <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: C.primarySoft, alignItems: 'center', justifyContent: 'center' }}><Ionicons name={icon} size={20} color={C.primaryDark} /></View>
      <View style={{ flex: 1 }}>
        <T style={{ fontFamily: F.sb, fontSize: 16 }}>{label}</T>
        {sub ? <Muted style={{ fontSize: 12.5 }}>{sub}</Muted> : null}
      </View>
      {busy && busy === k ? <ActivityIndicator color={C.primary} /> : null}
    </Pressable>
  );
}

/** "+" in the composer: photo, poll (group chats only) or live location. */
export function ChatAttachSheet({ visible, group, city, onClose, onPhoto, onVoice, onPoll, onLocation }: Props) {
  const bottomInset = useBottomInset();
  const [mode, setMode] = useState<'menu' | 'poll' | 'location'>('menu');
  const [question, setQuestion] = useState(''); const [options, setOptions] = useState(['', '']);
  const [busy, setBusy] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);

  const close = () => { if (busy) return; onClose(); setMode('menu'); setErr(null); };
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setErr(null);
    try { await fn(); setQuestion(''); setOptions(['', '']); setMode('menu'); onClose(); } catch (e) { setErr(chatError(e)); } finally { setBusy(null); }
  };
  const clean = options.map(o => o.trim()).filter(Boolean);
  const ready = !!question.trim() && clean.length >= 2 && new Set(clean.map(o => o.toLowerCase())).size === clean.length;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => (mode === 'menu' ? close() : setMode('menu'))} statusBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <Pressable style={{ flex: 1, backgroundColor: C.overlay }} onPress={close} />
        <View style={{ backgroundColor: C.bg, borderTopLeftRadius: R.xl, borderTopRightRadius: R.xl, padding: 20, paddingBottom: 20 + bottomInset, gap: 4 }}>
          <View style={{ alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: C.line, marginBottom: 12 }} />
          {mode === 'menu' ? (
            <>
              <Row busy={busy} icon="image-outline" label="Photo" onPress={() => { close(); onPhoto(); }} />
              {onVoice ? <Row busy={busy} icon="mic-outline" label="Voice note" sub="Send an audio message" onPress={() => { close(); onVoice(); }} /> : null}
              {group ? <Row busy={busy} icon="stats-chart-outline" label="Poll" sub="Let the group pick a place or a time" onPress={() => { setErr(null); setMode('poll'); }} /> : null}
              {city ? null : <Row busy={busy} icon="navigate-outline" label="Live location" sub="Share where you are for a while" onPress={() => { setErr(null); setMode('location'); }} />}
            </>
          ) : mode === 'poll' ? (
            <View style={{ gap: 12 }}>
              <T style={{ fontFamily: F.xb, fontSize: 20 }}>New poll</T>
              <Input label="Question" value={question} onChangeText={setQuestion} placeholder="Where should we meet?" maxLength={200} />
              {options.map((o, i) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{ flex: 1 }}><Input value={o} onChangeText={t => setOptions(v => v.map((x, j) => (j === i ? t : x)))} placeholder={`Option ${i + 1}`} maxLength={80} /></View>
                  {options.length > 2 ? <Pressable accessibilityRole="button" accessibilityLabel="Remove option" hitSlop={10} onPress={() => setOptions(v => v.filter((_, j) => j !== i))}><Ionicons name="close-circle" size={22} color={C.ink3} /></Pressable> : null}
                </View>
              ))}
              {options.length < 6 ? <T onPress={() => setOptions(v => [...v, ''])} style={{ fontFamily: F.b, color: C.primary }}>+ Add option</T> : null}
              {err ? <T style={{ color: C.danger, fontFamily: F.sb, fontSize: 13 }}>{err}</T> : null}
              <Button title="Post poll" disabled={!ready} loading={busy === 'poll'} onPress={() => run('poll', () => onPoll(question.trim(), clean))} />
            </View>
          ) : (
            <>
              <T style={{ fontFamily: F.xb, fontSize: 20 }}>Share live location</T>
              <Muted style={{ marginBottom: 4, lineHeight: 20 }}>
                {group ? 'Everyone in this chat' : 'The person you are chatting with'} sees your exact position on a map until you stop or the time you pick runs out. It updates every 30 seconds while this chat is open on your phone. The last position you shared stays visible in this chat afterwards.
              </Muted>
              <Muted style={{ marginBottom: 8, lineHeight: 20 }}>Tap Stop sharing on your location card to end it sooner.</Muted>
              {DURATIONS.map(d => <Row busy={busy} key={d.minutes} k={String(d.minutes)} icon="time-outline" label={d.label} onPress={() => run(String(d.minutes), () => onLocation(d.minutes))} />)}
              {err ? <T style={{ color: C.danger, fontFamily: F.sb, fontSize: 13, marginTop: 6 }}>{err}</T> : null}
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
