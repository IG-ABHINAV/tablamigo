import React, { useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  View,
  ActivityIndicator,
} from 'react-native';
import { Modal } from '../components/Modal';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { T, H1, H2, Muted, Button, BackButton, IconButton } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { queryClient } from '../lib/query';
import { C, F, R, shadow, flag } from '../lib/theme';
import { FEATURES } from '../lib/config';

export default function TripPasses() {
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [redeemModalVisible, setRedeemModalVisible] = useState(false);

  const passesQuery = useQuery({
    queryKey: ['trip-passes'],
    queryFn: () => api('/me/trip-passes'),
  });

  const tripsQuery = useQuery({
    queryKey: ['trips'],
    queryFn: () => api('/trips'),
  });

  const redeemMutation = useMutation({
    mutationFn: (tripId: string | null) =>
      api('/me/trip-pass/redeem', {
        method: 'POST',
        body: { tripId },
      }),
    onSuccess: (res: any) => {
      setRedeemModalVisible(false);
      queryClient.invalidateQueries({ queryKey: ['trip-passes'] });
      queryClient.invalidateQueries({ queryKey: ['me'] });
      Alert.alert(
        'Trip Pass Activated! 🎉',
        `Your 14-day Tablamigo Plus pass is active until ${new Date(res.plusUntil).toLocaleDateString()}. Enjoy unlimited chats, travel date views, and full perks!`
      );
    },
    onError: (err: any) => {
      Alert.alert('Activation Failed', err instanceof ApiError ? err.message : 'Could not activate pass.');
    },
  });

  const buyBundleMutation = useMutation({
    mutationFn: (bundle: any) =>
      api('/me/trip-pass/bundle', {
        method: 'POST',
        body: {
          count: bundle.passes,
          priceCents: bundle.price,
          source: 'purchase_bundle',
        },
      }),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['trip-passes'] });
      queryClient.invalidateQueries({ queryKey: ['me'] });
      Alert.alert(
        'Bundle Purchased! 🎫',
        `Added to your wallet. You now have ${res.tripPassesAvailable} Trip Pass${res.tripPassesAvailable === 1 ? '' : 'es'} ready to use anytime!`
      );
    },
    onError: (err: any) => {
      Alert.alert('Purchase Failed', err instanceof ApiError ? err.message : 'Could not complete bundle purchase.');
    },
  });

  const data = passesQuery.data;
  const available = data?.available ?? 0;
  const plusUntil = data?.plusUntil;
  const isPlusActive = !!(plusUntil && new Date(plusUntil) > new Date());
  // Bundles are not on sale (FEATURES.tripPassBundles): the old buy button added passes with no payment at all.
  // Plus and the single Trip Pass are bought on the Plus screen (Play Billing in the Play app, Razorpay on the web).
  const bundles: any[] = FEATURES.tripPassBundles ? (data?.bundles ?? []) : [];
  const redemptions = data?.redemptions ?? [];
  const walletHistory = data?.wallet ?? [];
  const trips = tripsQuery.data?.trips ?? [];

  const handleOpenRedeem = () => {
    if (available <= 0) {
      router.push('/paywall');
      return;
    }
    setRedeemModalVisible(true);
  };

  const handleConfirmRedeem = () => {
    redeemMutation.mutate(selectedTripId);
  };

  const handleBuyBundle = (bundle: any) => {
    Alert.alert(
      `Get ${bundle.label}?`,
      `${bundle.passes} passes (${bundle.totalDays} total days of Plus) for ₹${(bundle.price / 100).toFixed(0)}. Passes never expire until you activate them.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm Purchase',
          onPress: () => buyBundleMutation.mutate(bundle),
        },
      ]
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top']}>
      {/* Top Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: C.line,
        }}
      >
        <BackButton />
        <T style={{ fontFamily: F.b, fontSize: 18 }}>Trip Pass Wallet</T>
        <IconButton name="sparkles" label="Get Plus" size={20} color={C.primary} edge="right" onPress={() => router.push('/paywall')} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 18, gap: 20, paddingBottom: 60 }}>
        {/* Wallet Balance Hero Card */}
        <LinearGradient
          colors={['#1F1F2B', '#111116']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[{ borderRadius: R.lg, padding: 22, gap: 14 }, shadow]}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View>
              <Muted style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, fontFamily: F.b, textTransform: 'uppercase', letterSpacing: 1 }}>
                Available Balance
              </Muted>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
                <T style={{ fontFamily: F.xb, fontSize: 36, color: '#fff' }}>{available}</T>
                <T style={{ fontFamily: F.b, fontSize: 18, color: 'rgba(255,255,255,0.85)' }}>
                  {available === 1 ? 'Trip Pass' : 'Trip Passes'}
                </T>
              </View>
            </View>
            <View
              style={{
                width: 48,
                height: 48,
                borderRadius: 24,
                backgroundColor: 'rgba(255, 90, 54, 0.15)',
                borderWidth: 1,
                borderColor: 'rgba(255, 90, 54, 0.4)',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <T style={{ fontSize: 24 }}>🎫</T>
            </View>
          </View>

          {isPlusActive ? (
            <View style={{ backgroundColor: 'rgba(16, 179, 159, 0.18)', borderWidth: 1, borderColor: '#10B39F', borderRadius: R.md, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="checkmark-circle" size={18} color="#10B39F" />
              <T style={{ color: '#E3F7F4', fontSize: 13, fontFamily: F.sb }}>
                Plus Active · Valid until {new Date(plusUntil).toLocaleDateString()}
              </T>
            </View>
          ) : (
            <T style={{ color: 'rgba(255,255,255,0.75)', fontSize: 13.5, lineHeight: 19 }}>
              Passes never expire. Activate 14 days of full Tablamigo Plus only when your trip begins.
            </T>
          )}

          <Button
            title={available > 0 ? "Activate a 14-Day Pass" : "See Plus options"}
            onPress={handleOpenRedeem}
            style={available > 0 ? { backgroundColor: C.primary } : { backgroundColor: '#333342' }}
          />
        </LinearGradient>

        {/* Value Proposition Highlights */}
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: R.md, padding: 14, borderWidth: 1, borderColor: C.line, gap: 4 }}>
            <T style={{ fontSize: 20 }}>♾️</T>
            <T style={{ fontFamily: F.b, fontSize: 14, color: C.ink }}>Never Expire</T>
            <Muted style={{ fontSize: 11.5, lineHeight: 16 }}>Keep passes in your wallet until you decide to travel.</Muted>
          </View>
          <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: R.md, padding: 14, borderWidth: 1, borderColor: C.line, gap: 4 }}>
            <T style={{ fontSize: 20 }}>🗓️</T>
            <T style={{ fontFamily: F.b, fontSize: 14, color: C.ink }}>14 Days Full Plus</T>
            <Muted style={{ fontSize: 11.5, lineHeight: 16 }}>See overlapping dates, unlock city chats & photo perks.</Muted>
          </View>
          {bundles.length > 0 ? (
            <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: R.md, padding: 14, borderWidth: 1, borderColor: C.line, gap: 4 }}>
              <T style={{ fontSize: 20 }}>💸</T>
              <T style={{ fontFamily: F.b, fontSize: 14, color: C.ink }}>Up to 33% Off</T>
              <Muted style={{ fontSize: 11.5, lineHeight: 16 }}>Multi-trip bundle discounts for frequent nomads.</Muted>
            </View>
          ) : null}
        </View>

        {/* Bundle Catalogue (only while bundles are on sale) */}
        {bundles.length > 0 ? (
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <H2 style={{ fontSize: 19 }}>Trip Pass Bundles</H2>
            <Muted style={{ fontSize: 12 }}>Pre-pay & Save</Muted>
          </View>

          {bundles.map((bundle: any) => {
            const isBest = bundle.id === 'bundle_5';
            const isPopular = bundle.id === 'bundle_3';
            return (
              <View
                key={bundle.id}
                style={{
                  backgroundColor: '#fff',
                  borderRadius: R.lg,
                  padding: 16,
                  borderWidth: isBest || isPopular ? 2 : 1,
                  borderColor: isBest ? C.primary : isPopular ? '#3B82F6' : C.line,
                  gap: 12,
                }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <View style={{ gap: 2, flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <T style={{ fontFamily: F.b, fontSize: 16, color: C.ink }}>{bundle.label}</T>
                      {bundle.badge ? (
                        <View style={{ backgroundColor: isBest ? C.primarySoft : '#EFF6FF', paddingHorizontal: 8, paddingVertical: 2, borderRadius: R.pill }}>
                          <T style={{ color: isBest ? C.primaryDark : '#2563EB', fontFamily: F.b, fontSize: 11 }}>
                            {bundle.badge}
                          </T>
                        </View>
                      ) : null}
                    </View>
                    <Muted style={{ fontSize: 13 }}>
                      {bundle.passes} {bundle.passes === 1 ? 'Trip Pass' : 'Trip Passes'} · {bundle.totalDays} total days of Plus
                    </Muted>
                  </View>

                  <View style={{ alignItems: 'flex-end' }}>
                    <T style={{ fontFamily: F.xb, fontSize: 19, color: C.ink }}>
                      ₹{(bundle.price / 100).toFixed(0)}
                    </T>
                    {bundle.passes > 1 ? (
                      <Muted style={{ fontSize: 11.5 }}>
                        ₹{Math.round(bundle.price / 100 / bundle.passes)}/trip
                      </Muted>
                    ) : null}
                  </View>
                </View>

                <Button
                  title={`Buy ${bundle.label}`}
                  loading={buyBundleMutation.isPending}
                  onPress={() => handleBuyBundle(bundle)}
                  style={isBest ? { backgroundColor: C.primary } : isPopular ? { backgroundColor: '#2563EB' } : { backgroundColor: C.ink }}
                />
              </View>
            );
          })}
        </View>
        ) : null}

        {/* Redemption History */}
        <View style={{ gap: 12 }}>
          <H2 style={{ fontSize: 19 }}>Activation History</H2>
          {passesQuery.isLoading ? (
            <ActivityIndicator color={C.primary} />
          ) : redemptions.length === 0 ? (
            <View style={{ backgroundColor: '#fff', borderRadius: R.lg, padding: 18, alignItems: 'center', borderWidth: 1, borderColor: C.line, gap: 6 }}>
              <T style={{ fontSize: 28 }}>🛫</T>
              <T style={{ fontFamily: F.sb, color: C.ink }}>No Passes Activated Yet</T>
              <Muted style={{ fontSize: 12.5, textAlign: 'center' }}>
                When you activate a pass for a trip, its record and dates will appear here.
              </Muted>
            </View>
          ) : (
            <View style={{ backgroundColor: '#fff', borderRadius: R.lg, borderWidth: 1, borderColor: C.line, overflow: 'hidden' }}>
              {redemptions.map((r: any, idx: number) => (
                <View
                  key={r.id || String(idx)}
                  style={{
                    padding: 14,
                    borderTopWidth: idx > 0 ? 1 : 0,
                    borderTopColor: C.line,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: C.goSoft, alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name="checkmark-done" size={20} color={C.go} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <T style={{ fontFamily: F.b, fontSize: 14 }}>
                      +{r.daysGranted} Days Plus Activated
                    </T>
                    <Muted style={{ fontSize: 12 }}>
                      {r.city ? `${flag(r.countryCode)} Trip to ${r.city}` : 'General trip pass'} · {new Date(r.redeemedAt).toLocaleDateString()}
                    </Muted>
                  </View>
                  <T style={{ fontSize: 11, color: C.ink3, fontFamily: F.m }}>
                    Until {new Date(r.plusUntilAfter).toLocaleDateString()}
                  </T>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Wallet Ledger */}
        {walletHistory.length > 0 ? (
          <View style={{ gap: 12 }}>
            <H2 style={{ fontSize: 18 }}>Wallet Purchases</H2>
            <View style={{ backgroundColor: '#fff', borderRadius: R.lg, borderWidth: 1, borderColor: C.line, overflow: 'hidden' }}>
              {walletHistory.map((item: any, idx: number) => (
                <View
                  key={item.id || String(idx)}
                  style={{
                    padding: 14,
                    borderTopWidth: idx > 0 ? 1 : 0,
                    borderTopColor: C.line,
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <View style={{ gap: 2 }}>
                    <T style={{ fontFamily: F.sb, fontSize: 13.5 }}>
                      +{item.passesAdded} Passes Added ({item.source.replace(/_/g, ' ')})
                    </T>
                    <Muted style={{ fontSize: 12 }}>{new Date(item.createdAt).toLocaleDateString()}</Muted>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 2 }}>
                    <T style={{ fontFamily: F.b, fontSize: 13.5, color: C.primary }}>
                      {item.passesRemaining} remaining
                    </T>
                    {item.priceCents ? (
                      <Muted style={{ fontSize: 11.5 }}>₹{(item.priceCents / 100).toFixed(0)}</Muted>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>

      {/* Activation / Trip Linker Modal */}
      <Modal visible={redeemModalVisible} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: '#fff', borderTopLeftRadius: R.xl, borderTopRightRadius: R.xl, padding: 22, gap: 16 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <T style={{ fontFamily: F.b, fontSize: 18 }}>Activate Trip Pass</T>
              <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => setRedeemModalVisible(false)} hitSlop={10}>
                <Ionicons name="close" size={24} color={C.ink} />
              </Pressable>
            </View>

            <T style={{ fontSize: 14, color: C.ink2, lineHeight: 20 }}>
              This will deduct 1 pass from your wallet and grant you <T style={{ fontFamily: F.b, color: C.ink }}>14 consecutive days of Tablamigo Plus</T>.
            </T>

            {trips.length > 0 ? (
              <View style={{ gap: 8 }}>
                <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink }}>
                  Link to an upcoming trip (optional):
                </T>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
                  <Pressable
                    onPress={() => setSelectedTripId(null)}
                    style={{
                      paddingHorizontal: 14,
                      paddingVertical: 8,
                      borderRadius: R.pill,
                      borderWidth: 1.5,
                      borderColor: selectedTripId === null ? C.primary : C.line,
                      backgroundColor: selectedTripId === null ? C.primarySoft : '#fff',
                    }}
                  >
                    <T style={{ fontFamily: F.b, fontSize: 12.5, color: selectedTripId === null ? C.primaryDark : C.ink }}>
                      ✨ Any trip / general
                    </T>
                  </Pressable>
                  {trips.map((t: any) => {
                    const isSel = selectedTripId === t.id;
                    return (
                      <Pressable
                        key={t.id}
                        onPress={() => setSelectedTripId(t.id)}
                        style={{
                          paddingHorizontal: 14,
                          paddingVertical: 8,
                          borderRadius: R.pill,
                          borderWidth: 1.5,
                          borderColor: isSel ? C.primary : C.line,
                          backgroundColor: isSel ? C.primarySoft : '#fff',
                        }}
                      >
                        <T style={{ fontFamily: F.b, fontSize: 12.5, color: isSel ? C.primaryDark : C.ink }}>
                          {flag(t.countryCode)} {t.city}
                        </T>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            ) : null}

            <View style={{ gap: 10, marginTop: 8 }}>
              <Button
                title="Confirm & Activate Pass (14 Days)"
                loading={redeemMutation.isPending}
                onPress={handleConfirmRedeem}
              />
              <Button
                title="Cancel"
                kind="ghost"
                onPress={() => setRedeemModalVisible(false)}
              />
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
