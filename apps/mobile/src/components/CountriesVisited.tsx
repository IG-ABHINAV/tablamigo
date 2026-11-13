import React from 'react';
import { Pressable, View } from 'react-native';
import { T, Muted } from './ui';
import { C, F, flag } from '../lib/theme';

/** "🌍 23 countries" and a wrapping row of flags. */
export function CountriesVisited({ codes, onPress, center }: { codes: string[]; onPress?: () => void; center?: boolean }) {
  if (!codes.length && !onPress) return null;
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={{ gap: 8, alignItems: center ? 'center' : 'flex-start' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T style={{ fontFamily: F.b, fontSize: 16 }}>🌍 {codes.length} {codes.length === 1 ? 'country' : 'countries'}</T>
        {onPress ? <T style={{ color: C.primary, fontFamily: F.b }}>{codes.length ? 'Edit' : 'Add'}</T> : null}
      </View>
      {codes.length ? <T style={{ fontSize: 22, lineHeight: 30, textAlign: center ? 'center' : 'left' }}>{codes.map(flag).join(' ')}</T>
        : <Muted>Add the countries you've been to.</Muted>}
    </Pressable>
  );
}
