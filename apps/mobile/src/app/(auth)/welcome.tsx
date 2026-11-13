import React, { useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, withDelay, Easing } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { T, H1, Muted, Button } from '../../components/ui';
import { C, F, R, shadow } from '../../lib/theme';
import { APP_NAME } from '../../lib/config';
import { GoogleButton } from '../../components/GoogleButton';
import { finishGoogleSignIn } from '../../lib/google-signin';
import { ApiError } from '../../lib/api';
import { TERMS_URL, PRIVACY_URL } from '../../lib/legal';
import { bubbleLayout, FLOAT, type BubbleSlot } from '../../lib/bubble-layout';

// On a wide screen the welcome screen is a centred phone-width column, like an app on a desk, not a stretched page.
const COLUMN = 480;
// Google's own button is at most 400px wide, so the email button stops there too and the two always match.
const BUTTONS = 400;
const BUBBLES = [
  { e: '🍜', t: 'Street food crawl', d: 0 },
  { e: '🌅', t: 'Sunset viewpoint', d: 300 },
  { e: '🍸', t: 'Rooftop drinks', d: 600 },
  { e: '🏄', t: 'Surf on Saturday', d: 900 },
];

// Placed by lib/bubble-layout.ts in the measured space above the headline: only as many as fit, never overlapping.
function Bubble({ b, slot }: { b: typeof BUBBLES[number]; slot: BubbleSlot }) {
  const y = useSharedValue(0), o = useSharedValue(0);
  useEffect(() => {
    o.value = withDelay(b.d, withTiming(1, { duration: 500 }));
    y.value = withDelay(b.d, withRepeat(withTiming(-FLOAT, { duration: 2200, easing: Easing.inOut(Easing.sin) }), -1, true));
  }, []);
  const st = useAnimatedStyle(() => ({ opacity: o.value, transform: [{ translateY: y.value }] }));
  return (
    <Animated.View style={[{ position: 'absolute', top: slot.top, ...(slot.side === 'left' ? { left: 4 } : { right: 4 }), maxWidth: '92%', flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: R.pill, paddingVertical: 8, paddingLeft: 8, paddingRight: 16 }, shadow, st]}>
      <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: C.primarySoft, alignItems: 'center', justifyContent: 'center' }}><T style={{ fontSize: 18 }}>{b.e}</T></View>
      {/* Pictures of what a plan looks like, not real ones: no invented people or counts. */}
      <View style={{ flexShrink: 1 }}><T numberOfLines={1} style={{ fontFamily: F.b, fontSize: 14 }}>{b.t}</T><Muted style={{ fontSize: 12 }}>Example plan</Muted></View>
    </Animated.View>
  );
}

export default function Welcome() {
  // Sent here after the saved session turned out to belong to a suspended account.
  const { suspended } = useLocalSearchParams<{ suspended?: string }>();
  const [err, setErr] = useState(suspended ? new ApiError(403, 'banned').message : '');
  const onGoogleToken = async (idToken: string) => { setErr(''); await finishGoogleSignIn(idToken); };
  const onGoogleError = (e: unknown) => setErr(e instanceof ApiError ? e.message : new ApiError(0, 'google_failed').message);
  const [area, setArea] = useState(0);
  const slots = bubbleLayout(area, BUBBLES.length);
  const button = { width: '100%', maxWidth: BUTTONS, alignSelf: 'center' } as const;
  return (
    <LinearGradient colors={['#FFF4EF', '#FFFFFF']} style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1, width: '100%', maxWidth: COLUMN, alignSelf: 'center', paddingHorizontal: 24 }}>
        <T style={{ fontFamily: F.xb, fontSize: 22, color: C.primary, marginTop: 8 }}>{APP_NAME.toLowerCase()}</T>
        <View style={{ flex: 1, marginTop: 16, marginBottom: 8 }} onLayout={e => setArea(e.nativeEvent.layout.height)}>
          {slots.map((slot, i) => <Bubble key={BUBBLES[i].t} b={BUBBLES[i]} slot={slot} />)}
        </View>
        <View style={{ gap: 14, paddingBottom: 16 }}>
          <H1 style={{ fontSize: 36, lineHeight: 42 }}>Traveling solo?{'\n'}Never eat alone.</H1>
          <Muted style={{ fontSize: 16, lineHeight: 23 }}>Join plans with travelers near you, or post your own. Dinner, drinks, sunsets, surf.</Muted>
          {/* Google is the main way in since 1.4.4: one tap, no code to wait for and type (13 people were stuck on the Android
              code screen from 4 to 10 Nov 2026). Email stays, as the smaller second option. */}
          <GoogleButton prominent onToken={onGoogleToken} onError={onGoogleError} style={{ ...button, marginTop: 8 }} />
          <Button title="Use email instead" kind="ghost" onPress={() => router.push('/(auth)/email')} style={{ ...button, height: 44 }} />
          {err ? <T style={{ color: C.danger, textAlign: 'center' }}>{err}</T> : null}
          <Muted style={{ fontSize: 13, lineHeight: 24, textAlign: 'center' }}>18+ only. By continuing you agree to the{' '}
            <T accessibilityRole="link" onPress={() => Linking.openURL(TERMS_URL)} style={{ fontSize: 13, color: C.primary, textDecorationLine: 'underline' }}>Terms</T>
            {' '}and{' '}
            <T accessibilityRole="link" onPress={() => Linking.openURL(PRIVACY_URL)} style={{ fontSize: 13, color: C.primary, textDecorationLine: 'underline' }}>Privacy Policy</T>.
          </Muted>
        </View>
      </SafeAreaView>
    </LinearGradient>
  );
}
