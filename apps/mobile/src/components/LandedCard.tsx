import React, { useEffect, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import { T, Muted, Button } from './ui';
import { api } from '../lib/api';
import { landedTrip, localDay } from '../lib/arrivals';
import { C, F, R, flag } from '../lib/theme';

const KEY = 'tablamigo.landed.dismissed';
// The trips whose card was closed, so it never comes back for that trip. The web keeps it in localStorage.
const load = async (): Promise<string[]> => {
  try {
    const raw = Platform.OS === 'web' ? globalThis.localStorage?.getItem(KEY) : await SecureStore.getItemAsync(KEY);
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  } catch { return []; }
};
const save = async (ids: string[]) => {
  const raw = JSON.stringify(ids.slice(-20));
  try { if (Platform.OS === 'web') globalThis.localStorage?.setItem(KEY, raw); else await SecureStore.setItemAsync(KEY, raw); } catch { /* not kept */ }
};

/**
 * "You've landed in Goa": on the map, the day a trip starts and the day after (lib/arrivals.ts landedTrip). One tap to the
 * trip's page (who's in the city on these dates, the city chat) and one to today's plans on the map. No counts are shown that
 * the server didn't send; closing it hides it for that trip for good.
 */
export function LandedCard({ onToday }: { onToday?: () => void }) {
  const trips = useQuery({ queryKey: ['trips'], queryFn: () => api<{ trips: any[] }>('/trips') });
  const [dismissed, setDismissed] = useState<string[] | null>(null);
  useEffect(() => { load().then(setDismissed); }, []);
  if (dismissed === null) return null;
  const t = landedTrip(trips.data?.trips, localDay(), dismissed);
  if (!t) return null;
  const close = () => { const next = [...dismissed, t.id]; setDismissed(next); save(next); };
  const others = Number(t.overlapCount) || 0;
  return (
    <View accessibilityLabel="You've landed" style={{ padding: 14, borderRadius: R.lg, backgroundColor: C.goSoft, gap: 8, marginBottom: 4, borderWidth: 1, borderColor: C.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T style={{ fontFamily: F.b, fontSize: 16 }}>👋 You've landed in {t.city} {flag(t.countryCode)}</T>
          <Muted style={{ fontSize: 13 }}>
            {others > 0 ? `${others} ${others === 1 ? 'traveler is' : 'travelers are'} in ${t.city} on your dates. ` : ''}Say hi to who's here, or join a plan today.
          </Muted>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Hide this" hitSlop={10} onPress={close}>
          <Ionicons name="close" size={20} color={C.ink2} />
        </Pressable>
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {/* The trip's page: everyone in the city on these dates, and its city chat. */}
        <Button title="Who's here" kind="go" onPress={() => router.push(`/trip/${t.id}`)} style={{ flex: 1, minHeight: 40 }} />
        {onToday ? <Button title="Plans today" kind="soft" onPress={onToday} style={{ flex: 1, minHeight: 40 }} /> : null}
      </View>
    </View>
  );
}
