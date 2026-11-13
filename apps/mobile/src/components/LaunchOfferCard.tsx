import React from 'react';
import { View } from 'react-native';
import { T, Muted } from './ui';
import { offerHeadline, type LaunchOffer } from '../lib/launch-offer';
import { C, F, R } from '../lib/theme';

/** Shown on the paywall instead of the buy buttons while the launch offer runs. */
export function LaunchOfferCard({ offer }: { offer: LaunchOffer }) {
  return (
    <View style={{ padding: 18, borderRadius: R.lg, backgroundColor: '#fff', borderWidth: 2, borderColor: C.primary, gap: 6 }}>
      <T style={{ fontSize: 30 }}>🎉</T>
      <T style={{ fontFamily: F.xb, fontSize: 19, lineHeight: 25 }}>{offerHeadline(offer)}</T>
      <Muted style={{ lineHeight: 20 }}>There is nothing to buy and nothing to cancel. Plus is included for everyone while the offer runs.</Muted>
    </View>
  );
}
