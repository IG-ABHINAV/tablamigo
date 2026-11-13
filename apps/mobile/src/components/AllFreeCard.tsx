import React from 'react';
import { View } from 'react-native';
import { T, Muted } from './ui';
import { ALL_FREE_HEADLINE, ALL_FREE_BODY } from '../lib/all-free';
import { C, F, R } from '../lib/theme';

/** Shown on the paywall instead of everything that sells while everything in Tablamigo is free (lib/all-free.ts). */
export function AllFreeCard() {
  return (
    <View style={{ padding: 18, borderRadius: R.lg, backgroundColor: '#fff', borderWidth: 2, borderColor: C.primary, gap: 6 }}>
      <T style={{ fontSize: 30 }}>🎉</T>
      <T style={{ fontFamily: F.xb, fontSize: 21, lineHeight: 27 }}>{ALL_FREE_HEADLINE}</T>
      <Muted style={{ lineHeight: 20 }}>{ALL_FREE_BODY}</Muted>
    </View>
  );
}
