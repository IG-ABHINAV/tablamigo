import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, View, ActivityIndicator } from 'react-native';
import { ConnectSheet, firstName } from './ConnectSheet';
import { router } from 'expo-router';
import { useQuery, useMutation } from '@tanstack/react-query';
import { T, H2, Muted, Avatar, Button, Chip } from './ui';
import { api, ApiError } from '../lib/api';
import { queryClient } from '../lib/query';
import { useOpenDm } from '../lib/dm';
import { C, F, R, flag, shadow, travelStyleLabel } from '../lib/theme';
import { range } from './format';

export type Companion = {
  id: string;
  name: string;
  photoUrl?: string | null;
  homeCountry: string;
  age?: number | null;
  verified?: boolean;
  plus?: boolean;
  startDate: string;
  endDate: string;
  overlapDays: number;
  matchScore: number;
  matchingStyles: string[];
  matchingInterests: string[];
  languages: string[];
  requestStatus: 'none' | 'sent' | 'received' | 'connected';
};

export function TripSuggestedCompanions({
  tripId,
  city
}: {
  tripId: string;
  city: string;
}) {
  const { openDm, openingId, dmSheet } = useOpenDm();
  const [selectedCompanion, setSelectedCompanion] = useState<Companion | null>(null);
  const [introNote, setIntroNote] = useState('');

  const q = useQuery({
    queryKey: ['trip-buddies', tripId],
    queryFn: () => api<{ companions: Companion[] }>(`/trips/${tripId}/buddies`),
    enabled: !!tripId
  });

  const sendRequest = useMutation({
    mutationFn: async ({ recipientId, note }: { recipientId: string; note?: string }) => {
      return api(`/trips/${tripId}/buddy-requests`, {
        method: 'POST',
        body: { recipientId, introNote: note || undefined }
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trip-buddies', tripId] });
      setSelectedCompanion(null);
      setIntroNote('');
      Alert.alert('Invite Sent! ✈️', 'They will receive your travel buddy request in their inbox.');
    },
    // Other errors show inside the sheet, under the note, so what was typed isn't lost.
    onError: (e: any) => {
      if (e instanceof ApiError && e.code === 'plus_required') {
        setSelectedCompanion(null);
        router.push('/paywall?reason=buddy_requests_limit');
      }
    }
  });

  const companions = q.data?.companions ?? [];

  if (q.isLoading) {
    return (
      <View style={{ paddingVertical: 12, alignItems: 'center' }}>
        <ActivityIndicator color={C.primary} />
      </View>
    );
  }

  if (!companions.length) return null;

  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View>
          <H2>✨ Suggested Travel Buddies</H2>
          <Muted style={{ fontSize: 13, marginTop: 2 }}>
            Ranked by shared vibe & overlapping dates in {city}
          </Muted>
        </View>
        <View style={{ backgroundColor: C.primarySoft, paddingHorizontal: 10, paddingVertical: 4, borderRadius: R.pill }}>
          <T style={{ fontFamily: F.b, fontSize: 12, color: C.primaryDark }}>{companions.length} matches</T>
        </View>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14 }}>
        {companions.map(c => {
          const isHighMatch = c.matchScore >= 80;
          return (
            <View
              key={c.id}
              style={[
                {
                  width: 260,
                  backgroundColor: '#fff',
                  borderRadius: R.lg,
                  padding: 16,
                  borderWidth: 1,
                  borderColor: isHighMatch ? '#34D399' : C.line,
                  gap: 12
                },
                shadow
              ]}
            >
              {/* Header: Avatar, Name, Age, Country */}
              <Pressable
                onPress={() => router.push(`/user/${c.id}`)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
              >
                <Avatar uri={c.photoUrl} name={c.name} size={48} cc={c.homeCountry} />
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <T style={{ fontFamily: F.b, fontSize: 16, flexShrink: 1 }} numberOfLines={1}>{c.name}{c.age ? `, ${c.age}` : ''}</T>
                    {c.verified ? <T style={{ fontSize: 12 }}>✅</T> : null}
                  </View>
                  <Muted style={{ fontSize: 12 }}>
                    {flag(c.homeCountry)} · {c.languages[0] || 'English'}
                  </Muted>
                </View>
              </Pressable>

              {/* Match Score Badge */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: isHighMatch ? '#ECFDF5' : C.bgSoft, paddingHorizontal: 10, paddingVertical: 6, borderRadius: R.md }}>
                <T style={{ fontFamily: F.b, fontSize: 13, color: isHighMatch ? '#065F46' : C.ink }}>
                  ✨ {c.matchScore}% Match
                </T>
                <Muted style={{ fontSize: 12, fontFamily: F.sb }}>
                  {c.overlapDays} {c.overlapDays === 1 ? 'day' : 'days'} overlap
                </Muted>
              </View>

              {/* Shared Styles & Interests */}
              <View style={{ gap: 6 }}>
                {c.matchingStyles.length ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                    {c.matchingStyles.slice(0, 3).map(s => (
                      <View key={s} style={{ backgroundColor: C.primarySoft, paddingHorizontal: 8, paddingVertical: 3, borderRadius: R.pill }}>
                        <T style={{ fontSize: 11, fontFamily: F.sb, color: C.primaryDark }}>
                          {travelStyleLabel(s)}
                        </T>
                      </View>
                    ))}
                  </View>
                ) : null}

                {c.matchingInterests.length ? (
                  <Muted style={{ fontSize: 12 }} numberOfLines={1}>
                    Both like: {c.matchingInterests.join(', ')}
                  </Muted>
                ) : null}
              </View>

              {/* Action Buttons */}
              <View style={{ marginTop: 'auto' }}>
                {c.requestStatus === 'connected' ? (
                  <Button
                    title="Message 💬"
                    kind="go"
                    style={{ height: 38 }}
                    loading={openingId === c.id}
                    onPress={() => openDm(c.id)}
                  />
                ) : c.requestStatus === 'sent' ? (
                  <Button
                    title="Invite Pending ⏳"
                    kind="ghost"
                    disabled
                    style={{ height: 38 }}
                  />
                ) : c.requestStatus === 'received' ? (
                  <Button
                    title="Respond 🤝"
                    kind="primary"
                    style={{ height: 38 }}
                    onPress={() => router.push('/connections')}
                  />
                ) : (
                  <Button
                    title="Connect & Travel 🤝"
                    kind="primary"
                    style={{ height: 38 }}
                    onPress={() => {
                      setSelectedCompanion(c);
                      setIntroNote(`Hey ${firstName(c.name)}, saw we're both in ${city} around the same time. Would love to explore together!`);
                    }}
                  />
                )}
              </View>
            </View>
          );
        })}
      </ScrollView>

      <ConnectSheet
        person={selectedCompanion}
        onClose={() => { setSelectedCompanion(null); sendRequest.reset(); }}
        initialNote={introNote}
        intro={selectedCompanion ? `A travel buddy request for ${city}. When ${firstName(selectedCompanion.name)} accepts, you're connected and a chat opens.` : undefined}
        sendLabel="Send buddy request"
        sending={sendRequest.isPending}
        error={sendRequest.error && !(sendRequest.error instanceof ApiError && sendRequest.error.code === 'plus_required')
          ? (sendRequest.error instanceof ApiError ? sendRequest.error.message : 'Check your connection and try again.') : null}
        onSend={note => selectedCompanion && sendRequest.mutate({ recipientId: selectedCompanion.id, note })}
      />
      {dmSheet}
    </View>
  );
}
