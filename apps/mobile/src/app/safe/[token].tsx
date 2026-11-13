import React from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, H1, H2, Muted, Button, Avatar, Empty } from '../../components/ui';
import { MeetingMap } from '../../components/MeetingMap';
import { api, ApiError } from '../../lib/api';
import { COUNTRIES } from '../../lib/countries';
import { C, F, R, flag, shadow } from '../../lib/theme';

export default function SafePlanView() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const q = useQuery({
    queryKey: ['safe-plan', token],
    queryFn: () => api(`/safe/${token}`),
    enabled: !!token
  });

  const data = q.data;

  if (!data) {
    return (
      <SafeAreaView style={{ flex: 1, justifyContent: 'center', backgroundColor: C.bg }}>
        {q.isError ? (
          <Empty
            emoji="🔗"
            title={q.error instanceof ApiError && q.error.status === 404 ? "This link isn't working" : "Couldn't load this plan"}
            body={q.error instanceof ApiError && q.error.status === 404
              ? 'It has expired, or the person who shared it turned it off. Ask them for a new link.'
              : 'Check your connection and try again.'}
          />
        ) : (
          <ActivityIndicator color={C.primary} />
        )}
      </SafeAreaView>
    );
  }

  const { plan, host, sharer, attendees, emergencyNumbers } = data;
  const isHappeningNow = plan.liveStatus === 'happening_now';
  const isCompleted = plan.liveStatus === 'completed';
  const isCancelled = plan.liveStatus === 'cancelled';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bgSoft }} edges={['top']}>
      {/* Top Banner */}
      <View style={{ backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: C.line, paddingHorizontal: 20, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Ionicons name="shield-checkmark" size={24} color={C.primary} />
        <View style={{ flex: 1 }}>
          <T style={{ fontFamily: F.b, fontSize: 16 }}>A plan shared with you</T>
          <Muted style={{ fontSize: 12 }}>Shared by {sharer.name}</Muted>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: 60 }}>
        {/* What this page is: the plan's details, not a location. */}
        <Muted style={{ fontSize: 13, lineHeight: 19 }}>
          This page shows the plan's venue, start time, host and who is going, as they are when you open it. It does not show where {sharer.name} is.
          {data.expiresAt ? ` The link works until ${new Date(data.expiresAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}.` : ''}
        </Muted>

        {/* Status Chip */}
        <View style={{
          backgroundColor: isHappeningNow ? '#ECFDF5' : isCompleted || isCancelled ? '#F3F4F6' : C.primarySoft,
          borderRadius: R.md,
          padding: 12,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          borderWidth: 1,
          borderColor: isHappeningNow ? '#A7F3D0' : isCompleted || isCancelled ? C.line : '#FED7AA'
        }}>
          <T style={{ fontSize: 20 }}>{isHappeningNow ? '🟢' : isCancelled ? '🚫' : isCompleted ? '🏁' : '🗓️'}</T>
          <View style={{ flex: 1 }}>
            <T style={{ fontFamily: F.b, fontSize: 14, color: isHappeningNow ? '#065F46' : isCompleted || isCancelled ? C.ink2 : C.primaryDark }}>
              {isHappeningNow ? 'The meetup is scheduled for now' : isCancelled ? 'This plan was cancelled' : isCompleted ? 'The meetup time has passed' : 'Upcoming meetup'}
            </T>
            <Muted style={{ fontSize: 12 }}>
              {new Date(plan.startsAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </Muted>
          </View>
        </View>

        {/* Sharer message if provided */}
        {sharer.note ? (
          <View style={{ backgroundColor: '#fff', borderRadius: R.md, padding: 14, borderWidth: 1, borderColor: C.line }}>
            <T style={{ fontFamily: F.b, fontSize: 13, color: C.ink2 }}>Note from {sharer.name}:</T>
            <T style={{ fontStyle: 'italic', fontSize: 14, marginTop: 4, color: C.ink }}>{`“${sharer.note}”`}</T>
          </View>
        ) : null}

        {/* Plan Details Card */}
        <View style={[{ backgroundColor: '#fff', borderRadius: R.lg, padding: 20, gap: 12 }, shadow]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 50, height: 50, borderRadius: 16, backgroundColor: C.bgSoft, alignItems: 'center', justifyContent: 'center' }}>
              <T style={{ fontSize: 28 }}>{plan.emoji}</T>
            </View>
            <View style={{ flex: 1 }}>
              <H1 style={{ fontSize: 20 }}>{plan.title}</H1>
              <Muted style={{ fontSize: 13 }}>{plan.city}</Muted>
            </View>
          </View>

          {plan.description ? (
            <T style={{ fontSize: 14, lineHeight: 21, color: C.ink }}>{plan.description}</T>
          ) : null}

          <View style={{ backgroundColor: C.bgSoft, borderRadius: R.md, padding: 12, gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="location" size={16} color={C.primary} />
              <T style={{ fontFamily: F.b, fontSize: 14 }}>{plan.placeName}</T>
            </View>
            {plan.placeAddress ? (
              <Muted style={{ fontSize: 12, marginLeft: 22 }}>{plan.placeAddress}</Muted>
            ) : null}
          </View>

          <Button
            title="Open Venue in Google Maps"
            kind="ghost"
            onPress={() => Linking.openURL(plan.mapUrl)}
            icon={<Ionicons name="map-outline" size={18} color={C.ink} />}
          />
        </View>

        {/* Meeting Location Map */}
        <MeetingMap lat={plan.lat} lng={plan.lng} placeName={plan.placeName} emoji={plan.emoji} />

        {/* Host Info */}
        <View style={[{ backgroundColor: '#fff', borderRadius: R.lg, padding: 16, gap: 10 }, shadow]}>
          <T style={{ fontFamily: F.b, fontSize: 15 }}>Meetup Host</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Avatar uri={host.photoUrl} name={host.name} size={48} cc={host.homeCountry} />
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <T style={{ fontFamily: F.b, fontSize: 16 }}>{host.name}</T>
                {host.verified ? <T style={{ fontSize: 14 }}>✅</T> : null}
              </View>
              <Muted style={{ fontSize: 12 }}>
                {flag(host.homeCountry)} {COUNTRIES.find(c => c[0] === host.homeCountry)?.[1] ?? host.homeCountry}
              </Muted>
            </View>
          </View>
        </View>

        {/* Confirmed Attendees List (nobody is listed for a cancelled plan) */}
        {!isCancelled ? <View style={[{ backgroundColor: '#fff', borderRadius: R.lg, padding: 16, gap: 12 }, shadow]}>
          <T style={{ fontFamily: F.b, fontSize: 15 }}>Confirmed Attendees ({attendees.length})</T>
          {attendees.map((u: any, idx: number) => (
            <View key={idx} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Avatar uri={u.photoUrl} name={u.name} size={40} cc={u.homeCountry} />
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <T style={{ fontFamily: F.sb, fontSize: 14 }}>{u.name}</T>
                  {u.verified ? <T style={{ fontSize: 12 }}>✅</T> : null}
                  {u.checkedIn ? (
                    <View style={{ backgroundColor: '#ECFDF5', paddingHorizontal: 6, paddingVertical: 1, borderRadius: R.sm }}>
                      <T style={{ fontSize: 10, fontFamily: F.b, color: '#059669' }}>📍 Checked in</T>
                    </View>
                  ) : null}
                </View>
                <Muted style={{ fontSize: 11 }}>{flag(u.homeCountry)}</Muted>
              </View>
            </View>
          ))}
        </View> : null}

        {/* Local Emergency Helpline Card */}
        {emergencyNumbers ? (
          <View style={{ backgroundColor: '#FEF2F2', borderRadius: R.lg, padding: 16, borderWidth: 1, borderColor: '#FCA5A5', gap: 10 }}>
            <T style={{ fontFamily: F.b, fontSize: 15, color: '#991B1B' }}>🚨 Local Emergency Numbers ({plan.city})</T>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button
                title={`Police: ${emergencyNumbers.police}`}
                kind="dark"
                onPress={() => Linking.openURL(`tel:${emergencyNumbers.police}`)}
                icon={<Ionicons name="call" size={16} color="#fff" />}
                style={{ flex: 1, backgroundColor: '#DC2626', minHeight: 40 }}
              />
              <Button
                title={`Ambulance: ${emergencyNumbers.ambulance}`}
                kind="dark"
                onPress={() => Linking.openURL(`tel:${emergencyNumbers.ambulance}`)}
                icon={<Ionicons name="medkit" size={16} color="#fff" />}
                style={{ flex: 1, backgroundColor: '#EA580C', minHeight: 40 }}
              />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
