import React, { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { T } from './ui';
import { C, F, R } from '../lib/theme';
import { PLAY_LISTING, hideReviewCard, useReviewCard } from '../lib/review-prompt.web';

/** Shown for 30 seconds unless dismissed or used. */
const SHOW_MS = 30_000;

/**
 * The web app's rating ask (lib/review-prompt.web.ts decides when): a small card near the bottom, neutral words, one link to the
 * Google Play listing and a close button. It covers nothing the person needs and goes away on its own.
 */
export function ReviewCard() {
  const visible = useReviewCard(s => s.visible);
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(hideReviewCard, SHOW_MS);
    return () => clearTimeout(t);
  }, [visible]);
  if (!visible) return null;
  const link = { href: PLAY_LISTING, hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } } as object;
  return (
    // Above the chat composer and the tab bar (both under 96 px), clear of every screen's header and back button.
    <View pointerEvents="box-none" style={{ position: 'absolute', bottom: 96, left: 0, right: 0, alignItems: 'center', paddingHorizontal: 16 }}>
      <View role="region" aria-label="Rate Tablamigo" testID="review-card"
        style={{ width: '100%', maxWidth: 420, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingLeft: 16, paddingRight: 8,
          borderRadius: R.lg, backgroundColor: C.card, borderWidth: 1, borderColor: C.line,
          shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } }}>
        <View style={{ flex: 1 }}>
          <T style={{ fontFamily: F.b, fontSize: 15 }}>Enjoying Tablamigo?</T>
          <Text {...link} onPress={hideReviewCard} style={{ fontFamily: F.sb, fontSize: 14, color: C.primaryDark, marginTop: 2, textDecorationLine: 'underline' }}>
            Rate us on Google Play
          </Text>
        </View>
        <Pressable onPress={hideReviewCard} role="button" accessibilityLabel="Dismiss" hitSlop={8} style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="close" size={20} color={C.ink3} />
        </Pressable>
      </View>
    </View>
  );
}
