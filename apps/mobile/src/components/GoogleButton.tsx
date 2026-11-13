import React, { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { GoogleSignin, isErrorWithCode, isSuccessResponse, statusCodes } from '@react-native-google-signin/google-signin';
import { ApiError } from '../lib/api';
import { GOOGLE_WEB_CLIENT_ID } from '../lib/config';
import { R } from '../lib/theme';

// Asking for the web client id makes Google issue the ID token to it, which is the audience POST /auth/google checks.
GoogleSignin.configure({ webClientId: GOOGLE_WEB_CLIENT_ID });

/** Opens Google's account picker. The ID token, or null when the person backs out. Throws ApiError google_*. */
async function pickGoogleAccount(): Promise<string | null> {
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    // Forget the last pick, so someone with two Google accounts always gets to choose.
    await GoogleSignin.signOut().catch(() => {});
    const r = await GoogleSignin.signIn();
    if (!isSuccessResponse(r)) return null;
    if (!r.data.idToken) throw new ApiError(0, 'google_failed');
    return r.data.idToken;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (isErrorWithCode(e)) {
      if (e.code === statusCodes.SIGN_IN_CANCELLED || e.code === statusCodes.IN_PROGRESS) return null;
      if (e.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) throw new ApiError(0, 'google_unavailable');
    }
    throw new ApiError(0, 'google_failed');
  }
}

/**
 * "Continue with Google", drawn to Google's branding rules: white, grey outline, the four-colour G; or, `prominent` (the welcome
 * screen's main button since 1.4.4), Google's dark theme: #131314 fill, #8E918F outline, #E3E3E3 label, the same G.
 */
export function GoogleButton({ onToken, onError, disabled, style, prominent }: {
  onToken: (idToken: string) => Promise<void>; onError: (e: unknown) => void; disabled?: boolean; style?: ViewStyle; prominent?: boolean;
}) {
  const fill = prominent ? { up: '#131314', down: '#2A2A2C', line: '#8E918F', ink: '#E3E3E3' } : { up: '#FFFFFF', down: '#F2F2F2', line: '#747775', ink: '#1F1F1F' };
  const [busy, setBusy] = useState(false);
  const press = async () => {
    setBusy(true);
    try { const t = await pickGoogleAccount(); if (t) await onToken(t); }
    catch (e) { onError(e); }
    finally { setBusy(false); }
  };
  return (
    <Pressable disabled={disabled || busy} onPress={press} accessibilityRole="button" accessibilityLabel="Continue with Google"
      style={({ pressed }) => [{ height: prominent ? 58 : 54, borderRadius: R.pill, backgroundColor: pressed ? fill.down : fill.up, borderWidth: 1, borderColor: fill.line,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 12, opacity: disabled ? 0.45 : 1 }, style]}>
      {busy ? <ActivityIndicator color={fill.ink} /> : <>
        <Image source={require('../../assets/images/google-g.png')} style={{ width: 20, height: 20 }} contentFit="contain" />
        {/* Google asks for Roboto Medium, which is Android's system font. */}
        <Text style={{ color: fill.ink, fontSize: prominent ? 17 : 16, fontWeight: '500', fontFamily: Platform.OS === 'android' ? 'sans-serif-medium' : undefined }}>Continue with Google</Text>
      </>}
    </Pressable>
  );
}
