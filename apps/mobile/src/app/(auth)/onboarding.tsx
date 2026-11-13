import React, { useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, View, KeyboardAvoidingView, type TextInput } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSafeEdges } from '../../lib/safe-edges';
import { useQuery } from '@tanstack/react-query';
import { H1, Muted, Button, Input, T, Chip, Avatar, BackButton } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { ageOn, birthdateHint, isCalendarDate } from '../../lib/birthdate';
import { pickAndUpload } from '../../lib/upload';
import { useLocation } from '../../lib/location';
import { COUNTRIES } from '../../lib/countries';
import { queryClient } from '../../lib/query';
import { LANGUAGES, toggleLanguage } from '../../lib/languages';
import { HEARD_FROM_OPTIONS, saveHeardFrom, type HeardFrom } from '../../lib/heard-from';
import { C, F, R, flag, interestLabel, interestEmoji } from '../../lib/theme';

const STEPS = ['name', 'birthday', 'gender', 'country', 'photo', 'interests', 'heard', 'location'] as const;

export default function Onboarding() {
  const safeEdges = useSafeEdges();
  const [step, setStep] = useState(0);
  // Google sign-in already knows a first name: start from it until the person types their own.
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me') });
  const [typedName, setName] = useState<string | null>(null); const name = typedName ?? me.data?.name ?? '';
  const [dob, setDob] = useState({ d: '', m: '', y: '' });
  // The birthday boxes move on by themselves: two digits of day go to the month box, two of month to the year box.
  const monthBox = useRef<TextInput>(null); const yearBox = useRef<TextInput>(null);
  const [gender, setGender] = useState<string>(''); const [cc, setCc] = useState(''); const [q, setQ] = useState('');
  const [photo, setPhoto] = useState<string | null>(null); const [interests, setInterests] = useState<string[]>([]); const [langs, setLangs] = useState<string[]>(['English']);
  const [heard, setHeard] = useState<HeardFrom | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api('/meta') });
  const locate = useLocation(s => s.locate);
  const cur = STEPS[step];
  const birthdate = `${dob.y.padStart(4, '0')}-${dob.m.padStart(2, '0')}-${dob.d.padStart(2, '0')}`;
  const age = useMemo(() => ageOn(birthdate), [birthdate]);
  const dobHint = birthdateHint(dob);
  const valid = { name: name.trim().length > 0, birthday: dob.y.length === 4 && isCalendarDate(birthdate) && age >= 18 && age < 100, gender: !!gender, country: !!cc, photo: true, interests: interests.length >= 3, heard: true, location: true }[cur];
  const countries = useMemo(() => COUNTRIES.filter(([c, n]) => !q || n.toLowerCase().includes(q.toLowerCase()) || c.toLowerCase() === q.toLowerCase()), [q]);

  const next = async () => {
    setErr('');
    if (cur === 'birthday' && !isCalendarDate(birthdate)) { setErr(dobHint || "That date doesn't exist. Enter the day, then the month, then the year."); return; }
    if (cur === 'birthday' && age < 18) { setErr('You must be 18 or older to use this app.'); return; }
    if (cur === 'interests') {
      setBusy(true);
      try { await api('/me', { method: 'PATCH', body: { name: name.trim(), birthdate, gender, homeCountry: cc, photoUrl: photo, interests, languages: langs } }); }
      catch (e) {
        setErr(e instanceof ApiError ? e.message : 'Could not save.'); setBusy(false);
        // The server refused the birthday: go back to that step with the message, instead of a dead end four steps later.
        if (e instanceof ApiError && (e.code === 'invalid_birthdate' || e.code === 'under_18')) setStep(STEPS.indexOf('birthday'));
        return;
      }
      setBusy(false);
    }
    // A first GPS fix can take a while (10 s on the QA emulator, longer indoors) and the button used to sit there with no sign of
    // life: it now spins, and after 12 s the next screen opens anyway (the app keeps looking for the location on its own).
    // Then the "what now" screen (app/start.tsx): a trip or a plan near you, instead of landing on an empty map.
    if (cur === 'location') { setBusy(true); await Promise.race([locate().catch(() => {}), new Promise(r => setTimeout(r, 12_000))]); await queryClient.invalidateQueries({ queryKey: ['me'] }); setBusy(false); router.replace('/start'); return; }
    setStep(s => s + 1);
  };
  // "How did you hear about us?": one tap answers and moves on; the button below is Skip. Saved in the background.
  const answerHeard = (source: HeardFrom) => { setHeard(source); void saveHeardFrom(api, source); setErr(''); setStep(s => s + 1); };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={safeEdges}>
      <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 24, paddingTop: 12 }}>
        {STEPS.map((_, i) => <View key={i} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i <= step ? C.primary : C.line }} />)}
      </View>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, padding: 24, gap: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 32 }}>
          {step > 0 ? <BackButton onPress={() => setStep(s => s - 1)} /> : <View />}
          <Muted style={{ fontSize: 13, fontFamily: F.sb }}>Step {step + 1} of {STEPS.length}</Muted>
        </View>
        {cur === 'name' && <><H1>What should travelers call you?</H1><Input autoFocus value={name} onChangeText={setName} placeholder="First name" maxLength={40} autoCapitalize="words" />
          <T style={{ fontFamily: F.b, fontSize: 16, marginTop: 8 }}>Languages you speak</T>
          <ScrollView style={{ flexGrow: 0, maxHeight: 300 }} contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} keyboardShouldPersistTaps="handled">
            {LANGUAGES.map(l => <Chip key={l} label={l} active={langs.includes(l)} onPress={() => setLangs(v => toggleLanguage(v, l))} />)}
          </ScrollView></>}
        {cur === 'birthday' && <><H1>When's your birthday?</H1><Muted>Only your age is shown. You must be 18+.</Muted>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Input autoFocus accessibilityLabel="Day of birth" style={{ width: 80, textAlign: 'center' }} value={dob.d} onChangeText={t => { const d = t.replace(/\D/g, ''); setDob(v => ({ ...v, d })); if (d.length === 2) monthBox.current?.focus(); }} placeholder="DD" maxLength={2} keyboardType="number-pad" />
            <Input ref={monthBox} accessibilityLabel="Month of birth" style={{ width: 80, textAlign: 'center' }} value={dob.m} onChangeText={t => { const m = t.replace(/\D/g, ''); setDob(v => ({ ...v, m })); if (m.length === 2) yearBox.current?.focus(); }} placeholder="MM" maxLength={2} keyboardType="number-pad" />
            <Input ref={yearBox} accessibilityLabel="Year of birth" style={{ width: 120, textAlign: 'center' }} value={dob.y} onChangeText={y => setDob(v => ({ ...v, y: y.replace(/\D/g, '') }))} placeholder="YYYY" maxLength={4} keyboardType="number-pad" />
          </View>
          <Muted>Day, month, year.{dobHint ? ` ${dobHint}` : ''}</Muted></>}
        {cur === 'gender' && <><H1>How do you identify?</H1><Muted>Used for women-only activities. Never shown publicly.</Muted>
          {[['woman', 'Woman'], ['man', 'Man'], ['nonbinary', 'Non-binary'], ['unspecified', 'Prefer not to say']].map(([k, l]) =>
            <Pressable key={k} onPress={() => setGender(k)} style={{ height: 58, borderRadius: R.md, borderWidth: 2, borderColor: gender === k ? C.primary : C.line, justifyContent: 'center', paddingHorizontal: 18, backgroundColor: gender === k ? C.primarySoft : '#fff' }}>
              <T style={{ fontFamily: F.b, fontSize: 16 }}>{l}</T></Pressable>)}</>}
        {cur === 'country' && <><H1>Where are you from?</H1><Input value={q} onChangeText={setQ} placeholder="Search countries" />
          <FlatList data={countries} keyExtractor={c => c[0]} style={{ flex: 1 }} keyboardShouldPersistTaps="handled"
            renderItem={({ item: [c, n] }) => <Pressable onPress={() => setCc(c)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 8, borderRadius: R.sm, backgroundColor: cc === c ? C.primarySoft : 'transparent' }}>
              <T style={{ fontSize: 22 }}>{flag(c)}</T><T style={{ fontFamily: cc === c ? F.b : F.m, fontSize: 16 }}>{n}</T></Pressable>} /></>}
        {cur === 'photo' && <><H1>Add a photo</H1><Muted>Plans with a face get joined far more often. You can skip this.</Muted>
          <Pressable accessibilityRole="button" accessibilityLabel={photo ? 'Change photo' : 'Add a photo'} onPress={async () => { try { const u = await pickAndUpload('avatar'); if (u) setPhoto(u); } catch { setErr('Upload failed, try again.'); } }} style={{ alignSelf: 'center', marginTop: 24 }}>
            <Avatar uri={photo} name={name} size={160} />
            <View style={{ position: 'absolute', right: 6, bottom: 6, width: 44, height: 44, borderRadius: 22, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#fff' }}><T style={{ color: '#fff', fontSize: 22, fontFamily: F.b }}>+</T></View>
          </Pressable></>}
        {cur === 'interests' && <><H1>What are you into?</H1><Muted>Pick at least 3. We use these to show people you'll click with.</Muted>
          <ScrollView contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {(meta.data?.interests ?? []).map((i: string) => <Chip key={i} label={interestLabel(i)} emoji={interestEmoji(i)} active={interests.includes(i)} onPress={() => setInterests(v => v.includes(i) ? v.filter(x => x !== i) : v.length < 12 ? [...v, i] : v)} />)}
          </ScrollView></>}
        {cur === 'heard' && <><H1>How did you hear about us?</H1><Muted>One tap. It tells us where to find more travelers like you.</Muted>
          <ScrollView contentContainerStyle={{ gap: 10 }}>
            {HEARD_FROM_OPTIONS.map(([k, l]) =>
              <Pressable key={k} accessibilityRole="button" accessibilityLabel={l} onPress={() => answerHeard(k)} style={{ minHeight: 52, borderRadius: R.md, borderWidth: 2, borderColor: heard === k ? C.primary : C.line, justifyContent: 'center', paddingHorizontal: 18, backgroundColor: heard === k ? C.primarySoft : '#fff' }}>
                <T style={{ fontFamily: F.b, fontSize: 16 }}>{l}</T></Pressable>)}
          </ScrollView></>}
        {cur === 'location' && <><H1>See plans around you</H1><Muted style={{ lineHeight: 21 }}>We use your location to show nearby plans and travelers. Plans show a rounded distance. If you choose to share live location in a chat, people in that chat see your exact position until you stop or it expires.</Muted>
          <T style={{ fontSize: 90, textAlign: 'center', marginTop: 30 }}>🗺️</T></>}
        {err ? <T style={{ color: C.danger }}>{err}</T> : null}
        {cur !== 'country' && cur !== 'interests' && cur !== 'heard' ? <View style={{ flex: 1 }} /> : null}
        {cur === 'heard'
          ? <Button title="Skip" kind="ghost" onPress={() => answerHeard('skipped')} />
          : <Button title={cur === 'location' ? 'Enable location' : cur === 'photo' && !photo ? 'Skip for now' : 'Continue'} disabled={!valid} loading={busy} onPress={next} />}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
