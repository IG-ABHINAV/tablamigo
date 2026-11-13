import React, { useEffect, useRef, useState } from 'react';
import { FlatList, Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Modal } from './Modal';
import { T, Avatar } from './ui';
import { when } from './format';
import { F, R, flag } from '../lib/theme';
import {
  type ViewerPhoto, MIN_ZOOM, MAX_ZOOM, DOUBLE_TAP_ZOOM, clampZoom, stepIndex, pageAt, viewerKey, panBounds, fitted, tapOutside, placeRoute,
} from '../lib/photo-viewer';

/**
 * Full-screen photo viewer for every tappable photo in the app (rules in lib/photo-viewer.ts). Swipe or the arrows (and
 * the arrow keys on the web) move between photos; pinch or double tap zooms and a zoomed photo can be dragged; Android
 * back, Escape, the close button or a tap on the dark area around the photo close it. The author and the place open
 * their profile and city page. `footer` and `actions` add per-screen extras (a plan photo's reactions, delete).
 */
export function PhotoViewer({ photos, index, onClose, onIndexChange, footer, actions, links = true }: {
  photos: ViewerPhoto[];
  /** The photo to open on; null keeps the viewer closed. */
  index: number | null;
  onClose: () => void;
  onIndexChange?: (i: number) => void;
  footer?: (p: ViewerPhoto, i: number) => React.ReactNode;
  actions?: (p: ViewerPhoto, i: number) => React.ReactNode;
  /** False for someone signed out: the profile and city pages need an account. */
  links?: boolean;
}) {
  const open = index !== null && photos.length > 0;
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {open ? <Viewer photos={photos} start={stepIndex(index, 0, photos.length)} onClose={onClose} onIndexChange={onIndexChange} footer={footer} actions={actions} links={links} /> : null}
    </Modal>
  );
}

function Viewer({ photos, start, onClose, onIndexChange, footer, actions, links }: {
  photos: ViewerPhoto[]; start: number; links: boolean; onClose: () => void; onIndexChange?: (i: number) => void;
  footer?: (p: ViewerPhoto, i: number) => React.ReactNode; actions?: (p: ViewerPhoto, i: number) => React.ReactNode;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const list = useRef<FlatList<ViewerPhoto>>(null);
  const [i, setI] = useState(start);
  const [zoomed, setZoomed] = useState(false);
  const p = photos[Math.min(i, photos.length - 1)];

  // While an arrow or key scroll is under way, the scroll events in between still round to the old page; they are ignored
  // until the list reaches the page asked for, so the counter doesn't flick back.
  const target = useRef<number | null>(null);
  const settleAt = (x: number) => {
    const n = pageAt(x, width, photos.length);
    if (target.current !== null) { if (n !== target.current) return; target.current = null; }
    if (n !== i) { setI(n); setZoomed(false); onIndexChange?.(n); }
  };
  const go = (next: number) => {
    const n = stepIndex(next, 0, photos.length);
    if (n === i) return;
    target.current = n;
    list.current?.scrollToIndex({ index: n, animated: true });
    setI(n); setZoomed(false); onIndexChange?.(n);
  };
  // A new window width (rotation, a resized browser) moves the pages; keep the same photo in view.
  useEffect(() => { list.current?.scrollToIndex({ index: i, animated: false }); }, [width]); // eslint-disable-line react-hooks/exhaustive-deps
  const openRoute = (path: string) => { onClose(); router.push(path as any); };

  // The web: Escape closes, the arrow keys move.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      const k = viewerKey(e.key);
      if (k === null) return;
      e.preventDefault();
      if (k === 'close') onClose(); else go(i + k);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const place = links ? placeRoute(p?.place, p?.placeCountry) : null;
  const many = photos.length > 1;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#08080C' }}>
      <FlatList
        ref={list}
        data={photos}
        horizontal
        pagingEnabled
        scrollEnabled={!zoomed && many}
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={start}
        getItemLayout={(_, k) => ({ length: width, offset: width * k, index: k })}
        keyExtractor={(x, k) => x.id ?? `${k}:${x.url}`}
        onMomentumScrollEnd={e => settleAt(e.nativeEvent.contentOffset.x)}
        // The web has no momentum end event for a snapped scroll; this keeps the index right there.
        onScroll={Platform.OS === 'web' ? e => settleAt(e.nativeEvent.contentOffset.x) : undefined}
        scrollEventThrottle={64}
        renderItem={({ item, index: k }) => (
          <Zoomable uri={item.url} width={width} height={height} active={k === i} zoomed={k === i && zoomed} onZoom={setZoomed} onBackdrop={onClose} label={item.caption || item.authorName || 'Photo'} />
        )}
      />

      {/* Top bar: who posted it, where, when; then any screen actions and close. */}
      <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, paddingTop: Math.max(insets.top, 12) + 6, paddingHorizontal: 14, paddingBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(0,0,0,0.35)' }}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {p?.authorName ? (
            <Pressable accessibilityRole="link" accessibilityLabel={`Open ${p.authorName}'s profile`} disabled={!links || !p.authorId}
              onPress={() => links && p.authorId && openRoute(`/user/${p.authorId}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 }}>
              <Avatar uri={p.authorPhoto} name={p.authorName} size={36} />
              <View style={{ flexShrink: 1 }}>
                <T numberOfLines={1} style={{ color: '#fff', fontFamily: F.b, fontSize: 15 }}>{p.authorName}{p.authorCountry ? ` ${flag(p.authorCountry)}` : ''}</T>
                {p.at && !p.place ? <T style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>{when(p.at)}</T> : null}
              </View>
            </Pressable>
          ) : null}
          {p?.place ? (
            <Pressable accessibilityRole="link" accessibilityLabel={`Open ${p.place}`} disabled={!place} onPress={() => place && openRoute(place)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: R.pill, backgroundColor: 'rgba(255,255,255,0.14)', flexShrink: 1 }}>
              <T numberOfLines={1} style={{ color: '#fff', fontSize: 12.5, fontFamily: F.sb }}>📍 {p.place}</T>
            </Pressable>
          ) : null}
        </View>
        {many ? <T style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, fontFamily: F.sb }}>{i + 1} / {photos.length}</T> : null}
        {p && actions ? actions(p, i) : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Close photo" onPress={onClose} hitSlop={12}
          style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="close" size={24} color="#fff" />
        </Pressable>
      </View>

      {/* Arrows: a mouse can't swipe. On a phone they stay out of the way of the photo. */}
      {many && i > 0 ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Previous photo" onPress={() => go(i - 1)} hitSlop={8}
          style={{ position: 'absolute', left: 10, top: height / 2 - 22, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="chevron-back" size={26} color="#fff" />
        </Pressable>
      ) : null}
      {many && i < photos.length - 1 ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Next photo" onPress={() => go(i + 1)} hitSlop={8}
          style={{ position: 'absolute', right: 10, top: height / 2 - 22, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="chevron-forward" size={26} color="#fff" />
        </Pressable>
      ) : null}

      {/* Caption and any per-screen footer. */}
      {p && (p.caption || footer) ? (
        <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 18, paddingTop: 14, paddingBottom: Math.max(insets.bottom, 12) + 10, gap: 12, backgroundColor: 'rgba(0,0,0,0.55)' }}>
          {p.caption ? <T numberOfLines={6} style={{ color: '#fff', fontSize: 14.5, lineHeight: 21 }}>{p.caption}</T> : null}
          {footer ? footer(p, i) : null}
        </View>
      ) : null}
    </GestureHandlerRootView>
  );
}

/** One page: the photo fitted to the screen, pinch or double tap to zoom, drag while zoomed, a tap beside the photo closes. */
function Zoomable({ uri, width, height, active, zoomed, onZoom, onBackdrop, label }: {
  uri: string; width: number; height: number; active: boolean; zoomed: boolean; onZoom: (z: boolean) => void; onBackdrop: () => void; label: string;
}) {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const box = { width, height };
  const shown = fitted(natural, box);
  const scale = useSharedValue(1), saved = useSharedValue(1);
  const x = useSharedValue(0), y = useSharedValue(0), sx = useSharedValue(0), sy = useSharedValue(0);
  const report = (z: boolean) => onZoom(z);

  // Back to fit when this page is swiped away.
  useEffect(() => {
    if (active) return;
    scale.set(1); saved.set(1); x.set(0); y.set(0); sx.set(0); sy.set(0);
  }, [active, scale, saved, x, y, sx, sy]);

  const settle = () => {
    'worklet';
    const s = scale.get();
    if (s <= MIN_ZOOM + 0.01) {
      scale.set(withTiming(1)); saved.set(1); x.set(withTiming(0)); y.set(withTiming(0)); sx.set(0); sy.set(0);
      scheduleOnRN(report, false);
      return;
    }
    const b = panBounds(s, shown, box);
    const cx = Math.min(b.x, Math.max(-b.x, x.get())), cy = Math.min(b.y, Math.max(-b.y, y.get()));
    x.set(withTiming(cx)); y.set(withTiming(cy)); sx.set(cx); sy.set(cy); saved.set(s);
    scheduleOnRN(report, true);
  };

  const pinch = Gesture.Pinch()
    .onUpdate(e => { scale.set(Math.min(MAX_ZOOM * 1.2, Math.max(MIN_ZOOM * 0.8, saved.get() * e.scale))); })
    .onEnd(() => { scale.set(clampZoom(scale.get())); settle(); });
  const pan = Gesture.Pan()
    .enabled(zoomed)
    .onUpdate(e => { x.set(sx.get() + e.translationX); y.set(sy.get() + e.translationY); })
    .onEnd(() => { settle(); });
  const doubleTap = Gesture.Tap().numberOfTaps(2).onEnd(() => {
    if (saved.get() > MIN_ZOOM + 0.01) { scale.set(1); }
    else { scale.set(DOUBLE_TAP_ZOOM); }
    settle();
  });
  const tap = Gesture.Tap().numberOfTaps(1).onEnd(e => {
    if (saved.get() <= MIN_ZOOM + 0.01 && tapOutside(e.x, e.y, shown, box)) scheduleOnRN(onBackdrop);
  });
  const gesture = Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(doubleTap, tap));

  const st = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }, { translateY: y.get() }, { scale: scale.get() }] }));

  return (
    <GestureDetector gesture={gesture}>
      <View style={{ width, height, alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent' }} collapsable={false}>
        <Animated.View style={[{ width: shown.width, height: shown.height }, st]}>
          <Image source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="contain" transition={150}
            accessibilityLabel={label}
            onLoad={e => { const s = e.source; if (s?.width && s?.height) setNatural({ width: s.width, height: s.height }); }} />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

