import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, Share, View, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { T, H1, H2, Muted, Button, Input, BackButton } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { queryClient } from '../lib/query';
import { C, F, R, shadow } from '../lib/theme';
import { useAllFree } from '../lib/useAllFree';

export default function Referral() {
  const [inputCode, setInputCode] = useState('');
  const [copied, setCopied] = useState(false);
  const q = useQuery({ queryKey: ['referral'], queryFn: () => api('/me/referral') });
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me') });
  // While everything is free (lib/all-free.ts) there are no Plus days to give: inviting is just inviting.
  const { allFree } = useAllFree();

  const redeem = useMutation({
    mutationFn: () => api('/me/referral/redeem', { method: 'POST', body: { code: inputCode.trim() } }),
    onSuccess: (res) => {
      // A creator partner's code (API lib/affiliate-ledger.ts) gives no Plus days: it records who brought you.
      if (res.partner) Alert.alert('Code applied', 'Thanks for supporting the creator who sent you to Tablamigo.');
      else Alert.alert('Plus Activated! 🎉', `You received ${res.rewardDays} days of Tablamigo Plus. Enjoy unlimited chats, travel date views, and full perks!`);
      setInputCode('');
      queryClient.invalidateQueries({ queryKey: ['me'] });
      queryClient.invalidateQueries({ queryKey: ['referral'] });
    },
    onError: (e) => {
      Alert.alert('Redeem Failed', e instanceof ApiError ? e.message : 'Invalid code or already redeemed.');
    }
  });

  const data = q.data;
  const code = data?.referralCode ?? '...';
  const link = data?.referralLink ?? `https://tablamigo.hookstep.in/r/${code}`;

  const onShare = async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(link);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }
      await Share.share({
        message: allFree ? `Join me on Tablamigo, a free app for meeting travelers nearby: ${link}` : `Join me on Tablamigo! Use my code ${code} to get 7 days of Tablamigo Plus free: ${link}`,
        url: link,
      });
    } catch {
      // ignore dismiss
    }
  };

  const copyCodeOnly = async () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } else {
      Alert.alert('Code Copied', `Copied ${code} to clipboard.`);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top']}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 }}>
        <BackButton />
        <T style={{ fontFamily: F.b, fontSize: 17 }}>Invite Friends</T>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: 60 }}>
        <LinearGradient
          colors={['#FF7A55', '#FF5A36']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[{ borderRadius: R.lg, padding: 22, alignItems: 'center', gap: 10 }, shadow]}
        >
          <T style={{ fontSize: 44 }}>🎁</T>
          <H1 style={{ color: '#fff', textAlign: 'center', fontSize: 24 }}>{allFree ? 'Bring your friends along' : 'Give 7 Days, Get 7 Days!'}</H1>
          <T style={{ color: 'rgba(255,255,255,0.92)', textAlign: 'center', fontSize: 15, lineHeight: 22 }}>
            {allFree
              ? 'Share your invite link with friends and fellow travelers. Tablamigo is free, so they can join and use everything right away.'
              : 'Share your unique invite link with friends and fellow nomads. Whenever a friend joins or enters your code, you BOTH receive 7 days of Tablamigo Plus!'}
          </T>
        </LinearGradient>

        {/* Code Box */}
        <View style={{ backgroundColor: '#fff', borderRadius: R.lg, padding: 20, borderWidth: 1, borderColor: C.line, gap: 14, alignItems: 'center' }}>
          <Muted style={{ fontSize: 12, fontFamily: F.b, textTransform: 'uppercase' }}>Your Exclusive Invite Code</Muted>
          {q.isLoading ? (
            <ActivityIndicator color={C.primary} />
          ) : (
            <Pressable onPress={copyCodeOnly} style={{ backgroundColor: C.bgSoft, paddingHorizontal: 24, paddingVertical: 12, borderRadius: R.md, borderWidth: 1, borderColor: C.line, alignItems: 'center' }}>
              <T style={{ fontFamily: F.xb, fontSize: 28, letterSpacing: 3, color: C.ink }}>{code}</T>
              <Muted style={{ fontSize: 12, marginTop: 4 }}>{copied ? '✅ Copied to clipboard!' : 'Tap to copy code'}</Muted>
            </Pressable>
          )}

          <View style={{ flexDirection: 'row', gap: 10, width: '100%', marginTop: 6 }}>
            <Button
              title="Copy Code"
              kind="ghost"
              onPress={copyCodeOnly}
              icon={<Ionicons name="copy-outline" size={18} color={C.ink} />}
              style={{ flex: 1 }}
            />
            <Button
              title="Share Link"
              kind="primary"
              onPress={onShare}
              icon={<Ionicons name="share-social" size={18} color="#fff" />}
              style={{ flex: 1.2 }}
            />
          </View>
        </View>

        {/* Stats */}
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: R.md, padding: 16, borderWidth: 1, borderColor: C.line, alignItems: 'center' }}>
            <T style={{ fontFamily: F.xb, fontSize: 24, color: C.primaryDark }}>{data?.totalReferred ?? 0}</T>
            <Muted style={{ fontSize: 12, textAlign: 'center' }}>Friends Joined</Muted>
          </View>
          {allFree ? null : <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: R.md, padding: 16, borderWidth: 1, borderColor: C.line, alignItems: 'center' }}>
            <T style={{ fontFamily: F.xb, fontSize: 24, color: '#059669' }}>{data?.daysEarned ?? 0}d</T>
            <Muted style={{ fontSize: 12, textAlign: 'center' }}>Plus Days Earned</Muted>
          </View>}
        </View>

        {/* Redeem friend code: it only gives Plus days, so it is hidden while everything is free */}
        {allFree ? null : <View style={{ backgroundColor: '#fff', borderRadius: R.lg, padding: 20, borderWidth: 1, borderColor: C.line, gap: 12 }}>
          <H2 style={{ fontSize: 17 }}>Have a friend's invite code?</H2>
          <Muted style={{ fontSize: 13 }}>Enter their code below to instantly get 7 days of Tablamigo Plus.</Muted>
          <Input
            value={inputCode}
            onChangeText={setInputCode}
            placeholder="e.g. A1B2C3D4"
            autoCapitalize="characters"
            maxLength={20}
          />
          <Button
            title="Redeem 7 Days Free Plus"
            kind="dark"
            loading={redeem.isPending}
            disabled={!inputCode.trim()}
            onPress={() => redeem.mutate()}
            icon={<Ionicons name="gift-outline" size={18} color="#fff" />}
          />
        </View>}
      </ScrollView>
    </SafeAreaView>
  );
}
