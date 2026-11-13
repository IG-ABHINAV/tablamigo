import React, { useState } from 'react';
import { Pressable, ScrollView, View, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useSafeEdges } from '../lib/safe-edges';
import { T, H1, Muted, Button } from '../components/ui';
import { ActivityCard, type Activity } from '../components/ActivityCard';
import { useQuickJoin } from '../lib/useQuickJoin';
import { api } from '../lib/api';
import { useHere } from '../lib/useHere';
import { firstName, startPlans } from '../lib/next-step';
import { afterStart } from '../lib/plus-intro';
import { PushOffer } from '../components/PushOffer';
import { C, F, R } from '../lib/theme';

/**
 * Right after onboarding (lib/next-step.ts says why): add a trip, or join a plan near you, or look around. Each action opens
 * its screen on top of this one, so coming back lands here; "Take me to Explore" leaves it, through the one-time Plus screen
 * when the API says this account gets it (lib/plus-intro.ts), else straight to the app. The notifications explanation slides up
 * here once (components/PushOffer.tsx), so people hear about plans and replies even if they never add a trip or join a plan.
 */
export default function Start() {
  const quickJoin = useQuickJoin('start');
  const safeEdges = useSafeEdges();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<any>('/me') });
  const { here, settled } = useHere();
  const acts = useQuery({
    queryKey: ['start-plans', here?.lat.toFixed(3), here?.lng.toFixed(3)],
    queryFn: () => api<{ activities: Activity[]; wider?: { radiusKm: number; activities: Activity[] } | null }>(`/activities?lat=${here!.lat}&lng=${here!.lng}&when=week`),
    enabled: !!here,
  });
  const { plans, radiusKm } = startPlans(acts.data?.activities, acts.data?.wider);
  const name = firstName(me.data?.name);
  const city = here?.city ?? null;
  const [leaving, setLeaving] = useState(false);
  const explore = async () => { if (leaving) return; setLeaving(true); router.replace(await afterStart(api)); };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={safeEdges}>
      <ScrollView contentContainerStyle={{ padding: 24, gap: 18, paddingBottom: 40 }}>
        <View style={{ gap: 6 }}>
          <H1>{name ? `You're in, ${name}.` : "You're in."}</H1>
          <Muted style={{ lineHeight: 21 }}>Two ways to meet people this week. You can do both.</Muted>
        </View>

        <Pressable onPress={() => router.push('/trip/new')} accessibilityRole="button" accessibilityLabel="Add your next trip"
          style={({ pressed }) => [{ backgroundColor: C.primarySoft, borderRadius: R.lg, padding: 18, gap: 6, borderWidth: 1, borderColor: C.primary, transform: [{ scale: pressed ? 0.985 : 1 }] }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <T style={{ fontSize: 26 }}>✈️</T>
            <T style={{ fontFamily: F.xb, fontSize: 18, flex: 1 }}>Add your next trip</T>
            <Ionicons name="chevron-forward" size={20} color={C.ink2} />
          </View>
          <Muted style={{ lineHeight: 20 }}>Where and when. You'll see who's in town on your dates, and we'll message you both when someone's trip overlaps yours.</Muted>
        </Pressable>

        <View style={{ gap: 10 }}>
          <T style={{ fontFamily: F.xb, fontSize: 18 }}>🍜 Join a plan near you</T>
          {!here ? <Muted style={{ lineHeight: 20 }}>{settled ? 'Pick your city on Explore to see the plans there.' : 'Finding where you are…'}</Muted>
            : acts.isLoading ? <ActivityIndicator color={C.primary} style={{ marginVertical: 12 }} />
            : plans.length ? <>
                <Muted style={{ lineHeight: 20 }}>{radiusKm ? `Nothing right next to you yet. The nearest, within ${radiusKm} km:` : `Open to anyone${city ? ` in ${city}` : ''}. Join, then say hi in the plan's chat.`}</Muted>
                {plans.map(a => <ActivityCard key={a.id} a={a} compact quickJoin={quickJoin} />)}
              </>
            : <>
                <Muted style={{ lineHeight: 20 }}>{city ? `No plans in ${city} this week yet.` : 'No plans near you this week yet.'} Post one: travellers nearby see it on their map.</Muted>
                <Button title="Start a plan" kind="soft" onPress={() => router.push('/activity/new')} />
              </>}
        </View>

        <Button title="Take me to Explore" kind="ghost" loading={leaving} onPress={explore} />
      </ScrollView>
      {quickJoin.sheet}
      <PushOffer />
    </SafeAreaView>
  );
}
