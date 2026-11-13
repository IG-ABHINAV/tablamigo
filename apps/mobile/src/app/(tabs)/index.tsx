import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, View, ActivityIndicator } from 'react-native';
import { useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { Map as MapView, Camera, Marker, ViewAnnotation, type CameraRef } from '../../lib/maplibre';
import { Ionicons } from '@expo/vector-icons';
import { MapPin, MapPhotoPin } from '../../components/MapPin';
import { MapStarter } from '../../components/MapStarter';
import { WorldPlans, type WorldPage } from '../../components/WorldPlans';
import type { PlanCity } from '../../lib/empty-nearby';
import { MapBell } from '../../components/MapBell';
import { LiveCity } from '../../components/LiveCity';
import { LandedCard } from '../../components/LandedCard';
import { placeRoute } from '../../lib/photo-viewer';
import { useMapIdeas, type Idea } from '../../lib/ideas';
import { ActivityCard, type Activity } from '../../components/ActivityCard';
import { useQuickJoin } from '../../lib/useQuickJoin';
import { ExploreAd } from '../../components/ExploreAd';
import { exploreAdSlot } from '../../lib/ads-config';
import { Sheet, useSheetHiddenBelow } from '../../components/Sheet';
import { T, Muted, Chip, Avatar, AvatarStack, Empty, Button } from '../../components/ui';
import { useLocation } from '../../lib/location';
import { useHere } from '../../lib/useHere';
import { NoPlace, PlaceNote, askForLocation } from '../../components/NoPlace';
import { mayAutoAsk } from '../../lib/location-permission';
import { api } from '../../lib/api';
import { MAP_STYLE } from '../../lib/config';
import { planDay } from '../../components/format';
import { C, F, R, CATEGORIES, shadow, tabBarHeight } from '../../lib/theme';

// Photo pins are live native views (ViewAnnotation snapshots once on Android, before the photo loads), so only the nearest get one.
const PHOTO_PINS = 40;

const list_len = (l?: unknown[]) => l?.length ?? 0;

type Row = { kind: 'day'; label: string; count: number; key: string } | { kind: 'plan'; a: Activity; key: string };
// The sheet's list, sectioned by day. Stable within a day, so the API's order (Plus hosts first) holds there.
function byDay(list: Activity[]): Row[] {
  const day = (iso: string) => new Date(Math.max(Date.now(), Date.parse(iso))).setHours(0, 0, 0, 0);
  const days = new Map<string, Activity[]>();
  for (const a of [...list].sort((x, y) => day(x.startsAt) - day(y.startsAt))) {
    const d = planDay(a.startsAt); days.set(d, [...(days.get(d) ?? []), a]);
  }
  const out: Row[] = [];
  for (const [label, acts] of days) { out.push({ kind: 'day', label, count: acts.length, key: `d${label}` }); for (const a of acts) out.push({ kind: 'plan', a, key: a.id }); }
  return out;
}

export default function Explore() {
  const insets = useSafeAreaInsets();
  // The window's height now (it changes without a restart: display or font size, split screen, a foldable).
  const H = useWindowDimensions().height;
  const hiddenBelow = useSheetHiddenBelow();
  const locate = useLocation(s => s.locate);
  // No fix means the saved place, then the home country's main city, then "pick a city": never a made-up one (lib/where.ts).
  const { here, settled } = useHere();
  const quickJoin = useQuickJoin('explore');
  const city = here?.city ?? null;
  const [cat, setCat] = useState<string>('all');
  const [whenFilter, setWhenFilter] = useState<'week' | 'today' | 'weekend' | 'tomorrow' | 'now'>('week');
  const [recurringOnly, setRecurringOnly] = useState(false);
  // Set once the person scrolls the plan list themselves; the list's ad slot waits for it (lib/ads-config.ts exploreAdSlot).
  // A new filter is a new list, so it waits for its own scroll: what is stored is the filter the scroll happened under.
  const listKey = `${cat}|${whenFilter}|${recurringOnly}`;
  const [browsedKey, setBrowsedKey] = useState<string | null>(null);
  const browsed = browsedKey === listKey;
  const WHEN_OPTIONS = [
    { id: 'week', label: 'All plans' },
    { id: 'today', label: 'Today ⚡' },
    { id: 'weekend', label: 'This Weekend 🎉' },
    { id: 'tomorrow', label: 'Tomorrow' },
    { id: 'now', label: 'Now 🟢' },
  ] as const;
  const cam = useRef<CameraRef>(null);
  // Opening the map asks for location only if nobody said no in this session (onboarding asks just before this).
  useEffect(() => { locate({ ask: mayAutoAsk(useLocation.getState()) }); }, []);
  const locateTapped = askForLocation;
  // Nothing is asked for until there is a real place to ask about.
  const at = here ?? { lat: 0, lng: 0 };
  // The list's point and filters; the world list's further pages (components/WorldPlans.tsx) ask with the same ones.
  const listQuery = `lat=${at.lat}&lng=${at.lng}${cat !== 'all' ? `&category=${cat}` : ''}&when=${whenFilter}${recurringOnly ? '&recurring_only=true' : ''}`;
  const acts = useQuery({
    queryKey: ['activities', at.lat.toFixed(3), at.lng.toFixed(3), cat, whenFilter, recurringOnly],
    queryFn: () => api<{ activities: Activity[]; wider?: { radiusKm: number; activities: Activity[] } | null; world?: WorldPage | null; nearestCities?: PlanCity[] | null; nearbyAlerts?: boolean }>(`/activities?${listQuery}`),
    refetchInterval: 45_000, enabled: !!here,
  });
  // Few or no plans nearby: the rest of the world after them, nearest first (API GET /activities `world`).
  const world = acts.data?.world ?? null;
  const worldPlans = world?.activities.length ? <WorldPlans first={world} query={listQuery} nearbyCount={list_len(acts.data?.activities)} /> : null;
  const travelers = useQuery({ queryKey: ['travelers', at.lat.toFixed(2), at.lng.toFixed(2)], queryFn: () => api(`/travelers/nearby?lat=${at.lat}&lng=${at.lng}`), enabled: !!here });
  const list = acts.data?.activities ?? [];
  // The sheet's list, sectioned by day. Stable within a day, so the API's order (Plus hosts first) holds there.
  const rows = useMemo(() => byDay(acts.data?.activities ?? []), [acts.data]);
  const photos = useMemo(() => new Set(list.filter(a => a.host.photoUrl).sort((x, y) => (x.distanceM ?? 0) - (y.distanceM ?? 0)).slice(0, PHOTO_PINS).map(a => a.id)), [acts.data]);
  // Nothing posted nearby at all (no filter hiding anything): the starter. A filter with no matches is a different, smaller message.
  const filtered = cat !== 'all' || whenFilter !== 'week' || recurringOnly;
  const starter = acts.isSuccess && !list.length && !filtered;
  // AI idea pins: only while the map shows fewer than 3 real plans (the ones it frames, within 15 km).
  const nearPlans = list.filter(a => (a.distanceM ?? 0) < 15_000).length;
  const ideas = useMapIdeas(city, at, !!here && acts.isSuccess && cat === 'all' && nearPlans < 3);
  const openIdea = (i: Idea) => router.push({ pathname: '/activity/new', params: { title: i.title, emoji: i.emoji, category: i.category, placeName: i.placeName, lat: String(i.lat), lng: String(i.lng) } });
  // When ideas arrive on a nearly empty map, frame them once, with you and the few real plans.
  const framedIdeas = useRef('');
  useEffect(() => {
    if (!here || !ideas.pins.length || framedIdeas.current === city) return;
    framedIdeas.current = city ?? '';
    const pts = [...ideas.pins.slice(0, 6), ...list.filter(a => (a.distanceM ?? 0) < 15_000)];
    const lngs = [here.lng, ...pts.map(i => i.lng!)], lats = [here.lat, ...pts.map(i => i.lat!)];
    cam.current?.fitBounds([Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
      { padding: { top: insets.top + 150, bottom: Math.round(H * 0.5) + 30, left: 50, right: 50 }, duration: 800 });
  }, [ideas.pins.length, city]);
  // Frame you plus the nearest plans (the sheet covers the lower half, so pad for it).
  // Only when location or category changes, never on the 45s refetch, so panning isn't undone.
  const framed = useRef('');
  useEffect(() => {
    if (!here) return;
    const key = `${here.lat.toFixed(3)},${here.lng.toFixed(3)}|${cat}`;
    if (!acts.data || framed.current === key) return;
    framed.current = key;
    const near = list.filter(a => (a.distanceM ?? 0) < 15_000).slice(0, 8);
    if (!near.length) { cam.current?.flyTo({ center: [here.lng, here.lat], zoom: 13, duration: 800 }); return; }
    const lngs = [here.lng, ...near.map(a => a.lng)], lats = [here.lat, ...near.map(a => a.lat)];
    cam.current?.fitBounds([Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
      { padding: { top: insets.top + 130, bottom: Math.round(H * 0.5) + 30, left: 40, right: 40 }, duration: 800 });
  }, [acts.data, here?.lat, here?.lng, cat]);

  const header = (
    // The title column shrinks and wraps first, so Create stays whole on a small phone with large text.
    <View style={{ paddingHorizontal: 20, paddingTop: 10, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
      <View style={{ flex: 1, flexShrink: 1 }}>
        <T style={{ fontFamily: F.xb, fontSize: 22, letterSpacing: -0.4 }}>{list.length ? `${list.length} ${list.length === 1 ? 'plan' : 'plans'} nearby` : 'Plans nearby'}</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* The city opens its page: who's here now, who lands today, its plans. */}
          {city && placeRoute(city) ? (
            <Pressable accessibilityRole="link" accessibilityLabel={`Open ${city}`} hitSlop={6} onPress={() => router.push(placeRoute(city) as any)}>
              <Muted style={{ color: C.primaryDark, fontFamily: F.sb }}>in {city} ›</Muted>
            </Pressable>
          ) : <Muted>{city ? `in ${city}` : 'Around you'}</Muted>}
          <Muted> · next 2 weeks</Muted>
        </View>
      </View>
      <Pressable onPress={() => router.push('/activity/new')} accessibilityRole="button" accessibilityLabel="Create a plan" style={{ flexShrink: 0, backgroundColor: C.primary, height: 42, paddingHorizontal: 16, borderRadius: R.pill, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Ionicons name="add" size={20} color="#fff" /><T style={{ color: '#fff', fontFamily: F.b }}>Create</T>
      </Pressable>
    </View>
  );

  if (!here) return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top + 8, justifyContent: 'center' }}>
      <View style={{ position: 'absolute', top: insets.top + 8, right: 16 }}><MapBell /></View>
      <NoPlace settled={settled} />
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bgSoft }}>
      <MapView style={{ flex: 1 }} mapStyle={MAP_STYLE} logo={false} attribution compass={false}>
        <Camera ref={cam} initialViewState={{ center: [here.lng, here.lat], zoom: 12 }} />
        {list.map(a => photos.has(a.id)
          ? <Marker key={`p${a.id}`} lngLat={[a.lng, a.lat]} anchor="bottom" onPress={() => router.push(`/activity/${a.id}`)}><MapPhotoPin a={a} /></Marker>
          : <ViewAnnotation key={`e${a.id}`} lngLat={[a.lng, a.lat]} anchor="bottom" onPress={() => router.push(`/activity/${a.id}`)}><MapPin a={a} /></ViewAnnotation>)}
        {ideas.pins.map((i, k) => <ViewAnnotation key={`i${k}${i.title}`} lngLat={[i.lng!, i.lat!]} anchor="bottom" onPress={() => openIdea(i)}><MapPin a={i} idea /></ViewAnnotation>)}
      </MapView>

      {/* top overlay: travelers pill + category chips */}
      <View style={{ position: 'absolute', top: insets.top + 8, left: 0, right: 0, gap: 10 }}>
        <View style={{ flexDirection: 'row', paddingHorizontal: 16, gap: 10 }}>
          <Pressable onPress={() => router.push('/travelers')} style={[{ flexShrink: 1, marginRight: 'auto', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderRadius: R.pill, paddingLeft: 6, paddingRight: 14, height: 46 }, shadow]}>
            <AvatarStack people={(travelers.data?.travelers ?? []).slice(0, 3)} size={30} max={3} />
            <T numberOfLines={1} style={{ fontFamily: F.b, flexShrink: 1 }}>{travelers.data ? (travelers.data.count ? `${travelers.data.count} ${travelers.data.count === 1 ? 'traveler' : 'travelers'} here` : 'Who\'s around') : 'Finding travelers…'}</T>
            <Ionicons name="chevron-forward" size={16} color={C.ink2} />
          </Pressable>
          <Pressable onPress={locateTapped} accessibilityLabel="Find my location" style={[{ width: 46, height: 46, borderRadius: 23, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' }, shadow]}>
            <Ionicons name="locate" size={22} color={C.ink} />
          </Pressable>
          <MapBell />
        </View>
        <PlaceNote here={here} style={{ marginHorizontal: 16, alignSelf: 'flex-start' }} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
          <Chip label="🔁 Clubs & Series" active={recurringOnly} onPress={() => setRecurringOnly(!recurringOnly)} style={shadow} />
          <View style={{ width: 1, height: 26, backgroundColor: C.line, alignSelf: 'center', marginHorizontal: 2 }} />
          {WHEN_OPTIONS.map(w => (
            <Chip key={w.id} label={w.label} active={whenFilter === w.id} onPress={() => setWhenFilter(w.id)} style={shadow} />
          ))}
          <View style={{ width: 1, height: 26, backgroundColor: C.line, alignSelf: 'center', marginHorizontal: 2 }} />
          {CATEGORIES.map(c => <Chip key={c.id} label={c.label} emoji={c.emoji} active={cat === c.id} onPress={() => setCat(c.id)} style={shadow} />)}
        </ScrollView>
        {ideas.available || (!ideas.on && cat === 'all' && nearPlans < 3) ? <Pressable onPress={ideas.toggle} accessibilityRole="switch" accessibilityState={{ checked: ideas.on }}
          style={[{ alignSelf: 'flex-end', marginRight: 16, flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: 12, borderRadius: R.pill,
            backgroundColor: ideas.on ? C.womenSoft : '#fff', borderWidth: 1.5, borderStyle: 'dashed', borderColor: ideas.on ? C.women : C.ink3 }, shadow]}>
          <T style={{ fontSize: 13 }}>✨</T>
          <T style={{ fontFamily: F.b, fontSize: 13, color: ideas.on ? C.women : C.ink2 }}>{ideas.on ? `Ideas · ${ideas.pins.length}` : 'Ideas off'}</T>
        </Pressable> : null}
      </View>

      <Sheet header={starter ? undefined : header} peek={150}>
        {acts.isLoading ? <ActivityIndicator style={{ marginTop: 30 }} color={C.primary} />
          : starter ? <ScrollView contentContainerStyle={{ paddingBottom: hiddenBelow + tabBarHeight(insets.bottom) + 32 }}><View style={{ paddingHorizontal: 16, paddingTop: 8 }}><LandedCard /></View><MapStarter key={city ?? ''} city={city} here={here} wider={acts.data?.wider} world={worldPlans} nearestCities={acts.data?.nearestCities} nearbyAlerts={acts.data?.nearbyAlerts} /></ScrollView>
          // Bottom padding: what the fully open sheet keeps below the screen, the tab bar, then a gap, so the last row (a plan, or
          // the ad) can be scrolled clear of the tab bar.
          : <FlatList data={rows} keyExtractor={r => r.key} onScrollBeginDrag={() => setBrowsedKey(listKey)}
              contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: hiddenBelow + tabBarHeight(insets.bottom) + 32 }}
              renderItem={({ item: r, index }) => r.kind === 'day'
                ? <T style={{ fontFamily: F.b, fontSize: 13, letterSpacing: 0.6, color: C.ink2, textTransform: 'uppercase', marginTop: index ? 10 : 0 }}>{r.label} · {r.count}</T>
                : <ActivityCard a={r.a} compact quickJoin={quickJoin} />}
              // The app's only ad, after the last plan (components/ExploreAd.tsx): never on an empty list, next to its buttons, and
              // not before the person has scrolled the list.
              // Live counts for this city, only once it has 10+ upcoming trips from real travellers (components/LiveCity.tsx).
              ListHeaderComponent={<><LandedCard onToday={() => { setCat('all'); setRecurringOnly(false); setWhenFilter('today'); }} /><LiveCity city={city} /></>}
              ListFooterComponent={<>{worldPlans}{exploreAdSlot(list.length, browsed) ? <ExploreAd /> : null}</>}
              ListEmptyComponent={worldPlans ? <Muted style={{ textAlign: 'center', paddingVertical: 8 }}>No plans nearby match these filters.</Muted> : <Empty emoji="🌴" title="No plans match these filters" body="Try another day or category, or post a plan here yourself."
                action={<View style={{ gap: 10, alignSelf: 'stretch', marginTop: 12 }}>
                  <Button title="Show all plans" onPress={() => { setCat('all'); setWhenFilter('week'); setRecurringOnly(false); }} />
                  <Button title="Post a plan here" kind="soft" onPress={() => router.push('/activity/new')} />
                </View>} />} />}
      </Sheet>
      {quickJoin.sheet}
    </View>
  );
}
