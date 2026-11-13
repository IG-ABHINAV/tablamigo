import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Switch, View, ActivityIndicator, KeyboardAvoidingView } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSafeEdges } from '../../lib/safe-edges';
import { useQuery } from '@tanstack/react-query';
import { T, H1, H2, Muted, Button, Input, Chip, IconButton } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useHere } from '../../lib/useHere';
import { queryClient } from '../../lib/query';
import { C, F, R, CATEGORIES } from '../../lib/theme';
import { FEATURES } from '../../lib/config';
import { slotsForDay, parseNear, MAX_DAYS_AHEAD } from '../../lib/plan-prefill';
import { DateField } from '../../components/DateField';
import { askPushAfterValue } from '../../lib/push';
import { Ionicons } from '@expo/vector-icons';

/** Where the time picker starts: the next whole hour at least an hour ahead. */
const pickerStart = () => { const d = new Date(Date.now() + 60 * 60_000); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d; };
const customLabel = (d: Date) => `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

const EMOJIS = ['🍜', '🍕', '☕', '🍸', '🍻', '🪩', '🌅', '🏖️', '🏄', '🥾', '🚴', '🎨', '🏛️', '🎶', '⚽', '💻', '🛍️', '📸', '🧘', '✨'];
type Place = { name: string; address: string; lat: number; lng: number };

function times() {
  const now = new Date(); const out: { label: string; d: Date }[] = [];
  const at = (days: number, h: number) => { const d = new Date(now); d.setDate(now.getDate() + days); d.setHours(h, 0, 0, 0); return d; };
  const soon = new Date(now.getTime() + 60 * 60000); soon.setMinutes(soon.getMinutes() < 30 ? 30 : 60, 0, 0);
  out.push({ label: 'In an hour', d: soon });
  if (now.getHours() < 18) out.push({ label: 'Tonight 7 PM', d: at(0, 19) });
  if (now.getHours() < 20) out.push({ label: 'Tonight 9 PM', d: at(0, 21) });
  out.push({ label: 'Tomorrow 10 AM', d: at(1, 10) }, { label: 'Tomorrow 1 PM', d: at(1, 13) }, { label: 'Tomorrow 7 PM', d: at(1, 19) });
  for (let i = 2; i <= 5; i++) out.push({ label: `${at(i, 19).toLocaleDateString([], { weekday: 'short' })} 7 PM`, d: at(i, 19) });
  return out;
}

export default function NewActivity() {
  const safeEdges = useSafeEdges();
  // Place search is biased to where the person is, or not at all: never to a made-up city (lib/where.ts).
  const { here } = useHere();
  const city = here?.city ?? null;
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me') });
  // Starter ideas on the map open this prefilled.
  // Idea pins also pass the place the idea is at (coordinates only ever come from a real geocoder hit).
  // Template links from the team's empty-city nudge add the trip's first day (date) and its city (near).
  const p = useLocalSearchParams<{ title?: string; emoji?: string; category?: string; placeName?: string; lat?: string; lng?: string; date?: string; near?: string }>();
  const near = parseNear(p.near);
  const ideaPlace: Place | null = p.placeName && p.lat && p.lng && Number.isFinite(+p.lat) && Number.isFinite(+p.lng) ? { name: p.placeName, address: p.placeName, lat: +p.lat, lng: +p.lng } : null;
  const emojis = p.emoji && !EMOJIS.includes(p.emoji) ? [p.emoji, ...EMOJIS] : EMOJIS;
  const [emoji, setEmoji] = useState(p.emoji || '🍜'); const [title, setTitle] = useState(p.title ?? ''); const [cat, setCat] = useState(CATEGORIES.some(c => c.id !== 'all' && c.id === p.category) ? p.category! : 'food');
  const [placeQ, setPlaceQ] = useState(''); const [place, setPlace] = useState<Place | null>(ideaPlace); const [found, setFound] = useState<{ q: string; items: Place[] }>({ q: '', items: [] });
  const [when, setWhen] = useState<Date | null>(null); const [max, setMax] = useState<number | null>(6); const [womenOnly, setWomenOnly] = useState(false);
  const [recurrence, setRecurrence] = useState<'weekly' | 'biweekly' | 'monthly' | null>(null);
  const [isPaid, setIsPaid] = useState(false);
  const [ticketPrice, setTicketPrice] = useState('499');
  const [maxTickets, setMaxTickets] = useState('10');
  const [payoutUpi, setPayoutUpi] = useState('');
  const [desc, setDesc] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const [ideas, setIdeas] = useState<any[] | null>(null); const [ideasBusy, setIdeasBusy] = useState(false);
  const slots = useMemo(() => [...slotsForDay(p.date), ...times()], [p.date]);
  // A time from the picker rather than a preset chip: shown on the picker's own chip.
  const custom = when && !slots.some(x => x.d.getTime() === when.getTime()) ? when : null;

  // Place search (OpenStreetMap / Photon), biased to where the user is. The hits are kept with the text they were found
  // for, and shown only while the box still says that and no place is picked, so nothing has to be cleared by hand.
  const searching = !place && placeQ.trim().length >= 3;
  const results = searching && found.q === placeQ ? found.items : [];
  useEffect(() => {
    if (!searching) return;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(placeQ)}${near ? `&lat=${near.lat}&lon=${near.lng}` : here ? `&lat=${here.lat}&lon=${here.lng}` : ''}&limit=6&lang=en`);
        const j = await r.json();
        setFound({ q: placeQ, items: j.features.map((f: any) => ({
          name: f.properties.name ?? placeQ,
          address: [f.properties.street, f.properties.district ?? f.properties.city, f.properties.country].filter(Boolean).join(', '),
          lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
        })) });
      } catch { setFound({ q: placeQ, items: [] }); }
    }, 350);
    return () => clearTimeout(t);
  }, [placeQ, place]);

  // One ask at a time: the button stayed live while loading, so every extra tap sent another ask (each spends a free idea).
  const asking = React.useRef(false);
  const suggest = async () => {
    if (asking.current) return;
    asking.current = true;
    setIdeasBusy(true); setErr('');
    try { const r = await api(`/ai/suggest?city=${encodeURIComponent(city ?? 'my city')}`); setIdeas(r.ideas ?? []); }
    catch (e) { if (e instanceof ApiError && e.code === 'plus_required') router.push('/paywall?reason=ai'); else setErr('Ideas are unavailable right now.'); }
    finally { setIdeasBusy(false); asking.current = false; }
  };

  const valid = title.trim().length >= 3 && place && when;
  const submit = async () => {
    if (!valid || !place || !when) return;
    setBusy(true); setErr('');
    try {
      const parsedPrice = isPaid ? Math.round(parseFloat(ticketPrice || '0') * 100) : undefined;
      const parsedMaxTickets = isPaid && maxTickets ? parseInt(maxTickets, 10) : undefined;
      const r = await api('/activities', {
        body: {
          title: title.trim(),
          emoji,
          category: cat,
          description: desc.trim() || undefined,
          placeName: place.name,
          placeAddress: place.address,
          lat: place.lat,
          lng: place.lng,
          startsAt: when.toISOString(),
          maxPeople: max ?? undefined,
          womenOnly,
          recurrence: recurrence || undefined,
          isPaid,
          ticketPricePaise: parsedPrice,
          maxTickets: parsedMaxTickets,
          payoutUpiId: isPaid && payoutUpi.trim() ? payoutUpi.trim() : undefined,
        }
      });
      await queryClient.invalidateQueries();
      router.replace(`/chat/${r.chatId}`);
      askPushAfterValue('plan');   // phone: now there is a reason to say yes to notifications (lib/push.ts)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'plus_required') router.push('/paywall?reason=activities');
      else setErr(e instanceof ApiError ? e.message : 'No connection.');
    } finally { setBusy(false); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={safeEdges}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 8 }}>
          <IconButton name="close" label="Close" onPress={() => router.back()} />
          <Pressable onPress={suggest} disabled={ideasBusy} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.womenSoft, paddingHorizontal: 12, height: 36, borderRadius: R.pill }}>
            {ideasBusy ? <ActivityIndicator size="small" color={C.women} /> : <T style={{ fontSize: 14 }}>✨</T>}
            <T style={{ fontFamily: F.b, color: C.women }}>Ideas for {city ?? 'here'}</T>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 22, paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
          <H1>What's the plan?</H1>
          {ideas ? <View style={{ gap: 8 }}>
            {ideas.map((i, k) => <Pressable key={k} onPress={() => { setEmoji(i.emoji || '✨'); setTitle(i.title); setCat(i.category); setPlaceQ(i.placeName); setPlace(null); setIdeas(null); }}
              style={{ flexDirection: 'row', gap: 10, padding: 12, borderRadius: R.md, backgroundColor: C.womenSoft }}>
              <T style={{ fontSize: 22 }}>{i.emoji}</T><View style={{ flex: 1 }}><T style={{ fontFamily: F.b }}>{i.title}</T><Muted style={{ fontSize: 13 }}>{i.placeName} · {i.why}</Muted></View>
            </Pressable>)}
          </View> : null}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {emojis.map(e => <Pressable key={e} onPress={() => setEmoji(e)} style={{ width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: emoji === e ? C.primarySoft : C.bgSoft, borderWidth: 2, borderColor: emoji === e ? C.primary : 'transparent' }}><T style={{ fontSize: 24 }}>{e}</T></Pressable>)}
          </ScrollView>
          <Input label="I want to…" value={title} onChangeText={setTitle} placeholder="Grab street food in Chinatown" maxLength={80} />
          <View style={{ gap: 8 }}>
            <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink2 }}>Category</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{CATEGORIES.filter(c => c.id !== 'all').map(c => <Chip key={c.id} label={c.label} emoji={c.emoji} active={cat === c.id} onPress={() => setCat(c.id)} />)}</View>
          </View>
          <View style={{ gap: 8 }}>
            <Input label="Where?" value={place ? place.name : placeQ} onChangeText={t => { setPlace(null); setPlaceQ(t); }} placeholder="Search a café, bar, park…" />
            {place ? <Muted>📍 {place.address}</Muted> : null}
            {results.map((p, i) => <Pressable key={i} onPress={() => setPlace(p)} style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: R.sm, backgroundColor: C.bgSoft }}>
              <T style={{ fontFamily: F.sb }}>{p.name}</T><Muted style={{ fontSize: 13 }}>{p.address}</Muted></Pressable>)}
          </View>
          <View style={{ gap: 8 }}>
            <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink2 }}>When?</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{slots.map(s => <Chip key={s.label} label={s.label} active={when?.getTime() === s.d.getTime()} onPress={() => setWhen(s.d)} />)}
              {/* Any other day and time (QA 1 Nov 2026: only the presets above existed). Up to the API's 30 days ahead. */}
              <DateField mode="datetime" value={when ?? pickerStart()} min={new Date(Date.now() + 30 * 60_000)} max={new Date(Date.now() + MAX_DAYS_AHEAD * 86_400_000)} onChange={setWhen}
                accessibilityLabel={custom ? `Plan time: ${customLabel(custom)}. Change it` : 'Pick another day and time'}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 38, borderRadius: R.pill, backgroundColor: custom ? C.ink : '#fff', borderWidth: 1, borderColor: custom ? C.ink : C.line }}>
                  <Ionicons name="calendar-outline" size={15} color={custom ? '#fff' : C.ink} />
                  <T style={{ fontFamily: F.sb, fontSize: 14, color: custom ? '#fff' : C.ink }}>{custom ? customLabel(custom) : 'Other time'}</T>
                </View>
              </DateField>
            </View>
          </View>
          <View style={{ gap: 8 }}>
            <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink2 }}>Group size</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{[4, 6, 8, 12, null].map(n => <Chip key={String(n)} label={n ? `Up to ${n}` : 'No limit'} active={max === n} onPress={() => setMax(n)} />)}</View>
          </View>
          <View style={{ gap: 8 }}>
            <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink2 }}>Repeat / Recurring meetup</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {[
                { id: null, label: 'One-off' },
                { id: 'weekly', label: '🔁 Weekly' },
                { id: 'biweekly', label: '🔁 Every 2 weeks' },
                { id: 'monthly', label: '🔁 Monthly' },
              ].map(item => (
                <Chip
                  key={String(item.id)}
                  label={item.label}
                  active={recurrence === item.id}
                  onPress={() => setRecurrence(item.id as any)}
                />
              ))}
            </View>
            {recurrence ? (
              <View style={{ backgroundColor: '#EEF2FF', padding: 12, borderRadius: R.sm, marginTop: 2 }}>
                <T style={{ fontSize: 12.5, color: '#3730A3', fontFamily: F.m, lineHeight: 18 }}>
                  🔁 Automatically schedules the next session when this one ends. Your attendee chat stays open so regular members stay connected.
                </T>
              </View>
            ) : null}
          </View>
          {me.data?.gender === 'woman' ? <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderRadius: R.md, backgroundColor: C.womenSoft }}>
            <View style={{ flex: 1 }}><T style={{ fontFamily: F.b, color: C.women }}>Women only</T><Muted style={{ fontSize: 13 }}>Only women will see and can join this plan.</Muted></View>
            <Switch accessibilityLabel="Women only" value={womenOnly} onValueChange={setWomenOnly} trackColor={{ true: C.women }} />
          </View> : null}

          {/* Ticketed Event Toggle & Options. Hidden while paid events are off (FEATURES.paidEvents; the API refuses
              them too): there is no in-app checkout, refund or host payout yet. */}
          {FEATURES.paidEvents ? (
          <View style={{ gap: 10, padding: 14, borderRadius: R.md, backgroundColor: isPaid ? '#FFFBEB' : C.bgSoft, borderWidth: 1, borderColor: isPaid ? '#FDE68A' : C.line }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flex: 1, paddingRight: 10 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <T style={{ fontSize: 16 }}>🎟️</T>
                  <T style={{ fontFamily: F.b, fontSize: 14, color: isPaid ? '#92400E' : C.ink }}>Ticketed Plan / Workshop</T>
                </View>
                <Muted style={{ fontSize: 12, marginTop: 2 }}>
                  Charge for walking tours, workshops, cooking classes, or surf sessions.
                </Muted>
              </View>
              <Pressable
                onPress={() => setIsPaid(!isPaid)}
                hitSlop={8}
                style={{
                  width: 46,
                  height: 28,
                  borderRadius: 14,
                  backgroundColor: isPaid ? '#D97706' : '#D1D5DB',
                  padding: 2,
                  justifyContent: 'center',
                }}
              >
                <View
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 12,
                    backgroundColor: '#fff',
                    alignSelf: isPaid ? 'flex-end' : 'flex-start',
                  }}
                />
              </Pressable>
            </View>

            {isPaid ? (
              <View style={{ gap: 10, marginTop: 6, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#FDE68A' }}>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Input
                      label="Ticket Price (₹ INR)"
                      value={ticketPrice}
                      onChangeText={setTicketPrice}
                      keyboardType="numeric"
                      placeholder="e.g. 499"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Input
                      label="Max Tickets"
                      value={maxTickets}
                      onChangeText={setMaxTickets}
                      keyboardType="numeric"
                      placeholder="e.g. 10"
                    />
                  </View>
                </View>
                <Input
                  label="Host Payout UPI ID (optional)"
                  value={payoutUpi}
                  onChangeText={setPayoutUpi}
                  placeholder="e.g. yourname@oksbi"
                  autoCapitalize="none"
                />
                <T style={{ fontSize: 11.5, color: '#B45309', fontFamily: F.m, lineHeight: 16 }}>
                  💡 Attendees receive digital entry tickets with unique codes. 90% host payout sent directly to your UPI ID after event completion.
                </T>
              </View>
            ) : null}
          </View>
          ) : null}
          <Input label="Details (optional)" value={desc} onChangeText={setDesc} multiline placeholder="Meeting point, budget, vibe…" maxLength={600} />
          {err ? <T style={{ color: C.danger }}>{err}</T> : null}
        </ScrollView>
        <View style={{ padding: 20, paddingBottom: 28, borderTopWidth: 1, borderTopColor: C.line, backgroundColor: '#fff' }}>
          <Button title="Post plan" disabled={!valid} loading={busy} onPress={submit} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
