import React, { useCallback } from 'react';
import { AppState, Pressable, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T } from './ui';
import { api, ApiError } from '../lib/api';
import { C, F, shadow } from '../lib/theme';

/** Round bell with an unread badge. No badge if the inbox API isn't there. */
export function MapBell() {
  const unread = useQuery({
    queryKey: ['inbox', 'unread'],
    queryFn: () => api<{ count: number }>('/inbox/unread'),
    refetchInterval: 60_000,
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 1,
  });
  const { refetch } = unread;
  useFocusEffect(useCallback(() => {
    refetch();
    const sub = AppState.addEventListener('change', s => { if (s === 'active') refetch(); });
    return () => sub.remove();
  }, [refetch]));
  const n = unread.data?.count ?? 0;
  return (
    <Pressable onPress={() => router.push('/inbox')} hitSlop={6} accessibilityLabel={n ? `Notifications, ${n} unread` : 'Notifications'}
      style={[{ width: 46, height: 46, borderRadius: 23, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' }, shadow]}>
      <Ionicons name="notifications-outline" size={22} color={C.ink} />
      {n > 0 ? <View style={{ position: 'absolute', top: 4, right: 3, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, backgroundColor: C.primary, borderWidth: 2, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' }}>
        <T style={{ color: '#fff', fontFamily: F.b, fontSize: 10, lineHeight: 12 }}>{n > 99 ? '99+' : n}</T>
      </View> : null}
    </Pressable>
  );
}
