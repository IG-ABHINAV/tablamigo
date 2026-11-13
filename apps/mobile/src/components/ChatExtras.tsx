import React, { useState } from 'react';
import { Animated, PanResponder, Pressable, View } from 'react-native';
import { Modal } from './Modal';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { T, Muted } from './ui';
import { C, F, R } from '../lib/theme';
import { useLatest } from '../lib/useLatest';

// Same list and order as the API (routes/chats.ts REACTIONS).
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;
export type Reaction = { emoji: string; count: number; mine: boolean; users: { id: string; name: string | null }[] };
export type Quote = { id: string; senderId: string | null; senderName: string | null; kind: string; body: string; unavailable: boolean };

/** One line of text standing in for a message, for quotes and the reply bar. */
export const snippet = (q: { kind: string; body: string; unavailable?: boolean }) =>
  q.unavailable ? 'Message unavailable' : q.kind === 'image' ? '📷 Photo' : q.kind === 'location' ? '📍 Live location' : q.body;

/** Applies a 'message:reaction' event (someone's reaction is now `emoji`, or removed when null) to a message's chips. */
export function applyReaction(list: Reaction[] | null | undefined, e: { userId: string; userName: string | null; emoji: string | null }, myId?: string): Reaction[] {
  const out = (list ?? []).map(r => r.users.some(u => u.id === e.userId)
    ? { ...r, count: r.count - 1, mine: e.userId === myId ? false : r.mine, users: r.users.filter(u => u.id !== e.userId) } : r).filter(r => r.count > 0);
  if (!e.emoji) return out;
  const i = out.findIndex(r => r.emoji === e.emoji);
  const me = e.userId === myId;
  if (i < 0) return [...out, { emoji: e.emoji, count: 1, mine: me, users: [{ id: e.userId, name: e.userName }] }];
  out[i] = { ...out[i], count: out[i].count + 1, mine: out[i].mine || me, users: [...out[i].users, { id: e.userId, name: e.userName }] };
  return out;
}

/** The quoted message inside a reply bubble. Tapping it jumps to the original. */
export function ChatQuote({ q, mine, onPress }: { q: Quote; mine: boolean; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} disabled={q.unavailable || !onPress}
      style={{ flexDirection: 'row', gap: 8, borderRadius: 12, paddingVertical: 6, paddingRight: 10, marginBottom: 6, backgroundColor: mine ? 'rgba(255,255,255,0.18)' : C.bgSoft, overflow: 'hidden' }}>
      <View style={{ width: 3, borderRadius: 2, backgroundColor: mine ? '#fff' : C.primary }} />
      <View style={{ flexShrink: 1 }}>
        {q.senderName ? <T style={{ fontFamily: F.b, fontSize: 12, color: mine ? '#fff' : C.primaryDark }}>{q.senderName}</T> : null}
        <T numberOfLines={2} style={{ fontSize: 13, color: mine ? 'rgba(255,255,255,0.88)' : C.ink2, fontStyle: q.unavailable ? 'italic' : 'normal' }}>{snippet(q)}</T>
      </View>
    </Pressable>
  );
}

/** Reaction chips under a bubble: tap toggles mine, long-press shows who reacted. */
export function ChatReactions({ list, mine, onToggle, onWho }: { list: Reaction[]; mine: boolean; onToggle: (emoji: string) => void; onWho: () => void }) {
  if (!list.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, justifyContent: mine ? 'flex-end' : 'flex-start', marginTop: -4, marginBottom: 2, paddingHorizontal: 6 }}>
      {list.map(r => (
        <Pressable key={r.emoji} onPress={() => onToggle(r.emoji)} onLongPress={onWho} accessibilityLabel={`${r.emoji} ${r.count}${r.mine ? ', including you' : ''}`}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 3, height: 26, paddingHorizontal: 8, borderRadius: R.pill, backgroundColor: r.mine ? C.primarySoft : '#fff',
            borderWidth: 1.5, borderColor: r.mine ? C.primary : C.line, transform: [{ scale: pressed ? 0.94 : 1 }] })}>
          <T style={{ fontSize: 13 }}>{r.emoji}</T>
          <T style={{ fontFamily: F.b, fontSize: 12, color: r.mine ? C.primaryDark : C.ink2 }}>{r.count}</T>
        </Pressable>
      ))}
    </View>
  );
}

/** Swipe a message to the right to reply to it (PanResponder, so it works the same on the web build). */
export function SwipeToReply({ onReply, enabled, children }: { onReply: () => void; enabled: boolean; children: React.ReactNode }) {
  const [x] = useState(() => new Animated.Value(0));
  // The responder is made once, so it calls the latest onReply through a stable function (lib/useLatest.ts).
  const reply = useLatest(onReply);
  const [pan] = useState(() => {
    let fired = false;
    return PanResponder.create({
      // Capture: the bubble's Pressable owns the touch from the start (long-press), so the swipe has to claim it from above.
      onMoveShouldSetPanResponderCapture: (_, g) => g.dx > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => { fired = false; },
      onPanResponderMove: (_, g) => {
        const d = Math.max(0, Math.min(g.dx, 90));
        x.setValue(d);
        if (d >= 64 && !fired) fired = true;
      },
      onPanResponderRelease: () => {
        if (fired) reply();
        Animated.spring(x, { toValue: 0, useNativeDriver: false, bounciness: 6 }).start();
      },
      onPanResponderTerminate: () => Animated.spring(x, { toValue: 0, useNativeDriver: false }).start(),
    });
  });
  if (!enabled) return <>{children}</>;
  const iconOpacity = x.interpolate({ inputRange: [0, 64], outputRange: [0, 1], extrapolate: 'clamp' });
  return (
    <View>
      <Animated.View style={{ position: 'absolute', left: 4, top: 0, bottom: 0, justifyContent: 'center', opacity: iconOpacity }}>
        <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: C.line, alignItems: 'center', justifyContent: 'center' }}><Ionicons name="arrow-undo" size={16} color={C.ink2} /></View>
      </Animated.View>
      <Animated.View {...pan.panHandlers} style={{ transform: [{ translateX: x }] }}>{children}</Animated.View>
    </View>
  );
}

type MenuMsg = { id: string; kind: string; body: string; senderName?: string; reactions?: Reaction[] | null };

/** One line of the long-press menu. Module level: declared inside ChatMessageMenu it was a new component type on every render. */
function Row({ icon, label, danger, onPress }: { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; danger?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 4, borderRadius: R.sm, backgroundColor: pressed ? C.bgSoft : 'transparent' })}>
      <Ionicons name={icon} size={21} color={danger ? C.danger : C.ink} />
      <T style={{ fontFamily: F.sb, fontSize: 16, color: danger ? C.danger : C.ink }}>{label}</T>
    </Pressable>
  );
}

/** Long-press on a message: react with one of six emoji, see who reacted, reply, or report. */
export function ChatMessageMenu({
  msg, mine, myId, canEdit, canDelete, canPin, isPinned, onClose, onReact, onReply, onEdit, onDelete, onPin, onReport
}: {
  msg: MenuMsg | null;
  mine: boolean;
  myId?: string;
  canEdit?: boolean;
  canDelete?: boolean;
  canPin?: boolean;
  isPinned?: boolean;
  onClose: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onPin?: () => void;
  onReport?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const list = msg?.reactions ?? [];
  const myEmoji = list.find(r => r.mine)?.emoji;
  return (
    <Modal visible={!!msg} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={{ flex: 1, backgroundColor: C.overlay }} onPress={onClose} />
      {msg ? <View style={{ backgroundColor: C.bg, borderTopLeftRadius: R.xl, borderTopRightRadius: R.xl, padding: 20, paddingBottom: 20 + insets.bottom, gap: 6 }}>
        <View style={{ alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: C.line, marginBottom: 8 }} />
        <Muted numberOfLines={2} style={{ fontSize: 13, marginBottom: 6 }}>{msg.senderName && !mine ? `${msg.senderName}: ` : ''}{snippet(msg)}</Muted>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', backgroundColor: C.bgSoft, borderRadius: R.pill, padding: 6 }}>
          {REACTIONS.map(e => (
            <Pressable key={e} onPress={() => onReact(e)} accessibilityLabel={`React ${e}`}
              style={({ pressed }) => ({ width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: myEmoji === e ? C.primarySoft : 'transparent', borderWidth: myEmoji === e ? 2 : 0, borderColor: C.primary, transform: [{ scale: pressed ? 1.2 : 1 }] })}>
              <T style={{ fontSize: 26 }}>{e}</T>
            </Pressable>
          ))}
        </View>
        {list.length ? <View style={{ gap: 6, paddingVertical: 8 }}>
          {list.map(r => (
            <View key={r.emoji} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <T style={{ fontSize: 18, width: 26 }}>{r.emoji}</T>
              <T numberOfLines={2} style={{ flex: 1, fontSize: 14, color: C.ink2 }}>{r.users.map(u => u.id === myId ? 'You' : u.name ?? 'Someone').join(', ')}</T>
            </View>
          ))}
        </View> : null}
        <View style={{ height: 1, backgroundColor: C.line, marginVertical: 4 }} />
        <Row icon="arrow-undo-outline" label="Reply" onPress={onReply} />
        {canEdit && onEdit ? <Row icon="pencil-outline" label="Edit message" onPress={onEdit} /> : null}
        {canPin && onPin ? <Row icon="pin-outline" label={isPinned ? 'Unpin message' : 'Pin message'} onPress={onPin} /> : null}
        {canDelete && onDelete ? <Row icon="trash-outline" label="Delete message" danger onPress={onDelete} /> : null}
        {onReport ? <Row icon="flag-outline" label="Report" danger onPress={onReport} /> : null}
      </View> : null}
    </Modal>
  );
}

/** Above the composer while replying: who and what is being quoted, with a cancel button. */
export function ReplyBar({ q, onCancel }: { q: Quote; onCancel: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: C.line }}>
      <Ionicons name="arrow-undo" size={18} color={C.primary} />
      <View style={{ flex: 1, borderLeftWidth: 3, borderLeftColor: C.primary, paddingLeft: 8 }}>
        <T style={{ fontFamily: F.b, fontSize: 12.5, color: C.primaryDark }}>Replying to {q.senderName ?? 'message'}</T>
        <T numberOfLines={1} style={{ fontSize: 13, color: C.ink2 }}>{snippet(q)}</T>
      </View>
      <Pressable onPress={onCancel} hitSlop={10} accessibilityLabel="Cancel reply"><Ionicons name="close-circle" size={22} color={C.ink3} /></Pressable>
    </View>
  );
}
