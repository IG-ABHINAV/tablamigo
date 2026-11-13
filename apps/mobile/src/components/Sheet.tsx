import React, { useEffect } from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, withSpring, clamp } from 'react-native-reanimated';
import { C, R, shadow } from '../lib/theme';
import { sheetSnaps, sheetHiddenBelow, SHEET_FULL } from '../lib/sheet-snaps';

/** What the fully open sheet keeps below the screen, for the current window: a list's bottom padding. */
export const useSheetHiddenBelow = () => sheetHiddenBelow(useWindowDimensions().height);

/**
 * A bottom sheet that snaps between a peek, half and full height. The snaps follow the window's height as it is now, not
 * as it was when the app started: Android changes it without restarting the app (display size, font size, split screen,
 * a foldable opening), and a height read once at start left the sheet mostly off screen after such a change (QA 1 Nov 2026).
 */
export function Sheet({ children, peek = 170, half = 0.5, full = SHEET_FULL, header }: { children: React.ReactNode; peek?: number; half?: number; full?: number; header?: React.ReactNode }) {
  const H = useWindowDimensions().height;
  const snaps = sheetSnaps(H, { peek, half, full });
  const y = useSharedValue(snaps[1]);
  const start = useSharedValue(0);
  // .get() and .set() instead of .value: the same thing in Reanimated, and the form that React Compiler allows (it refuses writes to a hook's return value).
  // Back to the half snap on start and, in the app, whenever the window's height changes. Not on the web: a phone browser
  // changes the height whenever its address bar slides away, and the sheet would jump back mid-scroll.
  useEffect(() => { y.set(withSpring(snaps[1], { damping: 20 })); }, [Platform.OS === 'web' ? 0 : H]);
  const pan = Gesture.Pan()
    .onBegin(() => { start.set(y.get()); })
    .onUpdate(e => { y.set(clamp(start.get() + e.translationY, snaps[2], snaps[0])); })
    .onEnd(e => {
      const target = y.get() + e.velocityY * 0.12;
      let best = snaps[0];
      for (const s of snaps) if (Math.abs(s - target) < Math.abs(best - target)) best = s;
      y.set(withSpring(best, { damping: 22, stiffness: 180 }));
    });
  const st = useAnimatedStyle(() => ({ transform: [{ translateY: y.get() }] }));
  return (
    <Animated.View style={[{ position: 'absolute', left: 0, right: 0, top: 0, height: H, backgroundColor: C.bg, borderTopLeftRadius: R.xl, borderTopRightRadius: R.xl }, shadow, st]}>
      <GestureDetector gesture={pan}>
        <View style={{ paddingTop: 10, paddingBottom: 6 }}>
          <View style={{ alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: C.line }} />
          {header}
        </View>
      </GestureDetector>
      <View style={{ flex: 1 }}>{children}</View>
    </Animated.View>
  );
}
