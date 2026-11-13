import React, { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { askPushOnIntent, askPushAfterValue } from '../../lib/push';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSafeEdges } from '../../lib/safe-edges';
import { Ionicons } from '@expo/vector-icons';
import { T, H1, Muted, Button, Input, Chip, IconButton } from '../../components/ui';
import { daysUntil } from '../../components/format';
import { api, ApiError } from '../../lib/api';
import { queryClient } from '../../lib/query';
import { C, F, R, flag } from '../../lib/theme';
import { cityQueryUrl, cityWhere, parseCities, type City } from '../../lib/places';
import { useHere } from '../../lib/useHere';
import { DateField } from '../../components/DateField';
import { localDay, daysBetween } from '../../lib/date-pick';
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * A label, a value and minus/plus buttons; the value itself opens the phone's date picker when `pick` is given (QA 1 Nov
 * 2026: a trip three months out took ~90 taps on +). Module level: declared inside NewTrip it was a new component type on
 * every render.
 */
// 44pt on the web (no hitSlop there); phones keep their 40pt look.
const STEP = Platform.OS === 'web' ? 44 : 40;

function Stepper({ label, value, set, min, max, fmt, less, more, pick }: { label: string; value: number; set: (v: number) => void; min: number; max: number; fmt: (v: number) => string; less: string; more: string;
  pick?: { date: Date; min: Date; max: Date; onPick: (d: Date) => void; label: string } }) {
  const shown = <View><Muted style={{ fontSize: 13 }}>{label}</Muted>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><T style={{ fontFamily: F.b, fontSize: 17 }}>{fmt(value)}</T>{pick ? <Ionicons name="calendar-outline" size={17} color={C.primary} /> : null}</View></View>;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderRadius: R.md, backgroundColor: C.bgSoft }}>
      {pick ? <DateField mode="date" value={pick.date} min={pick.min} max={pick.max} onChange={pick.onPick} accessibilityLabel={pick.label} style={{ flex: 1 }}>{shown}</DateField> : shown}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {[-1, 1].map(s => <Pressable key={s} accessibilityRole="button" accessibilityLabel={s < 0 ? less : more} onPress={() => set(Math.min(max, Math.max(min, value + s)))} style={{ width: STEP, height: STEP, borderRadius: STEP / 2, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.line }}><Ionicons name={s < 0 ? 'remove' : 'add'} size={20} color={C.ink} /></Pressable>)}
      </View>
    </View>
  );
}

export default function NewTrip() {
  const safeEdges = useSafeEdges();
  // city + cc prefill the city; start (YYYY-MM-DD) prefills the arrival date, e.g. from a Trending card.
  const p = useLocalSearchParams<{ city?: string; cc?: string; start?: string }>();
  const [q, setQ] = useState(p.city ?? ''); const [city, setCity] = useState<City | null>(p.city && p.cc ? { city: p.city, cc: p.cc, country: '' } : null);
  // The search leans towards where the person is (a picked city or their saved place counts too): one Photon call without a
  // point once saved a trip to Agra, India as Agra, United States.
  const { here } = useHere();
  const [found, setFound] = useState<{ q: string; items: City[] }>({ q: '', items: [] });
  const [startOffset, setStart] = useState(() => p.start && /^\d{4}-\d{2}-\d{2}$/.test(p.start) ? Math.min(365, Math.max(0, daysUntil(p.start))) : 7); const [nights, setNights] = useState(5);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  // The hits are kept with the text they were found for and shown only while the box still says that and no city is picked.
  const searching = !city && q.trim().length >= 2;
  const results = searching && found.q === q ? found.items : [];
  useEffect(() => {
    if (!searching) return;
    const t = setTimeout(async () => {
      const r = await fetch(cityQueryUrl(q, here, 6)).then(r => r.json()).catch(() => ({ features: [] }));
      setFound({ q, items: parseCities(r) });
    }, 300);
    return () => clearTimeout(t);
  }, [q, city]);
  const today = useMemo(() => localDay(new Date()), []);
  const start = useMemo(() => { const d = new Date(); d.setDate(d.getDate() + startOffset); return d; }, [startOffset]);
  const end = useMemo(() => { const d = new Date(start); d.setDate(d.getDate() + nights); return d; }, [start, nights]);
  const save = async () => {
    if (!city) return;
    askPushOnIntent();   // web app: the moment to ask for notifications (trip match alerts), from this tap
    setBusy(true); setErr('');
    try { const t = await api('/trips', { body: { city: city.city, countryCode: city.cc, lat: city.lat, lng: city.lng, startDate: iso(start), endDate: iso(end) } }); await queryClient.invalidateQueries({ queryKey: ['trips'] });
      // More people there than a free account can see: the trip screen opens with the Trip Pass sheet.
      router.replace(t.hiddenCount > 0 ? `/trip/${t.id}?hidden=${t.hiddenCount}&total=${t.overlapCount}` : `/trip/${t.id}`);
      // Phone: after the trip is saved, a short reason and then the notification prompt (lib/push.ts). Not over the Trip Pass sheet.
      if (!(t.hiddenCount > 0)) askPushAfterValue('trip'); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'No connection.'); } finally { setBusy(false); }
  };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={safeEdges}>
      <View style={{ paddingHorizontal: 20, paddingVertical: 8 }}><IconButton name="close" label="Close" onPress={() => router.back()} /></View>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 18 }} keyboardShouldPersistTaps="handled">
        <H1>Where to next?</H1>
        <Input value={city ? city.city : q} onChangeText={t => { setCity(null); setQ(t); }} placeholder="Search a city" autoFocus={!p.city} />
        {city ? <T style={{ fontFamily: F.b, fontSize: 16 }}>{flag(city.cc)} {city.city}{city.country ? `, ${city.country}` : ''}</T> : null}
        {results.map((c, i) => <Pressable key={i} onPress={() => setCity(c)} style={{ flexDirection: 'row', gap: 10, alignItems: 'center', padding: 12, borderRadius: R.sm, backgroundColor: C.bgSoft }}>
          <T style={{ fontSize: 22 }}>{flag(c.cc)}</T><View style={{ flexShrink: 1 }}><T style={{ fontFamily: F.sb }}>{c.city}</T><Muted style={{ fontSize: 13 }}>{cityWhere(c)}</Muted></View></Pressable>)}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {[['Next week', 7], ['In 2 weeks', 14], ['Next month', 30]].map(([l, v]) => <Chip key={l as string} label={l as string} active={startOffset === v} onPress={() => setStart(v as number)} />)}
        </View>
        <Stepper label="Arriving" value={startOffset} set={setStart} min={0} max={365} less="Arrive a day earlier" more="Arrive a day later"
          fmt={() => start.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}
          pick={{ date: start, min: today, max: addDays(today, 365), label: 'Pick the arrival date', onPick: d => setStart(Math.min(365, Math.max(0, daysBetween(today, d)))) }} />
        <Stepper label="Staying" value={nights} set={setNights} min={1} max={90} less="One night fewer" more="One night more"
          fmt={(v: number) => `${v} night${v === 1 ? '' : 's'} · until ${end.toLocaleDateString([], { day: 'numeric', month: 'short' })}`}
          pick={{ date: end, min: addDays(start, 1), max: addDays(start, 90), label: 'Pick the leaving date', onPick: d => setNights(Math.min(90, Math.max(1, daysBetween(start, d)))) }} />
        {err ? <T style={{ color: C.danger }}>{err}</T> : null}
        <Button title="Add trip" disabled={!city} loading={busy} onPress={save} style={{ marginTop: 8 }} />
      </ScrollView>
    </SafeAreaView>
  );
}
