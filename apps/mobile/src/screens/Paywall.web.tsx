import React, { useState, useEffect } from 'react';
import { Pressable, ScrollView, View, ActivityIndicator } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { T, H1, Muted, Button, Input } from '../components/ui';
import { api, ApiError, trackEvent } from '../lib/api';
import { queryClient } from '../lib/query';
import { C, F, R } from '../lib/theme';
import { ALWAYS_FREE, EARN_PLUS_LINE, PERKS, paywallReason, reasonHeading } from '../lib/paywall-copy';
import { readLaunchOffer } from '../lib/launch-offer';
import { useLaunchOffer } from '../lib/useLaunchOffer';
import { LaunchOfferCard } from '../components/LaunchOfferCard';
import { AllFreeCard } from '../components/AllFreeCard';
import { useAllFree } from '../lib/useAllFree';
import { halfYearDeal, introOrder, yearlyBadge, yearlyDeal } from '../lib/plus-intro';

// Web: Razorpay Checkout (INR). The server creates every order/subscription and verifies every payment.
// prices.halfyearly is there only once the API sells the 6-month plan (RAZORPAY_PLAN_HALFYEARLY); without it the row is left out.
type Rzp = { keyId: string; currency: string; prices: { monthly: number; halfyearly?: number; yearly: number; pass: number }; subscription: { id: string; expiresAt: string; cancelled: boolean } | null };
type Plans = { plus: boolean; plusUntil: string | null; pass: { days: number }; razorpay: Rzp | null; launchOffer?: unknown };
type Plan = { id: 'monthly' | 'halfyearly' | 'yearly' | 'pass'; basePlan: string; price: string; label: string; badge?: string };

let loader: Promise<void> | null = null;
const loadCheckout = () => loader ??= new Promise<void>((ok, fail) => {
  if ((window as any).Razorpay) return ok();
  const s = document.createElement('script');
  s.src = 'https://checkout.razorpay.com/v1/checkout.js';
  s.onload = () => ok(); s.onerror = () => { loader = null; fail(new Error('checkout_unavailable')); };
  document.head.appendChild(s);
});
// Resolves with Razorpay's signed ids. A failed attempt keeps the modal open for a retry, so only closing it rejects.
const checkout = (opts: Record<string, unknown>, onFail: () => void) => new Promise<Record<string, string>>((ok, fail) => {
  const rz = new (window as any).Razorpay({ ...opts, theme: { color: C.primary }, handler: ok, modal: { ondismiss: () => fail(new Error('dismissed')) } });
  rz.on('payment.failed', onFail);
  rz.open();
});
const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;
const day = (d: string) => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
export default function Paywall() {
  const { reason, plan, intro: introParam } = useLocalSearchParams<{ reason?: string; plan?: string; intro?: string }>();
  // ?intro=1: the soft paywall once after onboarding (lib/plus-intro.ts): yearly first and chosen, "Not now" goes into the app.
  // The web sells through Razorpay, which has no free trial, so the web never says anything about one.
  const intro = introParam === '1';
  const close = () => intro ? router.replace('/(tabs)') : router.canGoBack() ? router.back() : router.replace('/');
  const q = useQuery({ queryKey: ['billing'], queryFn: () => api<Plans>('/billing/plans') });
  const [sel, setSel] = useState<Plan['id']>(plan === 'pass' ? 'pass' : plan === 'halfyearly' ? 'halfyearly' : intro || plan === 'yearly' ? 'yearly' : 'monthly');
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('');
  // A creator partner's code (API lib/affiliates.ts couponAffiliate): optional, subscriptions only. Their discount, if they have one,
  // is Razorpay's offer on the subscription; an unusable code is refused before checkout opens.
  const [coupon, setCoupon] = useState('');

  useEffect(() => {
    trackEvent('paywall_viewed', { reason: intro ? 'intro' : paywallReason(reason), surface: 'web' });
  }, [reason, intro]);
  const rzp = q.data?.razorpay; const sub = rzp?.subscription;
  // The launch offer (lib/launch-offer.ts): from GET /billing/me, or from this response if the API serves it here. While it
  // runs there is nothing to buy, so the plans, the Continue button and the renewal notice are not shown at all.
  const fromHook = useLaunchOffer();
  // Everything free (lib/all-free.ts): nothing is sold, so only that card shows, plus the cancel link for anyone who still has
  // a web subscription from before. The create endpoints answer 409 all_free too.
  const free = useAllFree();
  // The create endpoints answer 409 launch_offer_free while the offer runs: if one does, the offer is on whatever the field said.
  const [serverSaysFree, setServerSaysFree] = useState(false);
  const known = fromHook.active ? fromHook : readLaunchOffer(q.data);
  const offer = known.active ? known : serverSaysFree ? { active: true, until: null } : known;
  const offerKnown = offer.active || (fromHook.ready && !q.isLoading);
  // The yearly plan's price per month and saving, from the API's own prices (paise).
  const deal = rzp ? yearlyBadge(yearlyDeal(rzp.prices.monthly / 100, rzp.prices.yearly / 100), rzp.currency || 'INR', 'en-IN') : null;
  const half = rzp?.prices.halfyearly ? yearlyBadge(halfYearDeal(rzp.prices.monthly / 100, rzp.prices.halfyearly / 100), rzp.currency || 'INR', 'en-IN') : null;
  const listed: Plan[] = !rzp ? [] : [
    ...(sub && !sub.cancelled ? [] : [
      { id: 'monthly', basePlan: 'monthly', price: inr(rzp.prices.monthly), label: '1 month', badge: 'Most popular' },
      ...(rzp.prices.halfyearly ? [{ id: 'halfyearly', basePlan: 'halfyearly', price: inr(rzp.prices.halfyearly), label: '6 months', badge: half ?? undefined }] : []),
      { id: 'yearly', basePlan: 'yearly', price: inr(rzp.prices.yearly), label: '12 months', badge: deal ? `Best value · ${deal}` : 'Best value' },
    ] as Plan[]),
    { id: 'pass', basePlan: 'pass', price: inr(rzp.prices.pass), label: `Trip Pass · ${q.data!.pass.days} days`, badge: 'One-time, nothing renews' },
  ];
  const plans = intro ? introOrder(listed) : listed;
  // A plan from the URL that isn't on sale (?plan=halfyearly before its Razorpay plan exists) falls back to monthly, never the pass.
  const chosen = plans.find(p => p.id === sel) ?? plans.find(p => p.id === 'monthly') ?? plans[plans.length - 1];

  const buy = async () => {
    if (!chosen) return;
    setBusy(true); setMsg('');
    let paid = false;
    const failedTry = () => setMsg('That payment did not go through. Try again or pick another method.');
    try {
      await loadCheckout();
      let active = true;
      if (chosen.id === 'pass') {
        const o = await api('/billing/razorpay/pass-order', { body: {} });
        const r = await checkout({ key: o.keyId, order_id: o.orderId, amount: o.amount, currency: o.currency, name: o.name, description: o.description, prefill: o.prefill, notes: o.notes }, failedTry);
        paid = true;
        await api('/billing/razorpay/pass-verify', { body: { orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature } });
      } else {
        const s = await api('/billing/razorpay/subscribe', { body: { period: chosen.id, ...(coupon.trim() ? { coupon: coupon.trim() } : {}) } });
        const r = await checkout({ key: s.keyId, subscription_id: s.subscriptionId, name: s.name, description: s.description, prefill: s.prefill, notes: s.notes }, failedTry);
        paid = true;
        active = (await api('/billing/razorpay/subscription-verify', { body: { subscriptionId: r.razorpay_subscription_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature } })).active;
      }
      await queryClient.invalidateQueries();
      if (!active) { setMsg('Payment received, activating… refresh in a minute.'); return; }
      setMsg("You're Plus! 🎉"); setTimeout(close, 900);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'all_free') { setMsg(''); queryClient.invalidateQueries({ queryKey: ['meta'] }); queryClient.invalidateQueries({ queryKey: ['me'] }); }
      else if (e instanceof ApiError && e.code === 'launch_offer_free') { setServerSaysFree(true); setMsg(''); queryClient.invalidateQueries({ queryKey: ['billing-me'] }); queryClient.invalidateQueries({ queryKey: ['billing'] }); }
      else if ((e as Error).message === 'dismissed') setMsg('');
      else if (paid) setMsg('Payment received, activating… refresh in a minute.');
      else setMsg(e instanceof ApiError ? e.message : 'Could not start the purchase.');
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!sub || !window.confirm(`Cancel Plus? You keep it until ${day(sub.expiresAt)}, then it won't renew.`)) return;
    setBusy(true); setMsg('');
    try { await api('/billing/razorpay/cancel', { body: {} }); await queryClient.invalidateQueries(); setMsg(`Cancelled. Plus stays until ${day(sub.expiresAt)}.`); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <LinearGradient colors={['#FFE7DE', '#FFFFFF']} style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={intro ? 'Not now' : 'Close'} onPress={close} style={{ padding: 20 }} hitSlop={12}><Ionicons name="close" size={28} color={C.ink} /></Pressable>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 24, gap: 18, paddingBottom: 40, maxWidth: 560, width: '100%', alignSelf: 'center' }}>
          {!free.ready ? <ActivityIndicator color={C.primary} style={{ marginTop: 20 }} /> : free.allFree ? <>
            <T style={{ fontFamily: F.xb, color: C.primary, fontSize: 15, letterSpacing: 2 }}>TABLAMIGO</T>
            <AllFreeCard />
            {sub && !sub.cancelled ? <Muted>You still have a Plus subscription from before. It renews automatically until you cancel it below.</Muted> : null}
            {msg ? <T style={{ textAlign: 'center', fontFamily: F.sb }}>{msg}</T> : null}
            <Button title="Got it" onPress={close} />
          </> : <>
          <T style={{ fontFamily: F.xb, color: C.primary, fontSize: 15, letterSpacing: 2 }}>TABLAMIGO PLUS</T>
          <H1 style={{ fontSize: 32, lineHeight: 38 }}>{intro ? 'Want more from every trip?' : reasonHeading(reason)}</H1>
          {intro ? <Muted style={{ lineHeight: 20 }}>Tablamigo is free to use. Plus adds these, whenever you want them.</Muted> : null}
          <View style={{ gap: 14, marginTop: 4 }}>
            {PERKS.map(([e, t, s]) => <View key={t} style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
              <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' }}><T style={{ fontSize: 22 }}>{e}</T></View>
              <View style={{ flex: 1 }}><T style={{ fontFamily: F.b, fontSize: 15.5 }}>{t}</T><Muted style={{ fontSize: 13 }}>{s}</Muted></View></View>)}
          </View>
          <Muted style={{ fontSize: 13, lineHeight: 19 }}>{ALWAYS_FREE}</Muted>
          {q.data?.plus && q.data.plusUntil && (!offer.active || sub) ? <View style={{ padding: 16, borderRadius: R.lg, backgroundColor: '#fff' }}>
            <T style={{ fontFamily: F.b }}>You have Plus until {day(q.data.plusUntil)}</T>
            <Muted>{sub ? (sub.cancelled ? "Your subscription is cancelled and won't renew." : 'Your subscription renews automatically.') : 'A Trip Pass adds its days after that.'}</Muted></View> : null}
          {offer.active ? <LaunchOfferCard offer={offer} /> : <>
            {q.isLoading || !offerKnown ? <ActivityIndicator color={C.primary} style={{ marginTop: 20 }} />
            : !rzp ? <View style={{ padding: 16, borderRadius: R.lg, backgroundColor: '#fff' }}><T style={{ fontFamily: F.b }}>Plus is launching soon</T><Muted>Payments on the web open shortly.</Muted></View>
            : <View style={{ gap: 10, marginTop: 6 }}>
                {plans.map(p => (
                  <Pressable key={p.id} onPress={() => setSel(p.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderRadius: R.lg, backgroundColor: '#fff', borderWidth: 2, borderColor: chosen?.id === p.id ? C.primary : C.line }}>
                    <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: chosen?.id === p.id ? C.primary : C.ink3, alignItems: 'center', justifyContent: 'center' }}>{chosen?.id === p.id ? <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: C.primary }} /> : null}</View>
                    <View style={{ flex: 1 }}><T style={{ fontFamily: F.b, fontSize: 16 }}>{p.label}</T>{p.badge ? <T style={{ fontFamily: F.b, fontSize: 12, color: C.primary }}>{p.badge}</T> : null}</View>
                    <T style={{ fontFamily: F.xb, fontSize: 17 }}>{p.price}</T>
                  </Pressable>
                ))}
              </View>}
            {rzp && chosen && chosen.id !== 'pass' ? <Input placeholder="Creator code (optional)" value={coupon} onChangeText={t => setCoupon(t.replace(/[^A-Za-z0-9]/g, '').slice(0, 16))} autoCapitalize="characters" autoCorrect={false} accessibilityLabel="Creator code (optional)" /> : null}
            {msg ? <T style={{ textAlign: 'center', fontFamily: F.sb }}>{msg}</T> : null}
            {rzp && plans.length ? <Button title="Continue" loading={busy} onPress={buy} /> : null}
            {intro ? <Button title="Not now" kind="ghost" onPress={close} /> : null}
            <Pressable
              onPress={() => router.push('/referral' as any)}
              style={{ backgroundColor: '#fff', borderRadius: R.lg, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: '#FED7AA' }}
            >
              <T style={{ fontSize: 24 }}>🎁</T>
              <View style={{ flex: 1 }}>
                <T style={{ fontFamily: F.b, fontSize: 14, color: C.ink }}>Want Plus for free?</T>
                <Muted style={{ fontSize: 12 }}>{EARN_PLUS_LINE}</Muted>
              </View>
              <Ionicons name="chevron-forward" size={18} color={C.ink3} />
            </Pressable>
            <Muted style={{ fontSize: 12, textAlign: 'center', lineHeight: 18 }}>{chosen?.id === 'pass' ? `Trip Pass is a one-time purchase: ${q.data?.pass.days ?? 14} days of Plus, added after any Plus you already have. Nothing renews.` : 'Auto-renews until cancelled. Cancel anytime here under Manage subscription. Payments by Razorpay.'}</Muted>
          </>}
          </>}
          {sub && !sub.cancelled ? <T onPress={cancel} style={{ textAlign: 'center', color: C.ink2, fontSize: 13, textDecorationLine: 'underline' }}>Manage subscription</T> : null}
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}
