import React, { useEffect, useRef } from 'react';
import { Platform, Text, View, useWindowDimensions } from 'react-native';
import { Stack, router, usePathname, useSegments, useRootNavigationState } from 'expo-router';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts, PlusJakartaSans_400Regular, PlusJakartaSans_500Medium, PlusJakartaSans_600SemiBold, PlusJakartaSans_700Bold, PlusJakartaSans_800ExtraBold } from '@expo-google-fonts/plus-jakarta-sans';
import { useSession } from '../lib/session';
import { api, ApiError } from '../lib/api';
import { C } from '../lib/theme';
import { setModalRoute } from '../lib/overlay';
import { columnStyle } from '../lib/wide';
import '../lib/install-referrer';   // web: keeps ?ref= (invite code) and utm_* from the first address, before any redirect drops them
import '../lib/viewport';   // web: keeps the app inside the visible area above the keyboard (no-op on phones)

SplashScreen.preventAutoHideAsync().catch(() => {});
import { queryClient } from '../lib/query';
import { ReportHost } from '../components/ReportHost';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { ReviewCard } from '../components/ReviewCard';
import { UpdateBanner } from '../components/UpdateBanner';
import { startUpdateChecks } from '../lib/update-prompt';
import '../lib/pwa';

/** Tells lib/overlay.ts when a modal screen (paywall, new plan, new trip, pick a city) is open, so no rating ask lands on it. */
function ModalRouteWatch() {
  const pathname = usePathname();
  useEffect(() => { setModalRoute(pathname); }, [pathname]);
  return null;
}

function Gate() {
  const { tokens, ready } = useSession();
  const segments = useSegments();
  // Redirecting before the root navigator mounts triggers state updates on unmounted screens.
  const navReady = !!useRootNavigationState()?.key;
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me'), enabled: !!tokens });
  // A banned account's saved session: every call is refused (403), so sign out and say why on the welcome screen.
  const banned = !!tokens && me.error instanceof ApiError && me.error.code === 'banned';
  const suspended = useRef(false);
  useEffect(() => {
    if (!banned) return;
    suspended.current = true;
    useSession.getState().setTokens(null).then(() => queryClient.clear());
  }, [banned]);
  useEffect(() => {
    if (!ready || !navReady || banned) return;
    const inAuth = segments[0] === '(auth)';
    // Two read-only pages are for people who may have no account: a plan shared for safety (/safe/<token>) and a shared
    // moment (/m/<id>). Opened signed out, they stay put instead of going to the welcome screen.
    const publicPage = (segments as string[])[0] === 'safe' || (segments as string[])[0] === 'm';
    if (me.data) suspended.current = false;
    if (!tokens) { if (!inAuth && !publicPage) router.replace(suspended.current ? { pathname: '/(auth)/welcome', params: { suspended: '1' } } : '/(auth)/welcome'); }
    else if (me.data && !me.data.onboarded) { if ((segments as string[])[1] !== 'onboarding') router.replace('/(auth)/onboarding'); }
    else if (me.data && inAuth) router.replace('/(tabs)');
    if (!tokens || me.data || me.isError) SplashScreen.hideAsync().catch(() => {});
  }, [ready, navReady, tokens, me.data, me.isError, segments, banned]);
  return null;
}

/** Over everything while an admin looks through someone's account (web only): nothing can be changed from here. */
function ImpersonationBar() {
  const on = useSession(s => s.impersonating);
  if (!on) return null;
  return <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#7C2D12', paddingVertical: 4, alignItems: 'center' }}>
    <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>Admin view · read-only · ends in 15 minutes</Text>
  </View>;
}

export default function Root() {
  const [fonts] = useFonts({ PlusJakartaSans_400Regular, PlusJakartaSans_500Medium, PlusJakartaSans_600SemiBold, PlusJakartaSans_700Bold, PlusJakartaSans_800ExtraBold });
  const load = useSession(s => s.load);
  useEffect(() => { load(); }, []);
  // Google Play's in-app update: asks Play at most once a day, from app start and every return to the foreground.
  useEffect(() => { startUpdateChecks(); }, []);
  // Wide web windows: each screen is a centred column (lib/wide.ts); the tabs set their own (the map stays full width).
  const column = columnStyle(Platform.OS, useWindowDimensions().width, C.line);
  if (!fonts) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: column ? C.bgSoft : C.bg }}>
      <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="dark" />
        <Gate />
        <ModalRouteWatch />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg, ...column }, animation: 'slide_from_right' }}>
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(tabs)" options={{ contentStyle: { backgroundColor: C.bg } }} />
          <Stack.Screen name="activity/new" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
          <Stack.Screen name="paywall" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
          <Stack.Screen name="trip/new" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
          <Stack.Screen name="pick-city" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        </Stack>
        <ReportHost />
        <ReviewCard />
        <UpdateBanner />
        <ImpersonationBar />
      </QueryClientProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}
