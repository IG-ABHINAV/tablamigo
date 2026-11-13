import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSafeEdges } from '../lib/safe-edges';
import { Ionicons } from '@expo/vector-icons';
import { T, H1, Muted, Input, IconButton } from '../components/ui';
import { askForLocation } from '../components/NoPlace';
import { useLocation } from '../lib/location';
import { cityQueryUrl, cityWhere, parseCities, type City } from '../lib/places';
import { C, F, R, flag } from '../lib/theme';

/** Look around a city without sharing a location: the map, plans, travelers and feed use it until "Use my location". */
export default function PickCity() {
  const safeEdges = useSafeEdges();
  const pos = useLocation(s => s.pos);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ q: string; items: City[] }>({ q: '', items: [] });
  const searching = q.trim().length >= 2;
  const results = searching && found.q === q ? found.items : [];
  useEffect(() => {
    if (!searching) return;
    const t = setTimeout(async () => {
      const j = await fetch(cityQueryUrl(q, pos)).then(r => r.json()).catch(() => ({ features: [] }));
      setFound({ q, items: parseCities(j).filter(c => c.lat != null && c.lng != null) });
    }, 300);
    return () => clearTimeout(t);
  }, [q]);
  const choose = (c: City) => { useLocation.getState().pick({ lat: c.lat!, lng: c.lng!, city: c.city }); router.back(); };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={safeEdges}>
      <View style={{ paddingHorizontal: 20, paddingVertical: 8 }}><IconButton name="close" label="Close" onPress={() => router.back()} /></View>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }} keyboardShouldPersistTaps="handled">
        <H1>Pick a city</H1>
        <Muted>See the plans and travelers there. Your location isn't shared.</Muted>
        <Input value={q} onChangeText={setQ} placeholder="Search a city" autoFocus />
        {results.map((c, i) => <Pressable key={i} onPress={() => choose(c)} style={{ flexDirection: 'row', gap: 10, alignItems: 'center', padding: 12, borderRadius: R.sm, backgroundColor: C.bgSoft }}>
          <T style={{ fontSize: 22 }}>{flag(c.cc)}</T>
          <View style={{ flexShrink: 1 }}><T style={{ fontFamily: F.sb }}>{c.city}</T><Muted style={{ fontSize: 13 }}>{cityWhere(c)}</Muted></View>
        </Pressable>)}
        <Pressable onPress={async () => { await askForLocation(); if (useLocation.getState().pos) router.back(); }} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10 }}>
          <Ionicons name="locate" size={20} color={C.primaryDark} /><T style={{ fontFamily: F.b, color: C.primaryDark }}>Use my location instead</T>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
