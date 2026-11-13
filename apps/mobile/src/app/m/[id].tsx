import React, { useState } from 'react';
import { ActivityIndicator, Image, Linking, Platform, Pressable, ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, H1, Muted, Button, Avatar, Empty, BackButton } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { ReportButton } from '../../components/ReportButton';
import { PhotoViewer } from '../../components/PhotoViewer';
import { momentPhoto, placeRoute } from '../../lib/photo-viewer';
import { C, F, R, flag } from '../../lib/theme';

export default function MomentPublicView() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // Anyone can open this page, signed in or not. Only a signed-in viewer can report (the API needs an account for it).
  const signedIn = !!useSession(s => s.tokens);
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me'), enabled: signedIn });
  const [viewing, setViewing] = useState(false);

  const q = useQuery({
    queryKey: ['moment-public', id],
    queryFn: () => api(`/moments/${id}`),
    enabled: !!id,
  });

  const data = q.data;

  if (!data) {
    return (
      <SafeAreaView style={{ flex: 1, justifyContent: 'center', backgroundColor: C.bgSoft }}>
        {q.isError ? (
          <Empty
            emoji="📸"
            title="Moment Not Found"
            body={q.error instanceof ApiError && q.error.status === 404
              ? 'This moment may have been deleted.'
              : 'Could not load moment. Check your connection.'}
            action={<Button title="Open Tablamigo" onPress={() => router.replace('/(tabs)/feed' as any)} style={{ marginTop: 14 }} />}
          />
        ) : (
          <ActivityIndicator color={C.primary} />
        )}
      </SafeAreaView>
    );
  }

  const { moment: m, comments = [] } = data;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bgSoft }} edges={['top']}>
      {/* Top Bar */}
      <View style={{ backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: C.line, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <BackButton fallback={'/(tabs)/feed' as any} />
        <T style={{ fontFamily: F.b, fontSize: 16 }}>Travel Moment</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 26, justifyContent: 'flex-end' }}>
          {signedIn && me.data && m.userId !== me.data.id ? <ReportButton target={{ type: 'moment', id: m.id, userId: m.userId, userName: m.userName }} size={20} color={C.ink2} /> : null}
          {/* "Get App" is for someone reading this link in a browser. Inside the app they already have it. */}
          {Platform.OS === 'web' ? (
            <Button
              title="Get App"
              onPress={() => Linking.openURL('https://tablamigo.hookstep.in/download')}
              style={{ paddingHorizontal: 12, paddingVertical: 6, height: 32 }}
            />
          ) : null}
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 60 }}>
        {/* Moment Card */}
        <View style={{ backgroundColor: '#fff', borderRadius: R.lg, overflow: 'hidden', borderWidth: 1, borderColor: C.line, gap: 12 }}>
          {/* Author Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 16 }}>
            <Pressable disabled={!signedIn} accessibilityRole="link" accessibilityLabel={`Open ${m.userName}'s profile`} onPress={() => router.push(`/user/${m.userId}`)}>
              <Avatar uri={m.userPhoto} name={m.userName} size={46} cc={m.userCountry} />
            </Pressable>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                <T style={{ fontFamily: F.b, fontSize: 16 }}>{m.userName}</T>
                {m.userCountry ? <T style={{ fontSize: 13 }}>{flag(m.userCountry)}</T> : null}
                {m.userVerified ? <T style={{ fontSize: 12 }}>✅</T> : null}
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
                {m.city && signedIn && placeRoute(m.city, m.countryCode) ? (
                  <Pressable accessibilityRole="link" accessibilityLabel={`Open ${m.city}`} hitSlop={6} onPress={() => router.push(placeRoute(m.city, m.countryCode) as any)}>
                    <Muted style={{ fontSize: 12.5, color: C.primaryDark, fontFamily: F.sb }}>📍 {m.city}</Muted>
                  </Pressable>
                ) : m.city ? <Muted style={{ fontSize: 12.5 }}>📍 {m.city}</Muted> : null}
                <Muted style={{ fontSize: 12.5 }}>
                  {m.city ? ' · ' : ''}{new Date(m.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                </Muted>
              </View>
            </View>
          </View>

          {/* Photo */}
          {m.imageUrl ? (
            <Pressable accessibilityRole="imagebutton" accessibilityLabel={`Open ${m.userName}'s photo`} onPress={() => setViewing(true)}
              style={{ width: '100%', height: 320, backgroundColor: C.bgSoft }}>
              <Image source={{ uri: m.imageUrl }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
            </Pressable>
          ) : null}

          {/* Caption & Category */}
          <View style={{ paddingHorizontal: 16, gap: 6 }}>
            {m.category && m.category !== 'general' ? (
              <View style={{ alignSelf: 'flex-start', backgroundColor: C.primarySoft, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
                <T style={{ fontSize: 11, fontFamily: F.b, color: C.primaryDark, textTransform: 'capitalize' }}>
                  {m.category}
                </T>
              </View>
            ) : null}
            <T style={{ fontSize: 15, color: C.ink, lineHeight: 22 }}>{m.caption}</T>
          </View>

          {/* Counts */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 16, paddingBottom: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="heart" size={20} color="#EF4444" />
              <T style={{ fontSize: 13, fontFamily: F.sb, color: C.ink2 }}>{m.likesCount} likes</T>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="chatbubble-outline" size={18} color={C.ink2} />
              <T style={{ fontSize: 13, fontFamily: F.sb, color: C.ink2 }}>{comments.length} comments</T>
            </View>
          </View>
        </View>

        {/* Join CTA card: only for someone who isn't signed in. It opens sign-up in this same app (web or Android). */}
        {!signedIn ? (
          <View style={{ backgroundColor: C.primarySoft, padding: 18, borderRadius: R.lg, gap: 10, alignItems: 'center', borderWidth: 1, borderColor: '#FED7AA' }}>
            <T style={{ fontSize: 24 }}>🧭</T>
            <T style={{ fontFamily: F.b, fontSize: 17, textAlign: 'center' }}>Traveling to {m.city || 'this area'}?</T>
            <T style={{ color: C.ink2, fontSize: 13.5, textAlign: 'center', lineHeight: 19 }}>
              Join solo travelers and digital nomads on Tablamigo. Share plans, meet for dinner, and explore together.
            </T>
            <Button
              title="Join on Tablamigo, free"
              onPress={() => router.push('/(auth)/welcome')}
              style={{ width: '100%', marginTop: 4 }}
            />
          </View>
        ) : null}

        {/* Comments Section */}
        {comments.length > 0 ? (
          <View style={{ backgroundColor: '#fff', borderRadius: R.lg, padding: 16, gap: 12, borderWidth: 1, borderColor: C.line }}>
            <T style={{ fontFamily: F.b, fontSize: 15 }}>Comments</T>
            {comments.map((c: any) => (
              <View key={c.id} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                <Avatar uri={c.userPhoto} name={c.userName} size={32} />
                <View style={{ flex: 1, backgroundColor: C.bgSoft, padding: 8, borderRadius: R.md }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <T style={{ fontFamily: F.b, fontSize: 12.5 }}>{c.userName}</T>
                    {c.userVerified ? <T style={{ fontSize: 10 }}>✅</T> : null}
                    {signedIn && me.data && c.userId !== me.data.id ? <View style={{ marginLeft: 'auto' }}><ReportButton target={{ type: 'moment_comment', id: c.id, userId: c.userId, userName: c.userName }} size={15} /></View> : null}
                  </View>
                  <T style={{ fontSize: 13, color: C.ink, marginTop: 2 }}>{c.body}</T>
                </View>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
      {m.imageUrl ? <PhotoViewer photos={[momentPhoto(m)]} index={viewing ? 0 : null} onClose={() => setViewing(false)} links={signedIn} /> : null}
    </SafeAreaView>
  );
}
