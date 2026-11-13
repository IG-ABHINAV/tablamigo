import React, { useState } from 'react';
import { Pressable, ScrollView, Switch, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { T, H2, Muted, Button } from './ui';
import { C, F, R } from '../lib/theme';
import { api, ApiError } from '../lib/api';
import { InviteFriendButton } from './InviteFriend';
import { ActivityCard, type Activity } from './ActivityCard';
import { km } from './format';
import { isRealPlace, type Here } from '../lib/where';
import { suggestedPlan, createInCityLabel, cityLine, type PlanCity } from '../lib/empty-nearby';
import { notificationState, fixNotifications } from '../lib/push';

// Title is what gets prefilled ("Maya wants to grab dinner"); label is what the card says.
const IDEAS = [
  { emoji: '🍜', label: 'Grab dinner tonight', title: 'Grab dinner', category: 'food' },
  { emoji: '🌅', label: 'Sunset drinks', title: 'Catch sunset drinks', category: 'drinks' },
  { emoji: '💻', label: 'Coworking this afternoon', title: 'Cowork together', category: 'work' },
  { emoji: '🏛️', label: 'Walking tour tomorrow', title: 'Do a walking tour', category: 'explore' },
  { emoji: '🏃', label: 'Morning run', title: 'Go for a morning run', category: 'sports' },
  { emoji: '🛍️', label: 'Night market', title: 'Explore the night market', category: 'food' },
];

const post = (p?: { title: string; emoji: string; category: string }) => router.push(p ? { pathname: '/activity/new', params: p } : '/activity/new');

/**
 * What the sheet shows when there are no plans nearby yet. "Say hi in the city chat" is the chat for where the person is, so it
 * is offered only for their own fix or the last place the server saw them, never for a picked city or the home-country guess.
 * For the saved place no point is sent: the server uses the one it stored (POST /chats/city-here).
 */
export function MapStarter({ city, here, wider, world, nearestCities, nearbyAlerts }: {
  city: string | null; here: Here; wider?: { radiusKm: number; activities: Activity[] } | null; world?: React.ReactNode;
  /** GET /activities `nearestCities`: only when nothing is within 50 km (API lib/nearby-alerts.ts). */
  nearestCities?: PlanCity[] | null;
  /** GET /activities `nearbyAlerts`: the person's "Notify me when someone near me posts" switch. */
  nearbyAlerts?: boolean;
}) {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const [alertsOn, setAlertsOn] = useState(!!nearbyAlerts);
  const [alertsBusy, setAlertsBusy] = useState(false);
  // Switching it on is a clear reason for notifications: ask the phone (or browser) right from this tap if it still can.
  const toggleAlerts = async (on: boolean) => {
    setAlertsBusy(true); setAlertsOn(on); setErr('');
    try {
      await api('/me', { method: 'PATCH', body: { nearbyPlanAlerts: on } });
    } catch (e) { setAlertsOn(!on); setErr(e instanceof ApiError ? e.message : 'No connection.'); setAlertsBusy(false); return; }
    // Saved. Asking for notifications is a separate step: its failure never flips the switch back.
    try { if (on && (await notificationState()) === 'off') await fixNotifications(); } catch { /* the switch stays on */ }
    finally { setAlertsBusy(false); }
  };
  const idea = suggestedPlan(city, new Date().getHours());
  const empty50 = !!nearestCities;
  const openCityChat = async () => {
    setBusy(true); setErr('');
    try { const r = await api<{ chatId: string }>('/chats/city-here', { body: here.source === 'device' ? { lat: here.lat, lng: here.lng } : {} }); router.push(`/chat/${r.chatId}`); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'No connection.'); } finally { setBusy(false); }
  };
  return (
    <View style={{ paddingTop: 6, paddingBottom: 140, gap: 14 }}>
      <View style={{ paddingHorizontal: 20, gap: 4 }}>
        <H2 style={{ fontFamily: F.xb, fontSize: 22, letterSpacing: -0.4 }}>{city ? `You're early in ${city}!` : "You're early here!"}</H2>
        <Muted style={{ lineHeight: 20 }}>No plans nearby yet. Post the first and travelers around you will see it, or invite a friend to join you.</Muted>
      </View>
      {empty50 ? <>
        {/* Nothing within 50 km (12 Nov 2026): one tap to a prefilled plan, the nearest cities with plans, and a way to hear
            about the first plan near them instead of checking back. */}
        <Button title={createInCityLabel(city)} onPress={() => post(idea)} style={{ marginHorizontal: 20 }} />
        <Muted style={{ marginHorizontal: 20, marginTop: -6, fontSize: 13 }}>Starts as "{idea.emoji} {idea.title}". Edit anything before you post.</Muted>
        <View testID="nearby-alerts" style={{ marginHorizontal: 20, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: R.lg, backgroundColor: C.bgSoft, borderWidth: 1, borderColor: C.line }}>
          <Ionicons name="notifications-outline" size={22} color={C.ink2} />
          <View style={{ flex: 1 }}>
            <T style={{ fontFamily: F.b }}>Notify me when someone near me posts</T>
            <Muted style={{ fontSize: 13 }}>Any new plan within 50 km. At most 2 a day.</Muted>
          </View>
          <Switch accessibilityLabel="Notify me when someone near me posts" value={alertsOn} disabled={alertsBusy} onValueChange={toggleAlerts}
            trackColor={{ true: C.primary, false: C.line }} thumbColor="#fff" />
        </View>
        {nearestCities!.length ? <View testID="nearest-cities" style={{ paddingHorizontal: 20, gap: 8 }}>
          <T style={{ fontFamily: F.b, fontSize: 13, letterSpacing: 0.6, color: C.ink2, textTransform: 'uppercase' }}>Nearest cities with plans</T>
          {nearestCities!.map(c => (
            <Pressable key={c.city} accessibilityRole="link" accessibilityLabel={cityLine(c)} onPress={() => router.push(`/activity/${c.activityId}`)}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: R.md, backgroundColor: pressed ? C.bgSoft : C.bg, borderWidth: 1, borderColor: C.line })}>
              <Ionicons name="location-outline" size={18} color={C.primaryDark} />
              <T numberOfLines={1} style={{ flex: 1, fontFamily: F.sb }}>{cityLine(c)}</T>
              <Ionicons name="chevron-forward" size={18} color={C.ink2} />
            </Pressable>
          ))}
        </View> : null}
      </> : <Button title="Post the first plan here" onPress={() => post()} style={{ marginHorizontal: 20 }} />}
      {/* GET /activities `world` (components/WorldPlans.tsx): plans anywhere, nearest first, with more pages. Older API: `wider`. */}
      {world ? <View style={{ paddingHorizontal: 20 }}>{world}</View> : wider?.activities.length ? <View style={{ paddingHorizontal: 20, gap: 10 }}>
        {/* GET /activities `wider`: the nearest plans further out, nearest first. */}
        <T style={{ fontFamily: F.b, fontSize: 15 }}>Nearest plans{wider.activities[0].city ? `: ${wider.activities[0].city}` : ''}, {km(wider.activities[0].distanceM)} away</T>
        {wider.activities.slice(0, 5).map(a => <ActivityCard key={a.id} a={a} compact />)}
      </View> : null}
      <InviteFriendButton style={{ marginHorizontal: 20 }} />
      {isRealPlace(here) ? <Button title={city ? `Say hi in the ${city} chat` : 'Say hi in the city chat'} kind="ghost" loading={busy} onPress={openCityChat} style={{ marginHorizontal: 20 }} /> : null}
      {err ? <T style={{ color: C.danger, textAlign: 'center' }}>{err}</T> : null}
      <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink2, paddingHorizontal: 20, marginTop: 4 }}>Need an idea?</T>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingHorizontal: 20 }}>
        {IDEAS.map(i => (
          <Pressable key={i.label} onPress={() => post({ title: i.title, emoji: i.emoji, category: i.category })}
            style={({ pressed }) => ({ width: 128, padding: 14, gap: 10, borderRadius: R.lg, backgroundColor: C.bgSoft, borderWidth: 1, borderColor: C.line, transform: [{ scale: pressed ? 0.97 : 1 }] })}>
            <T style={{ fontSize: 28 }}>{i.emoji}</T>
            <T numberOfLines={2} style={{ fontFamily: F.b, fontSize: 14, lineHeight: 19 }}>{i.label}</T>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
