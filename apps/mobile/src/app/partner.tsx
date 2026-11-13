// Partner programme (API routes/partner.ts, lib/partner-signup.ts). Not a partner yet: what it is, the terms, and one step to join
// once they are ticked. A partner: their link with a copy button, their stats per currency, and their payout details (masked).
// The public explanation is the website's /partners, whose button opens this screen in the web app.
import React, { useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, Share, View, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, H1, H2, Muted, Button, Input, BackButton, Chip } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { queryClient } from '../lib/query';
import { C, F, R } from '../lib/theme';
import { PARTNER_TERMS, PARTNER_TERMS_VERSION, PARTNER_PERCENT, partnerMoney, payoutError, type PayoutForm } from '../lib/partner-terms';

type Money = { currency: string; amountMinor: number };
type Partner = {
  code: string; link: string; status: 'active' | 'paused' | 'ended'; percent: number;
  stats: { signups: number; paying: number; earned: Money[]; owed: Money[]; paid: Money[] };
  payout: { method: 'upi' | 'bank'; masked: string } | null;
};

const card = { backgroundColor: '#fff', borderRadius: R.lg, padding: 18, borderWidth: 1, borderColor: C.line, gap: 12 } as const;

export default function PartnerScreen() {
  const q = useQuery({ queryKey: ['partner'], queryFn: () => api('/me/partner') as Promise<{ partner: Partner | null }> });
  const partner = q.data?.partner ?? null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top']}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 }}>
        <BackButton />
        <T style={{ fontFamily: F.b, fontSize: 17 }}>Partner programme</T>
        <View style={{ width: 28 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 60, width: '100%', maxWidth: 640, alignSelf: 'center' }} keyboardShouldPersistTaps="handled">
        {q.isLoading ? <ActivityIndicator color={C.primary} style={{ marginTop: 40 }} />
          : q.isError ? <Muted style={{ textAlign: 'center', marginTop: 40 }}>Couldn't load this. Pull down or try again in a moment.</Muted>
          : partner ? <Dashboard p={partner} /> : <Join />}
      </ScrollView>
    </SafeAreaView>
  );
}

function Join() {
  const [accepted, setAccepted] = useState(false);
  const join = useMutation({
    mutationFn: () => api('/me/partner', { method: 'POST', body: { acceptTerms: true, termsVersion: PARTNER_TERMS_VERSION } }),
    onSuccess: res => { queryClient.setQueryData(['partner'], { partner: res.partner }); },
    onError: e => {
      if (e instanceof ApiError && e.code === 'terms_changed') queryClient.invalidateQueries({ queryKey: ['partner'] });
      Alert.alert('Could not join', e instanceof ApiError ? (e.code === 'rate_limited' ? 'Too many tries. Try again in an hour.' : e.message) : 'Try again in a moment.');
    },
  });
  return (
    <>
      <View style={[card, { backgroundColor: C.primarySoft, borderColor: C.primarySoft }]}>
        <H1 style={{ fontSize: 24, lineHeight: 30 }}>Earn {PARTNER_PERCENT}% when travelers you bring pay</H1>
        <T style={{ lineHeight: 22 }}>Share your own Tablamigo link. When people join from it and buy Plus or a Trip Pass, you get {PARTNER_PERCENT}% of what they pay, for as long as you are a partner. Paid monthly by bank or UPI.</T>
      </View>
      <View style={card} nativeID="terms">
        <H2 style={{ fontSize: 17 }}>Partner terms</H2>
        {PARTNER_TERMS.map((t, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 8 }}>
            <T style={{ color: C.ink2 }}>{i + 1}.</T>
            <T style={{ flex: 1, fontSize: 14, lineHeight: 20 }}>{t}</T>
          </View>
        ))}
        <Muted style={{ fontSize: 12 }}>Terms dated {PARTNER_TERMS_VERSION}.</Muted>
        <Pressable
          onPress={() => setAccepted(a => !a)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: accepted }}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, minHeight: 44 }}
        >
          <Ionicons name={accepted ? 'checkbox' : 'square-outline'} size={24} color={accepted ? C.primary : C.ink2} />
          <T style={{ flex: 1, fontFamily: F.b }}>I accept the partner terms</T>
        </Pressable>
        <Button title="Become a partner" disabled={!accepted || join.isPending} loading={join.isPending} onPress={() => join.mutate()} />
      </View>
    </>
  );
}

function Dashboard({ p }: { p: Partner }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    // The web app copies; Android opens the share sheet, which has Copy (no native clipboard module in this build).
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      try { await navigator.clipboard.writeText(p.link); setCopied(true); setTimeout(() => setCopied(false), 2500); return; } catch { /* fall through */ }
    }
    try { await Share.share({ message: p.link, url: p.link }); } catch { /* dismissed */ }
  };
  const share = () => Share.share({ message: `I meet travelers on Tablamigo. Find people to explore with nearby: ${p.link}`, url: p.link }).catch(() => {});
  const st = p.stats;
  return (
    <>
      {p.status !== 'active' ? (
        <View style={[card, { backgroundColor: '#FFF7ED', borderColor: '#FED7AA' }]}>
          <T style={{ fontFamily: F.b }}>{p.status === 'paused' ? 'Your partnership is paused' : 'Your partnership has ended'}</T>
          <Muted>New sign-ups and payments don't earn commission right now. Write to support@hookstep.in if you have a question.</Muted>
        </View>
      ) : null}
      <View style={card}>
        <Muted style={{ fontSize: 12, fontFamily: F.b, textTransform: 'uppercase' }}>Your partner link</Muted>
        <T selectable style={{ fontFamily: F.b, fontSize: 16 }} testID="partner-link">{p.link}</T>
        <Muted style={{ fontSize: 13 }}>Code <T selectable style={{ fontFamily: F.b, letterSpacing: 1 }}>{p.code}</T> · {p.percent}% while you are a partner</Muted>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button title={copied ? 'Copied' : 'Copy link'} kind="ghost" onPress={copy} icon={<Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={18} color={C.ink} />} style={{ flex: 1 }} />
          <Button title="Share" onPress={share} icon={<Ionicons name="share-social" size={18} color="#fff" />} style={{ flex: 1 }} />
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Stat n={String(st.signups)} label="Sign-ups" />
        <Stat n={String(st.paying)} label="Paying" />
      </View>
      <View style={card}>
        <H2 style={{ fontSize: 17 }}>Commission</H2>
        <Line label="Earned" value={partnerMoney(st.earned)} />
        <Line label="Owed to you" value={partnerMoney(st.owed)} />
        <Line label="Paid" value={partnerMoney(st.paid)} />
        <Muted style={{ fontSize: 12 }}>Kept in the currency each person paid in. We pay monthly once you are owed ₹1,000 or $12. Clicks on your link are not counted.</Muted>
      </View>
      <PayoutCard current={p.payout} />
    </>
  );
}

const Stat = ({ n, label }: { n: string; label: string }) => (
  <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: R.md, padding: 16, borderWidth: 1, borderColor: C.line, alignItems: 'center' }}>
    <T style={{ fontFamily: F.xb, fontSize: 24, color: C.primaryDark }}>{n}</T>
    <Muted style={{ fontSize: 12 }}>{label}</Muted>
  </View>
);
const Line = ({ label, value }: { label: string; value: string }) => (
  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
    <Muted>{label}</Muted><T style={{ fontFamily: F.b, flexShrink: 1, textAlign: 'right' }}>{value}</T>
  </View>
);

function PayoutCard({ current }: { current: Partner['payout'] }) {
  const [editing, setEditing] = useState(!current);
  const [method, setMethod] = useState<'upi' | 'bank'>(current?.method ?? 'upi');
  const [upiId, setUpiId] = useState('');
  const [accountName, setAccountName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [ifsc, setIfsc] = useState('');
  const form: PayoutForm = method === 'upi' ? { method, upiId } : { method, accountName, accountNumber, ifsc };
  const save = useMutation({
    mutationFn: () => {
      const err = payoutError(form);
      if (err) throw new Error(err);
      return api('/me/partner/payout', { method: 'PUT', body: form });
    },
    onSuccess: () => {
      setEditing(false); setUpiId(''); setAccountName(''); setAccountNumber(''); setIfsc('');
      queryClient.invalidateQueries({ queryKey: ['partner'] });
    },
    onError: e => Alert.alert('Payout details', e instanceof Error ? e.message : 'Try again.'),
  });
  return (
    <View style={card}>
      <H2 style={{ fontSize: 17 }}>Payout details</H2>
      {current && !editing ? (
        <>
          <T testID="payout-masked">{current.masked}</T>
          <Muted style={{ fontSize: 12 }}>Stored encrypted. Only the payouts team sees them in full.</Muted>
          <Button title="Change" kind="ghost" onPress={() => setEditing(true)} />
        </>
      ) : (
        <>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Chip label="UPI" active={method === 'upi'} onPress={() => setMethod('upi')} />
            <Chip label="Bank account" active={method === 'bank'} onPress={() => setMethod('bank')} />
          </View>
          {method === 'upi' ? (
            <Input label="UPI ID" value={upiId} onChangeText={setUpiId} placeholder="name@okaxis" autoCapitalize="none" autoCorrect={false} maxLength={128} />
          ) : (
            <>
              <Input label="Account holder name" value={accountName} onChangeText={setAccountName} placeholder="As on your bank account" maxLength={80} />
              <Input label="Account number" value={accountNumber} onChangeText={setAccountNumber} keyboardType="number-pad" maxLength={22} />
              <Input label="IFSC code" value={ifsc} onChangeText={t => setIfsc(t.toUpperCase())} autoCapitalize="characters" placeholder="HDFC0001234" maxLength={11} />
            </>
          )}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {current ? <Button title="Cancel" kind="ghost" onPress={() => setEditing(false)} style={{ flex: 1 }} /> : null}
            <Button title="Save" loading={save.isPending} onPress={() => save.mutate()} style={{ flex: 1 }} />
          </View>
          <Muted style={{ fontSize: 12 }}>Indian bank accounts and UPI only for now. Stored encrypted and shown to you masked.</Muted>
        </>
      )}
    </View>
  );
}
