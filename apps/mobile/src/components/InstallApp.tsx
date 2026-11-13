import React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { T, Muted } from './ui';
import { useInstall } from '../lib/pwa';
import { C, F, R } from '../lib/theme';

/** Web only: "Install app" where the browser offers it, or the iOS Add to Home Screen hint. Renders nothing natively. */
export function InstallApp() {
  const { canInstall, iosHint, install, dismissHint } = useInstall();
  if (!canInstall && !iosHint) return null;
  return (
    <View style={{ marginHorizontal: 16, marginBottom: 12, padding: 14, borderRadius: R.lg, backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: C.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={canInstall ? 'download-outline' : 'share-outline'} size={20} color={C.primaryDark} />
      </View>
      <View style={{ flex: 1 }}>
        <T style={{ fontFamily: F.b }}>{canInstall ? 'Install the app' : 'Add Tablamigo to your Home Screen'}</T>
        <Muted style={{ fontSize: 13 }}>{canInstall ? 'Opens like an app, straight from your home screen' : 'Tap Share → Add to Home Screen'}</Muted>
      </View>
      {canInstall
        ? <Pressable onPress={install} style={{ height: 38, paddingHorizontal: 16, borderRadius: R.pill, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' }}>
            <T style={{ color: '#fff', fontFamily: F.b, fontSize: 14 }}>Install</T>
          </Pressable>
        : <Pressable onPress={dismissHint} hitSlop={10} accessibilityLabel="Dismiss"><Ionicons name="close" size={20} color={C.ink3} /></Pressable>}
    </View>
  );
}
