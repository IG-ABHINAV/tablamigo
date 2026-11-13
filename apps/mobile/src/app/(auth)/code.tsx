import React, { useEffect, useRef, useState } from 'react';
import { TextInput, View, Pressable } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSafeEdges } from '../../lib/safe-edges';
import { H1, Muted, T, BackButton } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { signupExtras } from '../../lib/install-referrer';
import { codeFromInput, openCodeKeyboard } from '../../lib/code-input';
import { queryClient } from '../../lib/query';
import { C, F, R } from '../../lib/theme';

export default function Code() {
  const safeEdges = useSafeEdges();
  const { email } = useLocalSearchParams<{ email: string }>();
  const [code, setCode] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const input = useRef<TextInput>(null);
  const setTokens = useSession(s => s.setTokens);
  // A code was just sent (email.tsx). "Send a new code" waits out the server's 30 s cooldown with a countdown, can't be tapped
  // twice, and says what happened: a new code doesn't stop the earlier one working (API lib/auth.ts), so either email will do.
  const [wait, setWait] = useState(30); const [sending, setSending] = useState(false); const inFlight = useRef(false);
  useEffect(() => { if (wait <= 0) return; const t = setTimeout(() => setWait(w => w - 1), 1000); return () => clearTimeout(t); }, [wait]);
  const resend = async () => {
    if (inFlight.current || wait > 0) return;
    inFlight.current = true; setSending(true); setErr('');
    try {
      const r = await api<{ resent?: boolean; resendIn?: number }>('/auth/email/start', { body: { email }, auth: false });
      setWait(r.resendIn ?? 30);
      setErr(r.resent === false ? 'A code is already on its way. Check your inbox and spam folder.' : 'New code sent. The code in the earlier email still works too.');
    } catch (e) {
      setErr(e instanceof ApiError && e.code === 'too_many_codes' ? 'Too many codes sent. Use the code from one of the emails, or try again in an hour.' : e instanceof ApiError ? e.message : 'No connection.');
    } finally { setSending(false); inFlight.current = false; }
  };
  const verify = async (c: string) => {
    setBusy(true); setErr('');
    try {
      const r = await api('/auth/email/verify', { body: { email, code: c, ...(await signupExtras()) }, auth: false });
      await setTokens({ accessToken: r.accessToken, refreshToken: r.refreshToken });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      router.replace(r.isNew ? '/(auth)/onboarding' : '/(tabs)');
    } catch (e) {
      setErr(e instanceof ApiError ? ({ wrong_code: 'That code is not right.', code_expired: 'That code expired. Send a new one.', too_many_attempts: 'Too many tries. Send a new code.', banned: 'This account is suspended.' } as any)[e.code] ?? (e.status === 0 ? e.message : 'Something went wrong.') : 'No connection.');
      setCode('');
    } finally { setBusy(false); }
  };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg, padding: 24, gap: 18 }} edges={safeEdges}>
      <BackButton />
      <H1>Check your email</H1>
      <Muted>Enter the code we sent to <T style={{ fontFamily: F.b }}>{email}</T></Muted>
      {/* The field lies over the boxes, so a tap reaches the native field itself: Android brings the keyboard back on its own
          and a long-press offers Paste. The field has no onPressIn on purpose: a blur and re-focus from JS during that tap
          raced the native show and closed the keyboard again on 7 of 12 taps (1.4.3 release APK, emulator, 8 Nov 2026).
          Only a tap that misses the field and lands on the boxes goes through openCodeKeyboard (lib/code-input.ts). */}
      <View style={{ marginTop: 8 }}>
        <Pressable onPress={() => openCodeKeyboard(input.current)} style={{ flexDirection: 'row', gap: 10 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <View key={i} style={{ flex: 1, height: 62, borderRadius: R.md, backgroundColor: C.bgSoft, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: code.length === i ? C.primary : 'transparent' }}>
              <T style={{ fontFamily: F.xb, fontSize: 26 }}>{code[i] ?? ''}</T>
            </View>
          ))}
        </Pressable>
        <TextInput ref={input} testID="code-field" accessibilityLabel="Sign-in code" autoFocus value={code} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" caretHidden
          onChangeText={t => { const c = codeFromInput(t); setCode(c); if (c.length === 6 && !busy) verify(c); }} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, opacity: 0.02, color: 'transparent' }} />
      </View>
      {err ? <T style={{ color: C.danger }}>{err}</T> : null}
      {busy ? <Muted>Checking…</Muted> : null}
      <T onPress={resend} disabled={sending || wait > 0} style={{ color: sending || wait > 0 ? C.ink3 : C.primary, fontFamily: F.b }}>{sending ? 'Sending…' : wait > 0 ? `Send a new code (${wait}s)` : 'Send a new code'}</T>
    </SafeAreaView>
  );
}
