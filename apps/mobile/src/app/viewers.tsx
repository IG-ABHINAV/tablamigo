import React from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, H1, Muted, Avatar, Button, Empty, BackButton } from '../components/ui';
import { api } from '../lib/api';
import { C, F, R } from '../lib/theme';

const ago = (iso: string) => {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3600_000);
  return h < 1 ? 'Just now' : h < 24 ? `${h} h ago` : h < 48 ? 'Yesterday' : `${Math.floor(h / 24)} days ago`;
};

// Free accounts only get a count from the API, so the faces here are placeholders, not blurred real photos.
function Locked({ count }: { count: number }) {
  return (
    <View style={{ padding: 20, gap: 18 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'center' }}>
        {Array.from({ length: Math.min(count, 8) }, (_, i) => (
          <View key={i} style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: ['#FFD5DC', '#C0AEDE', '#D1D4F9', '#B6E3F4', '#FFDFBF', '#C9F2E4'][i % 6], alignItems: 'center', justifyContent: 'center', opacity: 0.8 }}>
            <Ionicons name="person" size={30} color="rgba(22,22,29,0.25)" />
          </View>
        ))}
      </View>
      <View style={{ padding: 18, borderRadius: R.lg, backgroundColor: C.bgSoft, gap: 12, alignItems: 'center' }}>
        <T style={{ fontFamily: F.b, fontSize: 16, textAlign: 'center' }}>See who they are with Plus</T>
        <Muted style={{ textAlign: 'center' }}>Names, photos and when they looked, for the last 30 days.</Muted>
        <Button title="Get Tablamigo Plus" onPress={() => router.push('/paywall')} style={{ alignSelf: 'stretch' }} />
      </View>
    </View>
  );
}

export default function Viewers() {
  const q = useQuery({ queryKey: ['viewers'], queryFn: () => api('/me/viewers') });
  const d = q.data;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
        <BackButton />
      </View>
      <View style={{ paddingHorizontal: 20, gap: 2, paddingBottom: 10 }}>
        <H1>{d ? `${d.count} profile view${d.count === 1 ? '' : 's'}` : '…'}</H1><Muted>People who opened your profile in the last 30 days</Muted>
      </View>
      {d?.locked && d.count ? <Locked count={d.count} /> : (
        <FlatList data={d?.viewers ?? []} keyExtractor={(v: any) => v.id} contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 60 }}
          ListEmptyComponent={q.isLoading ? null : <Empty emoji="👀" title="No views yet" body="Join or post a plan. People check out who's going." />}
          renderItem={({ item: v }: any) => (
            <Pressable onPress={() => router.push(`/user/${v.id}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: R.lg, backgroundColor: '#fff', borderWidth: 1, borderColor: C.line }}>
              <Avatar uri={v.photoUrl} name={v.name} size={54} cc={v.homeCountry} />
              <View style={{ flex: 1, gap: 2 }}>
                <T style={{ fontFamily: F.b, fontSize: 16 }}>{v.name} {v.verified ? '✅' : ''}</T>
                <Muted style={{ fontSize: 13 }}>{ago(v.viewedAt)}</Muted>
              </View>
              <Ionicons name="chevron-forward" size={18} color={C.ink3} />
            </Pressable>
          )} />
      )}
    </SafeAreaView>
  );
}
