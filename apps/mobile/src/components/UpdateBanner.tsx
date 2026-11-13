import React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { T } from './ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, F, R, tabBarHeight } from '../lib/theme';
import { dismissUpdateBanner, installUpdate, useUpdateBanner } from '../lib/update-prompt';

/**
 * Shown once Google Play has downloaded a new version in the background (lib/update-runner.ts decides when). Restarting is
 * the person's choice and their moment: nothing here blocks the app, and closing it only hides it until the next app start.
 * On the web this never appears (lib/update-prompt.web.ts holds no version).
 */
export function UpdateBanner() {
  const versionCode = useUpdateBanner(s => s.versionCode);
  // Above the tab bar, whose height grows with Android's navigation bar (3-button nav: 72 + 48); a fixed 96 sat on it.
  const bottom = tabBarHeight(useSafeAreaInsets().bottom) + 12;
  const [busy, setBusy] = React.useState(false);
  if (versionCode === null) return null;
  const restart = () => {
    if (busy) return;
    setBusy(true);
    // Play restarts the app on success; on failure the banner clears itself (lib/update-runner.ts install()).
    void installUpdate().finally(() => setBusy(false));
  };
  return (
    // Above the chat composer and the tab bar, so it covers nothing anyone needs.
    <View pointerEvents="box-none" style={{ position: 'absolute', bottom, left: 0, right: 0, alignItems: 'center', paddingHorizontal: 16 }}>
      <View role="region" aria-label="Update ready" testID="update-banner"
        style={{ width: '100%', maxWidth: 420, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingLeft: 16, paddingRight: 8,
          borderRadius: R.lg, backgroundColor: C.card, borderWidth: 1, borderColor: C.line,
          shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } }}>
        <View style={{ flex: 1 }}>
          <T style={{ fontFamily: F.b, fontSize: 15 }}>Update ready</T>
          <T style={{ fontFamily: F.r, fontSize: 13, color: C.ink2, marginTop: 2 }}>Restart Tablamigo to finish installing it.</T>
        </View>
        <Pressable onPress={restart} disabled={busy} role="button" accessibilityLabel="Restart to update" hitSlop={8}
          style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: R.md, backgroundColor: busy ? C.line : C.primary }}>
          <T style={{ fontFamily: F.sb, fontSize: 14, color: busy ? C.ink3 : '#fff' }}>Restart</T>
        </Pressable>
        <Pressable onPress={dismissUpdateBanner} role="button" accessibilityLabel="Not now" hitSlop={8}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="close" size={20} color={C.ink3} />
        </Pressable>
      </View>
    </View>
  );
}
