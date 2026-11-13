import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ModalSheet } from './ModalSheet';
import { T, Muted, Button } from './ui';
import { C, F } from '../lib/theme';
import { offerPushAfterOnboarding, acceptPushOffer, declinePushOffer } from '../lib/push';
import { ONBOARDING_PRE_PROMPT as COPY } from '../lib/push-policy';

/**
 * The notifications explanation right after onboarding (app/start.tsx): our own sheet first, the phone's or browser's prompt
 * only after "Turn on". Once per install (lib/push.ts offerPushAfterOnboarding). Closing it any way other than "Turn on" counts
 * as "Not now", which leaves the ask after a first trip or plan as the fallback.
 */
export function PushOffer() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    // A moment after the screen settles, so it doesn't slide up over the screen's own first paint.
    const t = setTimeout(() => { offerPushAfterOnboarding().then(show => { if (live && show) setOpen(true); }); }, 600);
    return () => { live = false; clearTimeout(t); };
  }, []);
  const later = () => { if (busy) return; declinePushOffer(); setOpen(false); };
  const yes = async () => { setBusy(true); try { await acceptPushOffer(); } finally { setBusy(false); setOpen(false); } };
  return (
    <ModalSheet visible={open} onClose={later}>
      <View testID="push-offer" style={{ gap: 12, paddingBottom: 4 }}>
        <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: C.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="notifications" size={26} color={C.primaryDark} />
        </View>
        <T style={{ fontFamily: F.xb, fontSize: 20 }}>{COPY.title}</T>
        <Muted style={{ lineHeight: 21 }}>{COPY.body}</Muted>
        <Button title={COPY.yes} loading={busy} onPress={yes} style={{ marginTop: 6 }} />
        <Button title={COPY.no} kind="ghost" disabled={busy} onPress={later} />
      </View>
    </ModalSheet>
  );
}
