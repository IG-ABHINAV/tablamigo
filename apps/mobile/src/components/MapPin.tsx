import React from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { T } from './ui';
import type { Activity } from './ActivityCard';
import { C, F, R, shadow } from '../lib/theme';

const Tip = () => <View style={{ width: 10, height: 10, backgroundColor: '#fff', transform: [{ rotate: '45deg' }], marginTop: -6 }} />;

/**
 * Emoji pin. Safe inside ViewAnnotation, which Android renders to a bitmap once.
 * `idea`: an AI plan idea rather than a real plan, drawn dashed and labelled "Idea".
 */
export function MapPin({ a, idea }: { a: Pick<Activity, 'emoji'> & Partial<Pick<Activity, 'joined' | 'womenOnly' | 'going'>>; idea?: boolean }) {
  return (
    <View style={{ alignItems: 'center', opacity: idea ? 0.96 : 1 }}>
      <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: idea ? 'rgba(255,255,255,0.94)' : '#fff', borderRadius: R.pill, paddingLeft: 3, paddingRight: 10, paddingVertical: 3,
        borderWidth: idea ? 1.5 : a.joined ? 2 : 0, borderStyle: idea ? 'dashed' : 'solid', borderColor: idea ? C.women : C.primary }, shadow]}>
        <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: idea || a.womenOnly ? C.womenSoft : C.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
          <T style={{ fontSize: 17 }}>{a.emoji}</T>
        </View>
        {idea ? <T style={{ fontFamily: F.b, fontSize: 12, color: C.women }}>Idea</T>
          : (a.going ?? 0) > 1 ? <T style={{ fontFamily: F.b, fontSize: 12, color: C.ink2 }}>{a.going}</T> : null}
      </View>
      <Tip />
    </View>
  );
}

const S = 46;
const badge = { position: 'absolute', minWidth: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' } as const;

/** Host photo pin. Needs a live view (Marker), since the image loads after first render. */
export function MapPhotoPin({ a }: { a: Activity }) {
  return (
    <View style={{ alignItems: 'center', padding: 4 }}>
      <View style={[{ width: S, height: S, borderRadius: S / 2, backgroundColor: '#fff', padding: 3 }, shadow]}>
        <View style={{ flex: 1, borderRadius: S / 2, overflow: 'hidden', backgroundColor: a.womenOnly ? C.womenSoft : C.primarySoft, borderWidth: a.joined ? 2 : 0, borderColor: C.primary }}>
          <Image source={{ uri: a.host.photoUrl! }} style={{ width: '100%', height: '100%' }} contentFit="cover" transition={150} />
        </View>
        <View style={[badge, { left: -5, bottom: -3, backgroundColor: a.womenOnly ? C.womenSoft : C.primarySoft }]}>
          <T style={{ fontSize: 10, lineHeight: 13 }}>{a.emoji}</T>
        </View>
        {a.going > 1 ? <View style={[badge, { right: -5, top: -3, paddingHorizontal: 4, backgroundColor: C.ink }]}>
          <T style={{ fontFamily: F.b, fontSize: 10, lineHeight: 13, color: '#fff' }}>{a.going}</T>
        </View> : null}
      </View>
      <Tip />
    </View>
  );
}
