import React from 'react';
import { Image, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, Muted } from './ui';
import { api } from '../lib/api';
import { C, F, R } from '../lib/theme';

export function UserTimeline({ userId, isSelf = false }: { userId: string; isSelf?: boolean }) {
  const q = useQuery({
    queryKey: ['timeline', userId],
    queryFn: () => api(`/users/${userId}/timeline`)
  });

  const data = q.data;
  if (!data) return null;

  const items: any[] = data.timeline ?? [];
  const stats = data.stats ?? {};

  return (
    <View style={{ width: '100%', gap: 16 }}>
      {/* Stats summary banner */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
        <View style={{ minWidth: 95, padding: 10, borderRadius: R.md, backgroundColor: C.bgSoft, alignItems: 'center' }}>
          <T style={{ fontFamily: F.xb, fontSize: 18 }}>{stats.tripsCount ?? 0}</T>
          <Muted style={{ fontSize: 11 }}>✈️ Trips</Muted>
        </View>
        <View style={{ minWidth: 95, padding: 10, borderRadius: R.md, backgroundColor: C.bgSoft, alignItems: 'center' }}>
          <T style={{ fontFamily: F.xb, fontSize: 18 }}>{(stats.plansHostedCount ?? 0) + (stats.plansJoinedCount ?? 0)}</T>
          <Muted style={{ fontSize: 11 }}>📍 Meetups</Muted>
        </View>
        <View style={{ minWidth: 95, padding: 10, borderRadius: R.md, backgroundColor: C.bgSoft, alignItems: 'center' }}>
          <T style={{ fontFamily: F.xb, fontSize: 18 }}>{stats.vouchesCount ?? 0}</T>
          <Muted style={{ fontSize: 11 }}>👍 Thumbs-up</Muted>
        </View>
      </View>

      {data.planHistoryHidden ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: R.md, backgroundColor: C.bgSoft, justifyContent: 'center' }}>
          <Ionicons name="lock-closed-outline" size={16} color={C.ink2} />
          <Muted style={{ fontSize: 13 }}>Meetup plan history is private</Muted>
        </View>
      ) : null}

      {/* Timeline entries */}
      <View style={{ width: '100%', paddingLeft: 8, gap: 16 }}>
        {items.map((item, idx) => {
          const isPlan = item.kind === 'plan';
          const isTrip = item.kind === 'trip';
          const planId = isPlan ? item.id.replace('plan-', '') : null;

          return (
            <View key={item.id || String(idx)} style={{ flexDirection: 'row', gap: 14 }}>
              {/* Timeline marker with connector line */}
              <View style={{ alignItems: 'center', width: 28 }}>
                <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: isTrip ? '#E0F2FE' : isPlan ? C.primarySoft : '#FEF3C7', alignItems: 'center', justifyContent: 'center' }}>
                  <T style={{ fontSize: 14 }}>{item.emoji || '✨'}</T>
                </View>
                {idx < items.length - 1 ? (
                  <View style={{ width: 2, flex: 1, backgroundColor: C.line, marginVertical: 4 }} />
                ) : null}
              </View>

              {/* Timeline card */}
              <Pressable
                disabled={!isPlan}
                onPress={() => isPlan && planId && router.push(`/activity/${planId}`)}
                style={{ flex: 1, backgroundColor: '#fff', padding: 14, borderRadius: R.md, borderWidth: 1, borderColor: C.line, gap: 6, marginBottom: 4 }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <T numberOfLines={1} style={{ flex: 1, fontFamily: F.b, fontSize: 15 }}>{item.title}</T>
                  {item.date ? (
                    <Muted style={{ fontSize: 11 }}>{new Date(item.date).toLocaleDateString([], { month: 'short', year: 'numeric' })}</Muted>
                  ) : null}
                </View>

                {item.subtitle ? <Muted style={{ fontSize: 13 }}>{item.subtitle}</Muted> : null}

                {/* Plan album photos preview */}
                {isPlan && item.photos?.length ? (
                  <View style={{ flexDirection: 'row', gap: 6, marginTop: 4 }}>
                    {item.photos.slice(0, 3).map((p: any) => (
                      <Image key={p.id} source={{ uri: p.url }} style={{ width: 60, height: 60, borderRadius: R.sm }} resizeMode="cover" />
                    ))}
                    {item.photos.length > 3 ? (
                      <View style={{ width: 60, height: 60, borderRadius: R.sm, backgroundColor: C.bgSoft, alignItems: 'center', justifyContent: 'center' }}>
                        <T style={{ fontFamily: F.b, fontSize: 12, color: C.ink2 }}>+{item.photos.length - 3}</T>
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </Pressable>
            </View>
          );
        })}
      </View>
    </View>
  );
}
