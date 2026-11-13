import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, View, ActivityIndicator, Linking, BackHandler } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { fetchProducts, requestPurchase } from 'expo-iap';
import { useQuery } from '@tanstack/react-query';
import { T, H1, Muted, Button } from '../components/ui';
import { api, trackEvent } from '../lib/api';
import { SKU, PASS, connectPlay, onPurchaseEvent, startPlayPurchases } from '../lib/play-billing';
import { C, F, R } from '../lib/theme';
import { ALWAYS_FREE, EARN_PLUS_LINE, PERKS, PLAY_UNAVAILABLE, paywallReason, reasonHeading, paywallPlusState, renewalNotice } from '../lib/paywall-copy';
import { useLaunchOffer } from '../lib/useLaunchOffer';
import { LaunchOfferCard } from '../components/LaunchOfferCard';
import { AllFreeCard } from '../components/AllFreeCard';
import { useAllFree } from '../lib/useAllFree';
import { halfYearDeal, introLine, introOrder, pickPlayOffers, planOrder, purchaseToken, trialLine, yearlyBadge, yearlyDeal, type PlayIntro, type PlayPlan, type PlayTrial } from '../lib/plus-intro';

// intro: Play's own price string for an intro offer's first period (lib/plus-intro.ts); offerLine says what it is and what follows.
type Plan = { basePlan: string; price: string; token?: string | null; label: string; badge?: string; amount?: number | null; currency?: string | null; intro?: string | null; offerLine?: string };

/**
 * While everything in Tablamigo is free (lib/all-free.ts) the paywall only says so: no plans, no prices, no buy button, and
 * Google Play Billing is never even connected. The paid screen below comes back by itself once the API says allFree: false.
 */
export default function Paywall() {
  const free = useAllFree();
  if (!free.ready) return <LinearGradient colors={['#FFE7DE', '#FFFFFF']} style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator color={C.primary} /></LinearGradient>;
  return free.allFree ? <AllFreePaywall /> : <PaidPaywall />;
}

function AllFreePaywall() {
  const { reason } = useLocalSearchParams<{ reason?: string }>();
  useEffect(() => { trackEvent('paywall_viewed', { reason: paywallReason(reason), surface: 'native', allFree: true }); }, [reason]);
  return (
    <LinearGradient colors={['#FFE7DE', '#FFFFFF']} style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1 }}>
        <Pressable onPress={() => router.back()} style={{ padding: 20, alignSelf: 'flex-start' }} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close"><Ionicons name="close" size={28} color={C.ink} /></Pressable>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 24, gap: 18, paddingBottom: 40 }}>
          <T style={{ fontFamily: F.xb, color: C.primary, fontSize: 15, letterSpacing: 2 }}>TABLAMIGO</T>
          <AllFreeCard />
          <Button title="Got it" onPress={() => router.back()} />
          {/* Anyone who subscribed before everything went free can still cancel in Google Play. */}
          <T onPress={() => Linking.openURL('https://play.google.com/store/account/subscriptions')} style={{ textAlign: 'center', color: C.ink2, fontSize: 13, textDecorationLine: 'underline' }}>Manage subscriptions</T>
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

function PaidPaywall() {
  const { reason, plan, intro: introParam } = useLocalSearchParams<{ reason?: string; plan?: string; intro?: string }>();
  // ?intro=1: the soft paywall once after onboarding (lib/plus-intro.ts). Yearly first and chosen, monthly and the Trip Pass
  // as the alternatives, and "Not now" that goes on into the app.
  const intro = introParam === '1';
  const [offers, setOffers] = useState<any[] | null>(null); const [passPlan, setPassPlan] = useState<Plan | null>(null);
  const [sel, setSel] = useState(plan === 'pass' ? 'pass' : plan === 'halfyearly' ? 'halfyearly' : intro || plan === 'yearly' ? 'yearly' : 'monthly');
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(''); const [storeOk, setStoreOk] = useState(true);
  const offer = useLaunchOffer();
  // Already Plus? A renewing subscription (here or on the website) gets no second Subscribe button: it would bill twice.
  const billing = useQuery({ queryKey: ['billing-me'], queryFn: () => api('/billing/me') });
  const plusState = paywallPlusState(billing.data);
  const [attempt, setAttempt] = useState(0);
  // The yearly free trial: only when the API names a Play offer and Play returns it for this person (lib/plus-intro.ts).
  // playTrialOfferId: since 2 Nov 2026 the trial includes a discounted first year, which this screen describes.
  const trialOfferId: string | null = billing.data?.playTrialOfferId ?? null;
  const billingKnown = !billing.isLoading;
  const { plans, trial, intros } = useMemo(() => {
    // Wait for the API's answer, so the yearly row never changes (trial or not) under a finger already on Subscribe.
    if (!billingKnown) return { plans: [] as Plan[], trial: null, intros: {} as Record<string, PlayIntro> };
    const labels: Record<string, [string, string?]> = { weekly: ['1 week'], monthly: ['1 month', 'Most popular'], halfyearly: ['6 months'], yearly: ['12 months', 'Best value'] };
    const picked = pickPlayOffers(offers, trialOfferId);
    const byPlan: Plan[] = picked.plans.map((p: PlayPlan) => ({ ...p, label: labels[p.basePlan]?.[0] ?? p.basePlan, badge: labels[p.basePlan]?.[1] }));
    const m = byPlan.find(p => p.basePlan === 'monthly'), h = byPlan.find(p => p.basePlan === 'halfyearly'), y = byPlan.find(p => p.basePlan === 'yearly');
    if (y && y.currency && m?.currency === y.currency) { const b = yearlyBadge(yearlyDeal(m.amount, y.amount), y.currency); if (b) y.badge = `Best value · ${b}`; }
    // The 6-month row: its per-month price and saving against monthly, never "Best value" (yearly keeps that).
    if (h && h.currency && m?.currency === h.currency) { const b = yearlyBadge(halfYearDeal(m.amount, h.amount), h.currency); if (b) h.badge = b; }
    if (passPlan) byPlan.push(passPlan);
    const t: PlayTrial | null = y ? picked.trial : null;
    // Intro offers (new customers only, so Play returns them only to someone who never had Plus there): the row shows the first
    // period's price and says what comes after it. A yearly trial replaces the yearly intro: it already holds the discounted year.
    for (const p of byPlan) { const i = picked.intros[p.basePlan]; if (i) { p.intro = i.price; p.offerLine = introLine(p.basePlan, i.price, p.price); } }
    if (y && t) { y.intro = t.intro ?? null; y.offerLine = trialLine(t.days, y.price, t.intro); }
    return { plans: intro ? introOrder(byPlan) : planOrder(byPlan), trial: t, intros: picked.intros };
  }, [offers, passPlan, trialOfferId, intro, billingKnown]);
  // Leaving: the intro was opened in place of the app (router.replace from the start screen), so it goes on into the app.
  const leave = () => intro ? router.replace('/(tabs)') : router.back();
  // Android's back button on the intro does what "Not now" does (there is no screen under it to go back to).
  useEffect(() => {
    if (!intro) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { router.replace('/(tabs)'); return true; });
    return () => sub.remove();
  }, [intro]);

  useEffect(() => {
    trackEvent('paywall_viewed', { reason: intro ? 'intro' : paywallReason(reason), surface: 'native' });
  }, [reason, intro]);

  useEffect(() => {
    let alive = true;
    // Purchases are verified by lib/play-billing.ts, which keeps listening after this screen closes (a UPI payment can settle
    // later); started here too in case the paywall opened before the tabs did. This screen only shows the outcome.
    startPlayPurchases();
    const off = onPurchaseEvent(e => {
      if (!alive) return;
      if (e.kind === 'verified') { setBusy(false); setMsg("You're Plus! 🎉"); setTimeout(() => (intro ? router.replace('/(tabs)') : router.back()), 900); }
      else if (e.kind === 'pending') { setBusy(false); setMsg('Payment pending. Plus switches on once it is paid: keep Tablamigo open, or open it again after you pay.'); }
      else if (e.kind === 'verify_failed') { setBusy(false); setMsg('Payment received, activating… pull to refresh in a minute.'); }
      else { setBusy(false); if (e.code !== 'user-cancelled') setMsg('Purchase did not go through.'); }
    });
    (async () => {
      try {
        if (!(await connectPlay())) throw new Error('play_unavailable');
        const prods: any[] = (await fetchProducts({ skus: [SKU], type: 'subs' })) ?? [];
        const subOffers: any[] = prods[0]?.subscriptionOffers ?? [];
        const pass: any = ((await fetchProducts({ skus: [PASS], type: 'in-app' }).catch(() => [])) ?? [])[0];
        if (!alive) return;
        if (!pickPlayOffers(subOffers, null).plans.length && !pass) { setStoreOk(false); return; }
        setOffers(subOffers);
        setPassPlan(pass ? { basePlan: 'pass', price: pass.displayPrice, label: 'Trip Pass · 14 days', badge: 'One-time, nothing renews' } : null);
      } catch { if (alive) setStoreOk(false); }
    })();
    return () => { alive = false; off(); };
  }, [attempt, intro]);

  // The plan the radio shows and the button buys. One the store doesn't offer falls back to monthly, then the first one it does.
  const chosen = plans.find(x => x.basePlan === sel) ?? plans.find(x => x.basePlan === 'monthly') ?? plans[0];
  const buy = async () => {
    const p = chosen; if (!p) return;
    setBusy(true); setMsg('');
    if (p.basePlan === 'pass') {
      try { await requestPurchase({ request: { google: { skus: [PASS] } } as any, type: 'in-app' }); }
      catch { setBusy(false); setMsg('Could not start the purchase.'); }
      return;
    }
    // Exactly one offer per purchase: the yearly trial while it is offered, else the plan's intro offer, else the base plan.
    const token = purchaseToken(p.basePlan, p.token, trial, intros);
    if (!token) { setBusy(false); return; }
    try { await requestPurchase({ request: { google: { skus: [SKU], subscriptionOffers: [{ sku: SKU, offerToken: token }] } } as any, type: 'subs' }); }
    catch { setBusy(false); setMsg('Could not start the purchase.'); }
  };

  return (
    <LinearGradient colors={['#FFE7DE', '#FFFFFF']} style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1 }}>
        <Pressable onPress={leave} style={{ padding: 20, alignSelf: 'flex-start' }} hitSlop={12} accessibilityRole="button" accessibilityLabel={intro ? 'Not now' : 'Close'}><Ionicons name="close" size={28} color={C.ink} /></Pressable>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 24, gap: 18, paddingBottom: 40 }}>
          <T style={{ fontFamily: F.xb, color: C.primary, fontSize: 15, letterSpacing: 2 }}>TABLAMIGO PLUS</T>
          <H1 style={{ fontSize: 32, lineHeight: 38 }}>{intro ? 'Want more from every trip?' : reasonHeading(reason)}</H1>
          {intro ? <Muted style={{ lineHeight: 20 }}>Tablamigo is free to use. Plus adds these, whenever you want them.</Muted> : null}
          {/* Already Plus: say so before the perks, so nobody reads the page as an offer to buy again. */}
          {plusState.kind !== 'none' ? <View style={{ padding: 16, borderRadius: R.lg, backgroundColor: '#fff', gap: 4, borderWidth: 2, borderColor: C.primary }}>
            <T style={{ fontFamily: F.b, fontSize: 16 }}>⭐ {plusState.line}</T>
            <Muted>{plusState.kind === 'renewing'
              ? (plusState.where === 'google' ? 'Your Google Play subscription renews automatically. Change or cancel it under Manage subscriptions below.'
                : 'Your subscription from the website renews automatically. Manage or cancel it where you subscribed, under Plus.')
              : 'Buying now adds to it: a Trip Pass adds its days after your current Plus; a subscription starts billing today.'}</Muted>
          </View> : null}
          <View style={{ gap: 14, marginTop: 4 }}>
            {PERKS.map(([e, t, s]) => <View key={t} style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
              <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' }}><T style={{ fontSize: 22 }}>{e}</T></View>
              <View style={{ flex: 1 }}><T style={{ fontFamily: F.b, fontSize: 15.5 }}>{t}</T><Muted style={{ fontSize: 13 }}>{s}</Muted></View></View>)}
          </View>
          <Muted style={{ fontSize: 13, lineHeight: 19 }}>{ALWAYS_FREE}</Muted>
          {/* The launch offer replaces everything that sells: the plans, the buy button, the renewal notice and the invite card. */}
          {/* A purchase result ("You're Plus!") must show even after the Plus card above replaces the plans. */}
          {plusState.kind === 'renewing' && msg ? <T style={{ textAlign: 'center', fontFamily: F.sb }}>{msg}</T> : null}
          {offer.active ? <LaunchOfferCard offer={offer} /> : plusState.kind === 'renewing' ? null : <>
            {!storeOk ? <View style={{ padding: 16, borderRadius: R.lg, backgroundColor: '#fff', gap: 10 }}>
                <T style={{ fontFamily: F.b }}>{PLAY_UNAVAILABLE.title}</T><Muted>{PLAY_UNAVAILABLE.body}</Muted>
                <Button title="Try again" kind="soft" onPress={() => { setStoreOk(true); setAttempt(n => n + 1); }} style={{ height: 44 }} />
              </View>
            : plans.length === 0 || !offer.ready ? <ActivityIndicator color={C.primary} style={{ marginTop: 20 }} />
            : <View style={{ gap: 10, marginTop: 6 }}>
                {plans.map(p => (
                  <Pressable key={p.basePlan} onPress={() => setSel(p.basePlan)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderRadius: R.lg, backgroundColor: '#fff', borderWidth: 2, borderColor: chosen?.basePlan === p.basePlan ? C.primary : C.line }}>
                    <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: chosen?.basePlan === p.basePlan ? C.primary : C.ink3, alignItems: 'center', justifyContent: 'center' }}>{chosen?.basePlan === p.basePlan ? <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: C.primary }} /> : null}</View>
                    <View style={{ flex: 1 }}><T style={{ fontFamily: F.b, fontSize: 16 }}>{p.label}</T>{p.badge ? <T style={{ fontFamily: F.b, fontSize: 12, color: C.primary }}>{p.badge}</T> : null}
                      {p.offerLine ? <T style={{ fontFamily: F.sb, fontSize: 12.5, color: C.ink, marginTop: 2 }}>{p.offerLine}</T> : null}</View>
                    {/* An intro price: the first period's price, with the normal price struck through above it. */}
                    <View style={{ alignItems: 'flex-end' }}>
                      {p.intro ? <T style={{ fontSize: 12.5, color: C.ink3, textDecorationLine: 'line-through' }}>{p.price}</T> : null}
                      <T style={{ fontFamily: F.xb, fontSize: 17, color: p.intro ? C.primary : C.ink }}>{p.intro ?? p.price}</T>
                    </View>
                  </Pressable>
                ))}
              </View>}
            {msg ? <T style={{ textAlign: 'center', fontFamily: F.sb }}>{msg}</T> : null}
            {storeOk && plans.length && offer.ready ? <Button title={chosen?.basePlan === 'pass' ? 'Buy Trip Pass' : chosen?.basePlan === 'yearly' && trial ? `Start ${trial.days}-day free trial` : 'Subscribe'} loading={busy} onPress={buy} /> : null}
            {/* Price, period, auto-renewal and how to cancel, right under the button: Google Play requires it before the purchase. */}
            {storeOk && chosen && offer.ready ? <Muted style={{ fontSize: 12.5, textAlign: 'center', lineHeight: 18 }}>{renewalNotice(chosen.basePlan, chosen.price, 14, chosen.basePlan === 'yearly' ? trial?.days : undefined, chosen.intro)}</Muted> : null}
            {intro ? <Button title="Not now" kind="ghost" onPress={leave} /> : null}
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
          </>}
          <T onPress={() => Linking.openURL('https://play.google.com/store/account/subscriptions')} style={{ textAlign: 'center', color: C.ink2, fontSize: 13, textDecorationLine: 'underline' }}>Manage subscriptions</T>
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}
