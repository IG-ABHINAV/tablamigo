import React from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { T, Muted, Avatar, PlusBadge } from './ui';
import { flag, C, F, R } from '../lib/theme';
import { range } from './format';

type Traveler = {
  id: string;
  name: string;
  photoUrl?: string;
  homeCountry?: string;
  startDate: string;
  endDate: string;
  plus?: boolean;
};

export function TripTimeline({
  trip,
  travelers
}: {
  trip: { startDate: string; endDate: string; city: string };
  travelers: Traveler[];
}) {
  if (!travelers.length) return null;

  const myStart = new Date(trip.startDate).getTime();
  const myEnd = new Date(trip.endDate).getTime();

  let minTime = myStart;
  let maxTime = myEnd;

  for (const t of travelers) {
    const s = new Date(t.startDate).getTime();
    const e = new Date(t.endDate).getTime();
    if (s < minTime) minTime = s;
    if (e > maxTime) maxTime = e;
  }

  // Ensure span is at least 1 day
  const totalSpan = Math.max(86400_000, maxTime - minTime);

  const getPercent = (time: number) => {
    return Math.max(0, Math.min(100, ((time - minTime) / totalSpan) * 100));
  };

  const myLeft = getPercent(myStart);
  const myWidth = Math.max(6, getPercent(myEnd) - myLeft);

  const formatShort = (iso: string) => {
    const d = new Date(iso);
    return `${d.getDate()} ${d.toLocaleDateString([], { month: 'short' })}`;
  };

  return (
    <View style={{ width: '100%', backgroundColor: '#fff', borderRadius: R.lg, padding: 16, borderWidth: 1, borderColor: C.line, gap: 14 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <T style={{ fontFamily: F.b, fontSize: 16 }}>🗓️ Overlap Timeline</T>
        <Muted style={{ fontSize: 12 }}>
          {formatShort(trip.startDate)} - {formatShort(trip.endDate)}
        </Muted>
      </View>

      {/* Date Span Header */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4 }}>
        <Muted style={{ fontSize: 11 }}>{formatShort(new Date(minTime).toISOString())}</Muted>
        <Muted style={{ fontSize: 11 }}>{formatShort(new Date(maxTime).toISOString())}</Muted>
      </View>

      {/* Timeline Rows Container */}
      <View style={{ gap: 10, position: 'relative' }}>
        {/* Your Bar */}
        <View style={{ gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.primary }} />
            <T style={{ fontFamily: F.b, fontSize: 13, color: C.ink }}>You in {trip.city}</T>
          </View>
          <View style={{ height: 16, backgroundColor: C.bgSoft, borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
            <View
              style={{
                position: 'absolute',
                left: `${myLeft}%`,
                width: `${myWidth}%`,
                height: '100%',
                backgroundColor: C.primary,
                borderRadius: 8
              }}
            />
          </View>
        </View>

        {/* Gray separator */}
        <View style={{ height: 1, backgroundColor: C.line, marginVertical: 4 }} />

        {/* Travelers Bars */}
        {travelers.map((u) => {
          const tStart = new Date(u.startDate).getTime();
          const tEnd = new Date(u.endDate).getTime();
          const tLeft = getPercent(tStart);
          const tWidth = Math.max(6, getPercent(tEnd) - tLeft);

          // Overlap calculation
          const overlapStart = Math.max(myStart, tStart);
          const overlapEnd = Math.min(myEnd, tEnd);
          const hasOverlap = overlapEnd >= overlapStart;
          const oLeft = hasOverlap ? getPercent(overlapStart) : 0;
          const oWidth = hasOverlap ? Math.max(4, getPercent(overlapEnd) - oLeft) : 0;

          return (
            <Pressable
              key={u.id}
              onPress={() => router.push(`/user/${u.id}`)}
              style={({ pressed }) => ({
                gap: 4,
                paddingVertical: 4,
                opacity: pressed ? 0.7 : 1
              })}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Avatar uri={u.photoUrl} name={u.name} size={22} />
                  <T style={{ fontFamily: F.sb, fontSize: 13 }}>
                    {u.name} {u.homeCountry ? flag(u.homeCountry) : ''}
                  </T>
                  {u.plus ? <PlusBadge /> : null}
                </View>
                <Muted style={{ fontSize: 11 }}>{range(u.startDate, u.endDate)}</Muted>
              </View>

              {/* Bar track */}
              <View style={{ height: 14, backgroundColor: C.bgSoft, borderRadius: 7, overflow: 'hidden', position: 'relative' }}>
                {/* Traveler's total stay */}
                <View
                  style={{
                    position: 'absolute',
                    left: `${tLeft}%`,
                    width: `${tWidth}%`,
                    height: '100%',
                    backgroundColor: '#CBD5E1',
                    borderRadius: 7
                  }}
                />
                {/* Overlap highlighted in amber/primary */}
                {hasOverlap ? (
                  <View
                    style={{
                      position: 'absolute',
                      left: `${oLeft}%`,
                      width: `${oWidth}%`,
                      height: '100%',
                      backgroundColor: '#38BDF8',
                      borderRadius: 7
                    }}
                  />
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, justifyContent: 'center', paddingTop: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: C.primary }} />
          <Muted style={{ fontSize: 11 }}>Your dates</Muted>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#38BDF8' }} />
          <Muted style={{ fontSize: 11 }}>Overlapping days</Muted>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#CBD5E1' }} />
          <Muted style={{ fontSize: 11 }}>Other days</Muted>
        </View>
      </View>
    </View>
  );
}
