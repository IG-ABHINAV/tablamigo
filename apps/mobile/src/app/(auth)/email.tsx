import React, { useRef, useState } from 'react';
import { KeyboardAvoidingView, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSafeEdges } from '../../lib/safe-edges';
import { H1, Muted, Button, Input, T, BackButton } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { C } from '../../lib/theme';

export default function Email() {
  const safeEdges = useSafeEdges();
  const [email, setEmail] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const ok = /^\S+@\S+\.\S+$/.test(email.trim());
  // The keyboard's Go and the button can both fire in the same moment: one request, not two (a ref, not state, so the second
  // call sees the first at once).
  const inFlight = useRef(false);
  const send = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setErr('');
    try { await api('/auth/email/start', { body: { email: email.trim() }, auth: false }); router.push({ pathname: '/(auth)/code', params: { email: email.trim() } }); }
    catch (e) { setErr(e instanceof ApiError && e.code === 'too_many_codes' ? 'Too many codes sent. Try again in an hour.' : 'Could not send the code. Check your connection.'); }
    finally { setBusy(false); inFlight.current = false; }
  };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={safeEdges}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        {/* Scrolls only when the keyboard leaves too little room (short phones); otherwise the spacer keeps the button low. */}
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, padding: 24, gap: 18 }}>
        <BackButton />
        <H1>What's your email?</H1>
        <Muted>We'll send a 6-digit code. No passwords.</Muted>
        <Input autoFocus value={email} onChangeText={setEmail} placeholder="you@example.com" keyboardType="email-address" autoCapitalize="none" autoComplete="email" onSubmitEditing={() => ok && send()} />
        {err ? <T style={{ color: C.danger }}>{err}</T> : null}
        <View style={{ flex: 1 }} />
        <Button title="Send code" disabled={!ok} loading={busy} onPress={send} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
