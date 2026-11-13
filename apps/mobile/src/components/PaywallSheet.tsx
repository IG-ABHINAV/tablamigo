import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { T, Muted, Button } from './ui';
import { ModalSheet } from './ModalSheet';
import type { Moment } from '../lib/paywall-copy';
import { useLaunchOffer } from '../lib/useLaunchOffer';
import { offerShort } from '../lib/launch-offer';
import { useAllFree } from '../lib/useAllFree';
import { F } from '../lib/theme';

/** A paywall moment: why something stopped, Plus or a Trip Pass as the way through, and an easy "Not now". */
export function PaywallSheet({ moment, onClose }: { moment: Moment | null; onClose: () => void }) {
  const offer = useLaunchOffer();
  // While everything is free the API raises no paywall errors; if an old moment still arrives, there is nothing to sell.
  const { allFree } = useAllFree();
  const go = () => {
    if (!moment) return;
    onClose();
    router.push(`/paywall?reason=${moment.reason}${moment.plan ? `&plan=${moment.plan}` : ''}`);
  };
  return (
    <ModalSheet visible={!!moment && !allFree} onClose={onClose}>
      {moment ? <View style={{ gap: 10 }}>
        <T style={{ fontSize: 40 }}>{moment.emoji}</T>
        <T style={{ fontFamily: F.xb, fontSize: 21, lineHeight: 27 }}>{moment.title}</T>
        <Muted style={{ lineHeight: 20 }}>{moment.body}</Muted>
        <Button title={offer.active ? offerShort(offer) : moment.plan === 'pass' ? 'See all with a Trip Pass' : 'Get Plus or a Trip Pass'} onPress={go} style={{ marginTop: 8 }} />
        <Button title="Not now" kind="ghost" onPress={onClose} />
      </View> : null}
    </ModalSheet>
  );
}
