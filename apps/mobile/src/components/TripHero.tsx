import React from 'react';
import { Pressable, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { T, H1, Muted, Button, AvatarStack } from './ui';
import { range, daysUntil } from './format';
import { C, F, R, flag } from '../lib/theme';

type Face = { id: string; name?: string | null; photoUrl?: string | null };
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export function tripCountdown(start: string, end: string) {
  const d = daysUntil(start);
  if (d > 1) return `The countdown is on! ${d} days to go`;
  if (d === 1) return 'Starts tomorrow';
  const day = 1 - d, total = dayDiff(start, end) + 1;
  return day > total ? 'This trip has ended' : `You're there now: day ${day} of ${total}`;
}

/** "Fri 24 Oct" for a YYYY-MM-DD day, without the time zone moving it to the day before. */
const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * The trip's header. `chatOpensOn` (GET /trips cityChatOpensOn) is the day the city chat opens to this account, null when it is
 * open now: a locked chat says so on the button, with the date, before anyone taps, instead of a tap that ends on the paywall.
 */
export function TripHero({ trip, faces, total, onSeeAll, onChat, chatLoading, chatOpensOn }: {
  trip: { city: string; countryCode: string; startDate: string; endDate: string };
  faces: Face[]; total: number; onSeeAll: () => void; onChat: () => void; chatLoading?: boolean; chatOpensOn?: string | null;
}) {
  return (
    <LinearGradient colors={['#FFF1EB', '#FFE3DA']} style={{ borderRadius: R.xl, padding: 22, alignItems: 'center', gap: 8 }}>
      <T style={{ fontSize: 56 }}>{flag(trip.countryCode)}</T>
      <H1 style={{ textAlign: 'center' }}>{trip.city}</H1>
      <Muted>📅 {range(trip.startDate, trip.endDate)}</Muted>
      <View style={{ backgroundColor: '#fff', borderRadius: R.pill, paddingHorizontal: 14, paddingVertical: 6, marginTop: 4 }}>
        <T style={{ fontFamily: F.b, fontSize: 14, color: C.primaryDark, textAlign: 'center' }}>{tripCountdown(trip.startDate, trip.endDate)}</T>
      </View>
      {total ? <>
        <View style={{ marginTop: 8 }}><AvatarStack people={faces} size={40} max={5} extra={Math.max(0, total - Math.min(5, faces.length))} /></View>
        <T style={{ fontFamily: F.sb, color: C.ink2 }}>{total} traveler{total === 1 ? '' : 's'} during these dates</T>
        <Pressable onPress={onSeeAll} hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          <T style={{ fontFamily: F.b, color: C.primaryDark }}>See all travelers</T><Ionicons name="chevron-forward" size={16} color={C.primaryDark} />
        </Pressable>
      </> : <Muted style={{ marginTop: 8, textAlign: 'center' }}>Nobody else on these dates yet. Say hi in the city chat.</Muted>}
      {chatOpensOn ? <>
        <Muted style={{ marginTop: 10, textAlign: 'center' }}>🔒 The {trip.city} city chat opens on {dayLabel(chatOpensOn)}, a few days before you land. Plus opens it now.</Muted>
        <Button title="Open the city chat now with Plus" kind="soft" loading={chatLoading} onPress={onChat} icon={<Ionicons name="lock-closed" size={18} color={C.primaryDark} />} style={{ alignSelf: 'stretch', marginTop: 4 }} />
      </> : <Button title={`Go to the ${trip.city} city chat`} loading={chatLoading} onPress={onChat} icon={<Ionicons name="chatbubbles" size={20} color="#fff" />} style={{ alignSelf: 'stretch', marginTop: 10 }} />}
    </LinearGradient>
  );
}
