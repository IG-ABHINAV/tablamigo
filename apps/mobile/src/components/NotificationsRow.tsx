import React, { useEffect, useState } from 'react';
import { AppState, Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { T, Muted } from './ui';
import { notificationState, fixNotifications, syncNotifications, type NotificationState } from '../lib/push';
import { notificationsRow } from '../lib/push-policy';
import { C, F, R } from '../lib/theme';

/**
 * Profile > Notifications: whether this phone (or browser) lets Tablamigo notify, and one button that asks again while it
 * still can or opens the phone's settings when it cannot (QA 1 Nov 2026: after "Don't allow" there was no way back from
 * inside the app). Re-read whenever the app comes back to the front, e.g. from the phone's settings.
 */
export function NotificationsRow() {
  const [state, setState] = useState<NotificationState | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => syncNotifications().then(s => { if (live) setState(s); }).catch(() => {});
    read();
    const sub = AppState.addEventListener('change', st => { if (st === 'active') read(); });
    return () => { live = false; sub.remove(); };
  }, []);
  if (!state) return null;
  const row = notificationsRow(state, Platform.OS === 'web');
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 11, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: C.line }}>
      <Ionicons name={state === 'on' ? 'notifications-outline' : 'notifications-off-outline'} size={21} color={C.ink2} />
      <View style={{ flex: 1 }}>
        <T style={{ fontFamily: F.sb }}>Notifications · {row.detail}</T>
        <Muted style={{ fontSize: 12 }}>{row.note}</Muted>
      </View>
      {row.button ? <Pressable accessibilityRole="button" accessibilityLabel={`Notifications ${row.detail}. ${row.button}`}
        onPress={() => { fixNotifications().then(setState).catch(() => {}); }}
        style={{ paddingHorizontal: 12, minHeight: 36, justifyContent: 'center', borderRadius: R.pill, backgroundColor: state === 'on' ? C.bgSoft : C.primary }}>
        <T style={{ fontFamily: F.b, fontSize: 13, color: state === 'on' ? C.ink : '#fff' }}>{row.button}</T>
      </Pressable> : null}
    </View>
  );
}
