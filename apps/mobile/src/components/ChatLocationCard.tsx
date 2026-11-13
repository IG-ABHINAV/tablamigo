import React from 'react';
import { Linking, Platform, Pressable, View } from 'react-native';
import { Map as MapView, Camera, ViewAnnotation } from '../lib/maplibre';
import { Ionicons } from '@expo/vector-icons';
import { T, Muted, Avatar } from './ui';
import { MAP_STYLE } from '../lib/config';
import { C, F, R, shadow } from '../lib/theme';
import { useNow } from '../lib/useNow';

// `ended: true` is how the API reports a share that was stopped or ran out: an inert object (lat 0, lng 0), never a real position.
export type LiveLocation = { lat: number; lng: number; expiresAt: string; updatedAt: string; ended?: boolean };

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function ChatLocationCard({ loc, name, photo, mine, onStop }: { loc: LiveLocation; name?: string | null; photo?: string | null; mine: boolean; onStop: () => void }) {
  // Flip to "Ended" on time even if no update arrives: the clock ticks every 10 seconds.
  const now = useNow(10_000);
  const live = loc.ended !== true && new Date(loc.expiresAt).getTime() > now;
  // A finished share shows "Ended" and nothing else: no map, no Open in Maps, and never the coordinates (the API sends 0, 0).
  if (!live) {
    return (
      <View style={{ width: 252, gap: 4, paddingVertical: 4 }}>
        <T style={{ fontFamily: F.b, fontSize: 15 }}>{mine ? 'Your live location' : `${name ?? 'Someone'}'s live location`}</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: C.ink3 }} />
          <Muted style={{ fontSize: 12.5, color: C.ink3, fontFamily: F.sb }}>Ended</Muted>
        </View>
      </View>
    );
  }
  const open = () => Linking.openURL(Platform.OS === 'android'
    ? `geo:${loc.lat},${loc.lng}?q=${loc.lat},${loc.lng}(${encodeURIComponent(mine ? 'My location' : `${name ?? 'Traveler'}'s location`)})`
    : `https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng}`).catch(() => {});

  return (
    <View style={{ width: 252, gap: 10 }}>
      <View style={{ height: 130, borderRadius: 14, overflow: 'hidden', backgroundColor: C.bgSoft }}>
        <MapView style={{ flex: 1 }} mapStyle={MAP_STYLE} logo={false} attribution compass={false} androidView="texture"
          dragPan={false} touchZoom={false} doubleTapZoom={false} doubleTapHoldZoom={false} touchRotate={false} touchPitch={false}>
          <Camera center={[loc.lng, loc.lat]} zoom={15} duration={600} />
          <ViewAnnotation lngLat={[loc.lng, loc.lat]} anchor="center">
            <View style={[{ borderRadius: 20, borderWidth: 3, borderColor: live ? C.primary : C.ink3, backgroundColor: '#fff' }, shadow]}>
              <Avatar uri={photo} name={name} size={30} />
            </View>
          </ViewAnnotation>
        </MapView>
      </View>
      <View style={{ gap: 2 }}>
        <T style={{ fontFamily: F.b, fontSize: 15 }}>{mine ? 'Your live location' : `${name ?? 'Someone'}'s live location`}</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: live ? C.go : C.ink3 }} />
          <Muted style={{ fontSize: 12.5, color: live ? C.go : C.ink3, fontFamily: F.sb }}>{live ? `Live until ${hhmm(loc.expiresAt)}` : 'Ended'}</Muted>
          <Muted style={{ fontSize: 12 }}>· updated {hhmm(loc.updatedAt)}</Muted>
        </View>
        {mine && live ? <Muted style={{ fontSize: 12, color: C.danger, fontFamily: F.sb }}>Everyone in this chat can see your exact position.</Muted> : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable onPress={open} style={{ flex: 1, height: 38, borderRadius: R.pill, backgroundColor: C.bgSoft, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="map-outline" size={16} color={C.ink} /><T style={{ fontFamily: F.b, fontSize: 13 }}>Open in Maps</T>
        </Pressable>
        {mine && live ? (
          <Pressable onPress={onStop} style={{ flex: 1, height: 38, borderRadius: R.pill, backgroundColor: '#FDECEC', alignItems: 'center', justifyContent: 'center' }}>
            <T style={{ fontFamily: F.b, fontSize: 13, color: C.danger }}>Stop sharing</T>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
