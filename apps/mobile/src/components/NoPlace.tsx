import React from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { T, Muted, Button, Empty } from './ui';
import { useLocation } from '../lib/location';
import type { Here } from '../lib/where';
import { C, F, R, shadow } from '../lib/theme';

/** Asks for the location again; when Android won't ask any more, offers Settings (same as the map's locate button). */
export async function askForLocation() {
  await useLocation.getState().locate();
  if (useLocation.getState().blocked) Alert.alert('Location is off for Tablamigo', 'Allow location in Settings to see plans and travelers near you.', [
    { text: 'Not now', style: 'cancel' }, { text: 'Open Settings', onPress: () => { Linking.openSettings().catch(() => {}); } }]);
}

/**
 * What a screen shows when it doesn't know where the person is (lib/useHere.ts returned null): still waiting for the phone, or
 * nothing at all to go on. Never a made-up city.
 */
export function NoPlace({ settled }: { settled: boolean }) {
  if (!settled) return <View style={{ paddingVertical: 48, alignItems: 'center', gap: 12 }}>
    <ActivityIndicator color={C.primary} />
    <Muted>Finding where you are…</Muted>
    <Pressable onPress={() => router.push('/pick-city')} hitSlop={10}><T style={{ color: C.primaryDark, fontFamily: F.b }}>Pick a city instead</T></Pressable>
  </View>;
  return <Empty emoji="📍" title="Where are you?" body="Turn on location to see plans and travelers around you, or pick a city to look around."
    action={<View style={{ gap: 10, alignSelf: 'stretch', marginTop: 12 }}>
      <Button title="Use my location" onPress={askForLocation} />
      <Button title="Pick a city" kind="soft" onPress={() => router.push('/pick-city')} />
    </View>} />;
}

/** A thin line saying which place is shown when it isn't the phone's own fix, with a way to change it. */
export function PlaceNote({ here, style }: { here: Here | null; style?: object }) {
  if (!here || here.source === 'device') return null;
  const what = here.source === 'picked' ? `Showing ${here.city ?? 'the city you picked'}`
    : here.source === 'saved' ? `Showing ${here.city ?? 'where you were last'} (your last location)`
    : `Showing ${here.city} (your home country)`;
  return <View style={[{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, backgroundColor: '#fff', borderRadius: R.pill, paddingHorizontal: 14, paddingVertical: 8 }, shadow, style]}>
    <T style={{ fontSize: 13, color: C.ink2, flexShrink: 1 }}>📍 {what}</T>
    <Pressable onPress={askForLocation} hitSlop={8}><T style={{ fontSize: 13, color: C.primaryDark, fontFamily: F.b }}>Use my location</T></Pressable>
    <Pressable onPress={() => router.push('/pick-city')} hitSlop={8}><T style={{ fontSize: 13, color: C.primaryDark, fontFamily: F.b }}>Change</T></Pressable>
  </View>;
}
