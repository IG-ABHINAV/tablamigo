import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSafeEdges } from '../lib/safe-edges';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, H1, Muted, Input, BackButton } from '../components/ui';
import { api } from '../lib/api';
import { COUNTRIES } from '../lib/countries';
import { queryClient } from '../lib/query';
import { C, F, flag } from '../lib/theme';

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export default function Countries() {
  const safeEdges = useSafeEdges();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me') });
  // What is ticked is the person's own edit once they have made one, until then what the server has.
  const [edit, setEdit] = useState<string[] | null>(null); const [q, setQ] = useState(''); const [busy, setBusy] = useState(false);
  const sel: string[] = edit ?? me.data?.countriesVisited ?? [];
  const list = useMemo(() => { const f = fold(q.trim()); return f ? COUNTRIES.filter(([cc, n]) => fold(n).includes(f) || cc.toLowerCase() === f) : COUNTRIES; }, [q]);
  const toggle = (cc: string) => setEdit(sel.includes(cc) ? sel.filter(x => x !== cc) : [...sel, cc]);
  const save = async () => {
    setBusy(true);
    try { await api('/me', { method: 'PATCH', body: { countriesVisited: sel } }); await queryClient.invalidateQueries({ queryKey: ['me'] }); router.back(); } catch { setBusy(false); }
  };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={safeEdges}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8 }}>
        <BackButton />
        <T onPress={busy ? undefined : save} style={{ color: busy ? C.ink3 : C.primary, fontFamily: F.b, fontSize: 16 }}>Save</T>
      </View>
      <View style={{ paddingHorizontal: 20, gap: 12, paddingBottom: 8 }}>
        <View style={{ gap: 2 }}><H1>Countries visited</H1><Muted>🌍 {sel.length} selected</Muted></View>
        <Input value={q} onChangeText={setQ} placeholder="Search countries" autoCorrect={false} />
      </View>
      <FlatList data={list} keyExtractor={c => c[0]} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 60 }}
        renderItem={({ item: [cc, name] }) => {
          const on = sel.includes(cc);
          return (
            <Pressable onPress={() => toggle(cc)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12, paddingHorizontal: 8, borderRadius: 12, backgroundColor: pressed ? C.bgSoft : 'transparent' })}>
              <T style={{ fontSize: 24 }}>{flag(cc)}</T>
              <T style={{ flex: 1, fontFamily: on ? F.b : F.m, fontSize: 16 }}>{name}</T>
              <Ionicons name={on ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={on ? C.primary : C.ink3} />
            </Pressable>
          );
        }} />
    </SafeAreaView>
  );
}
