import React from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle, type TextStyle } from 'react-native';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { C, F, R, flag } from '../lib/theme';
import { webTapBox } from '../lib/tap-target';

export const T = ({ style, ...p }: React.ComponentProps<typeof Text>) => <Text {...p} style={[{ fontFamily: F.r, color: C.ink, fontSize: 15 }, style]} />;
export const H1 = (p: React.ComponentProps<typeof Text>) => <T {...p} style={[{ fontFamily: F.xb, fontSize: 30, letterSpacing: -0.6, lineHeight: 36 }, p.style]} />;
export const H2 = (p: React.ComponentProps<typeof Text>) => <T {...p} style={[{ fontFamily: F.b, fontSize: 20, letterSpacing: -0.3 }, p.style]} />;
export const Muted = (p: React.ComponentProps<typeof Text>) => <T {...p} style={[{ color: C.ink2, fontSize: 14 }, p.style]} />;

const initials = (n?: string | null) => (n ?? '?').split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
const tint = (s: string) => ['#FFD5DC', '#C0AEDE', '#D1D4F9', '#B6E3F4', '#FFDFBF', '#C9F2E4'][[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 6];

export function Avatar({ uri, name, size = 40, ring, cc }: { uri?: string | null; name?: string | null; size?: number; ring?: boolean; cc?: string | null }) {
  return (
    <View style={{ width: size, height: size }}>
      <View style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden', backgroundColor: tint(name ?? '?'), alignItems: 'center', justifyContent: 'center', borderWidth: ring ? 2.5 : 0, borderColor: '#fff' }}>
        {uri ? <Image source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" transition={150} />
             : <T style={{ fontFamily: F.b, fontSize: size * 0.38, color: C.ink }}>{initials(name)}</T>}
      </View>
      {cc ? <T style={{ position: 'absolute', right: -3, bottom: -3, fontSize: size * 0.36 }}>{flag(cc)}</T> : null}
    </View>
  );
}

export function AvatarStack({ people, size = 28, max = 4, extra = 0 }: { people: { id: string; name?: string | null; photoUrl?: string | null }[]; size?: number; max?: number; extra?: number }) {
  const shown = people.slice(0, max);
  const more = extra || Math.max(0, people.length - max);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {shown.map((p, i) => <View key={p.id} style={{ marginLeft: i ? -size * 0.32 : 0, zIndex: 10 - i }}><Avatar uri={p.photoUrl} name={p.name} size={size} ring /></View>)}
      {more > 0 ? <View style={{ marginLeft: -size * 0.32, height: size, minWidth: size, paddingHorizontal: 6, borderRadius: size / 2, backgroundColor: C.ink, borderWidth: 2.5, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' }}>
        <T style={{ color: '#fff', fontFamily: F.b, fontSize: size * 0.36 }}>+{more}</T></View> : null}
    </View>
  );
}

export function Button({ title, onPress, kind = 'primary', loading, disabled, icon, style }: { title: string; onPress?: () => void; kind?: 'primary' | 'dark' | 'ghost' | 'soft' | 'go' | 'women'; loading?: boolean; disabled?: boolean; icon?: React.ReactNode; style?: ViewStyle }) {
  const bg = { primary: C.primary, dark: C.ink, ghost: 'transparent', soft: C.primarySoft, go: C.go, women: C.womenSoft }[kind];
  const fg = { primary: '#fff', dark: '#fff', ghost: C.ink, soft: C.primaryDark, go: '#fff', women: C.women }[kind];
  // A height passed in is a minimum, not a cap, so a larger system font grows the button instead of clipping its label
  // (compact buttons pass 32-38). Under 44 the touch area is extended to 44 with hitSlop.
  const { height: asked, ...rest } = (StyleSheet.flatten(style) ?? {}) as ViewStyle;
  const minHeight = typeof asked === 'number' ? asked : 54;
  const slop = Math.max(0, Math.ceil((44 - minHeight) / 2));
  return (
    <Pressable disabled={disabled || loading} onPress={() => { Haptics.selectionAsync().catch(() => {}); onPress?.(); }}
      accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      hitSlop={slop ? { top: slop, bottom: slop } : undefined}
      // Side padding so a button sized by its content (an empty state's action) never has its label touching its edges.
      style={({ pressed }) => [{ minHeight, paddingHorizontal: minHeight < 54 ? 12 : 24, borderRadius: R.pill, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8,
        opacity: disabled ? 0.45 : 1, transform: [{ scale: pressed ? 0.98 : 1 }], borderWidth: kind === 'ghost' ? 1.5 : 0, borderColor: C.line }, rest]}>
      {loading ? <ActivityIndicator color={fg} /> : <>{icon}<T style={{ color: fg, fontFamily: F.b, fontSize: 16, textAlign: 'center', flexShrink: 1 }}>{title}</T></>}
    </Pressable>
  );
}

export function Chip({ label, emoji, active, onPress, style }: { label: string; emoji?: string; active?: boolean; onPress?: () => void; style?: ViewStyle }) {
  return (
    <Pressable onPress={() => { Haptics.selectionAsync().catch(() => {}); onPress?.(); }}
      style={[{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 38, borderRadius: R.pill, backgroundColor: active ? C.ink : '#fff', borderWidth: 1, borderColor: active ? C.ink : C.line }, style]}>
      {emoji ? <T style={{ fontSize: 15 }}>{emoji}</T> : null}
      <T style={{ fontFamily: F.sb, fontSize: 14, color: active ? '#fff' : C.ink }}>{label}</T>
    </Pressable>
  );
}

// `ref` is an ordinary prop in React 19 and reaches the TextInput through the spread (the birthday boxes focus the next one).
export function Input({ label, style, ...p }: TextInputProps & { label?: string; ref?: React.Ref<TextInput> }) {
  return (
    <View style={{ gap: 8 }}>
      {label ? <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink2 }}>{label}</T> : null}
      <TextInput placeholderTextColor={C.ink3} {...p}
        style={[{ height: p.multiline ? 110 : 54, borderRadius: R.md, backgroundColor: C.bgSoft, paddingHorizontal: 16, paddingTop: p.multiline ? 14 : 0, fontFamily: F.m, fontSize: 16, color: C.ink, textAlignVertical: p.multiline ? 'top' : 'center' } as TextStyle, style]} />
    </View>
  );
}

export const Pill = ({ children, bg = C.primarySoft, fg = C.primaryDark }: { children: React.ReactNode; bg?: string; fg?: string }) => (
  <View style={{ alignSelf: 'flex-start', backgroundColor: bg, borderRadius: R.pill, paddingHorizontal: 10, paddingVertical: 4 }}>
    <T style={{ color: fg, fontFamily: F.b, fontSize: 12 }}>{children}</T>
  </View>
);

/** Small "Plus" tag next to a name in Travelers lists: Plus members are ranked first, and this says why. */
export const PlusBadge = () => (
  <Text style={{ fontFamily: F.b, fontSize: 10.5, color: C.primaryDark, backgroundColor: C.primarySoft, borderRadius: R.pill, paddingHorizontal: 7, paddingVertical: 1, overflow: 'hidden' }}>PLUS</Text>
);

export function Empty({ emoji, title, body, action }: { emoji: string; title: string; body?: string; action?: React.ReactNode }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 48, paddingHorizontal: 32, gap: 10 }}>
      <T style={{ fontSize: 48 }}>{emoji}</T>
      <H2 style={{ textAlign: 'center' }}>{title}</H2>
      {body ? <Muted style={{ textAlign: 'center', lineHeight: 20 }}>{body}</Muted> : null}
      {action}
    </View>
  );
}
/**
 * A header icon button (back, close, more). Phones: the icon with a 12pt hitSlop, as these buttons always were. Web:
 * react-native-web ignores hitSlop, so a bare 28pt icon was the whole tap target; there it gets a real 44pt box, with negative
 * margins so the icon sits where it would otherwise and the header keeps its height.
 */
export function IconButton({ name, label, onPress, size = 28, color = C.ink, edge = 'left', pad = 0, style }: { name: React.ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void; size?: number; color?: string; edge?: 'left' | 'right' | 'none'; pad?: number; style?: ViewStyle }) {
  // pad: padding the icon had around it (footprint size + 2 * pad). Phones keep it and use hitSlop; the web gets a 44pt box.
  const box: ViewStyle | null = Platform.OS === 'web' ? webTapBox(size, pad, edge) : pad ? { padding: pad } : null;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={12} style={[box, style]}>
      <Ionicons name={name} size={size} color={color} />
    </Pressable>
  );
}

/** Back in the header: router.back(), or the given screen when there is nothing to go back to (opened from a link). */
export function BackButton({ fallback, onPress, style }: { fallback?: Parameters<typeof router.replace>[0]; onPress?: () => void; style?: ViewStyle }) {
  return <IconButton name="chevron-back" label="Back" style={style}
    onPress={onPress ?? (() => (router.canGoBack() || !fallback ? router.back() : router.replace(fallback)))} />;
}

export const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center' } });
