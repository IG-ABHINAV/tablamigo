import React from 'react';
import { View, Pressable, Linking, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Map as MapView, Camera, Marker } from '../lib/maplibre';
import { MAP_STYLE } from '../lib/config';
import { T, Muted } from './ui';
import { C, F, R } from '../lib/theme';

export function MeetingMap({
  lat,
  lng,
  placeName,
  emoji = '📍'
}: {
  lat: number;
  lng: number;
  placeName: string;
  emoji?: string;
}) {
  const openExternalMaps = () => {
    const url = Platform.OS === 'web'
      ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
      : `geo:${lat},${lng}?q=${encodeURIComponent(placeName)}`;
    Linking.openURL(url);
  };

  return (
    <View style={{ width: '100%', borderRadius: R.lg, overflow: 'hidden', borderWidth: 1, borderColor: C.line, backgroundColor: '#fff' }}>
      <View style={{ height: 160, width: '100%', backgroundColor: '#f0f0f0' }}>
        <MapView
          mapStyle={MAP_STYLE}
          style={{ width: '100%', height: '100%' }}
          attribution={false}
          dragPan={false}
          touchZoom={false}
        >
          <Camera center={[lng, lat]} zoom={14} />
          <Marker lngLat={[lng, lat]}>
            <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 3.84 }}>
              <T style={{ fontSize: 18 }}>{emoji}</T>
            </View>
          </Marker>
        </MapView>
      </View>

      <Pressable
        onPress={openExternalMaps}
        style={{ padding: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff' }}
      >
        <View style={{ flex: 1, paddingRight: 8 }}>
          <T numberOfLines={1} style={{ fontFamily: F.b, fontSize: 14 }}>{placeName}</T>
          <Muted style={{ fontSize: 11 }}>Tap for directions in Maps</Muted>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: C.primarySoft, paddingHorizontal: 10, paddingVertical: 5, borderRadius: R.pill }}>
          <Ionicons name="navigate" size={13} color={C.primaryDark} />
          <T style={{ fontFamily: F.b, fontSize: 12, color: C.primaryDark }}>Directions</T>
        </View>
      </Pressable>
    </View>
  );
}
