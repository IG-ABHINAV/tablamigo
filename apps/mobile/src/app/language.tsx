import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { T, H1, Muted } from '../components/ui';
import { api } from '../lib/api';
import { FEATURES } from '../lib/config';
import { queryClient } from '../lib/query';
import { C, F, R, shadow } from '../lib/theme';
import { t, type Locale } from '../lib/i18n';

type TimeFormat = '12h' | '24h';
type Currency = 'INR' | 'USD' | 'EUR';

function LanguageSettings() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me') });
  const prefs = useQuery({
    queryKey: ['localePreferences'],
    queryFn: () => api('/me/locale-preferences'),
  });

  // What the person has chosen on this screen wins; until they choose, what the server has.
  const saved = prefs.data ?? me.data;
  const [local, setLocal] = useState<{ locale?: Locale; timeFormat?: TimeFormat; currency?: Currency }>({});
  const locale: Locale = local.locale ?? saved?.locale ?? 'en';
  const timeFormat: TimeFormat = local.timeFormat ?? saved?.timeFormat ?? '12h';
  const currency: Currency = local.currency ?? saved?.currency ?? 'INR';

  const saveMutation = useMutation({
    mutationFn: (patch: { locale?: Locale; timeFormat?: TimeFormat; currency?: Currency }) =>
      api('/me/locale-preferences', { method: 'PATCH', body: patch }),
    onSuccess: r => {
      queryClient.setQueryData(['localePreferences'], r.preferences);
      queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  const selectLocale = (loc: Locale) => {
    Haptics.selectionAsync().catch(() => {});
    setLocal(l => ({ ...l, locale: loc }));
    saveMutation.mutate({ locale: loc });
  };

  const selectTimeFormat = (fmt: TimeFormat) => {
    Haptics.selectionAsync().catch(() => {});
    setLocal(l => ({ ...l, timeFormat: fmt }));
    saveMutation.mutate({ timeFormat: fmt });
  };

  const selectCurrency = (cur: Currency) => {
    Haptics.selectionAsync().catch(() => {});
    setLocal(l => ({ ...l, currency: cur }));
    saveMutation.mutate({ currency: cur });
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={12} style={{ padding: 4 }}>
          <Ionicons name="chevron-back" size={28} color={C.ink} />
        </Pressable>
        <T style={{ fontFamily: F.b, fontSize: 17 }}>Language & Region</T>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, gap: 24, paddingBottom: 60 }}>
        <View style={{ gap: 4 }}>
          <H1>Language & Region</H1>
          <Muted>Choose your preferred interface language, time format, and currency.</Muted>
        </View>

        {/* Language Options */}
        <View style={{ gap: 10 }}>
          <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {t('language', locale)}
          </T>
          <View style={[{ backgroundColor: '#fff', borderRadius: R.lg, borderWidth: 1, borderColor: C.line, overflow: 'hidden' }, shadow]}>
            {([
              { id: 'en', flag: '🇬🇧', label: 'English', native: 'English', desc: 'Default international language' },
              { id: 'hi', flag: '🇮🇳', label: 'Hindi', native: 'हिन्दी', desc: 'पूर्ण भारतीय क्षेत्रीय अनुभव' },
              { id: 'es', flag: '🇪🇸', label: 'Spanish', native: 'Español', desc: 'Experiencia global en español' },
            ] as const).map((item, idx) => {
              const active = locale === item.id;
              return (
                <Pressable
                  key={item.id}
                  onPress={() => selectLocale(item.id)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    padding: 16,
                    gap: 14,
                    borderTopWidth: idx > 0 ? 1 : 0,
                    borderColor: C.line,
                    backgroundColor: active ? C.primarySoft : 'transparent',
                  }}
                >
                  <T style={{ fontSize: 26 }}>{item.flag}</T>
                  <View style={{ flex: 1, gap: 2 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <T style={{ fontFamily: active ? F.b : F.m, fontSize: 16, color: active ? C.primaryDark : C.ink }}>
                        {item.native}
                      </T>
                      {item.native !== item.label ? (
                        <Muted style={{ fontSize: 13 }}>({item.label})</Muted>
                      ) : null}
                    </View>
                    <Muted style={{ fontSize: 12 }}>{item.desc}</Muted>
                  </View>
                  <Ionicons
                    name={active ? 'checkmark-circle' : 'ellipse-outline'}
                    size={22}
                    color={active ? C.primary : C.ink3}
                  />
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Live Translation Preview */}
        <View style={{ gap: 8 }}>
          <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {t('previewTitle', locale)}
          </T>
          <View style={[{ backgroundColor: '#fff', borderRadius: R.lg, padding: 18, borderWidth: 1, borderColor: C.line, gap: 12 }, shadow]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ backgroundColor: C.primarySoft, paddingHorizontal: 10, paddingVertical: 4, borderRadius: R.pill }}>
                <T style={{ color: C.primaryDark, fontFamily: F.b, fontSize: 12 }}>{t('plansNearby', locale).toUpperCase()}</T>
              </View>
              <T style={{ fontSize: 12, color: C.ink2 }}>{timeFormat === '24h' ? '19:30' : '7:30 PM'}</T>
            </View>
            <View style={{ gap: 4 }}>
              <T style={{ fontFamily: F.b, fontSize: 17, color: C.ink }}>{t('sampleTitle', locale)}</T>
              <Muted style={{ fontSize: 13 }}>{t('sampleSubtitle', locale)}</Muted>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: R.pill, backgroundColor: C.goSoft, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <T style={{ fontSize: 12, color: C.go, fontFamily: F.b }}>✓ {t('going', locale)}</T>
              </View>
              <View style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: R.pill, backgroundColor: C.bgSoft }}>
                <T style={{ fontSize: 12, color: C.ink2, fontFamily: F.m }}>{t('maybe', locale)}</T>
              </View>
            </View>
            <View style={{ height: 40, borderRadius: R.pill, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' }}>
              <T style={{ color: '#fff', fontFamily: F.b, fontSize: 15 }}>{t('joinPlan', locale)}</T>
            </View>
          </View>
        </View>

        {/* Regional Time Format */}
        <View style={{ gap: 10 }}>
          <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {t('timeFormat', locale)}
          </T>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {([
              { id: '12h', label: '12-Hour', example: '7:30 PM' },
              { id: '24h', label: '24-Hour', example: '19:30' },
            ] as const).map(item => {
              const active = timeFormat === item.id;
              return (
                <Pressable
                  key={item.id}
                  onPress={() => selectTimeFormat(item.id)}
                  style={[{
                    flex: 1,
                    backgroundColor: active ? C.primarySoft : '#fff',
                    borderRadius: R.md,
                    borderWidth: 2,
                    borderColor: active ? C.primary : C.line,
                    padding: 14,
                    alignItems: 'center',
                    gap: 4,
                  }, shadow]}
                >
                  <T style={{ fontFamily: F.b, fontSize: 15, color: active ? C.primaryDark : C.ink }}>{item.label}</T>
                  <Muted style={{ fontSize: 12 }}>{item.example}</Muted>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Currency Display */}
        <View style={{ gap: 10 }}>
          <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {t('currencyDisplay', locale)}
          </T>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {([
              { id: 'INR', symbol: '₹', label: 'INR (₹)', name: 'Indian Rupee' },
              { id: 'USD', symbol: '$', label: 'USD ($)', name: 'US Dollar' },
              { id: 'EUR', symbol: '€', label: 'EUR (€)', name: 'Euro' },
            ] as const).map(item => {
              const active = currency === item.id;
              return (
                <Pressable
                  key={item.id}
                  onPress={() => selectCurrency(item.id)}
                  style={[{
                    flex: 1,
                    backgroundColor: active ? C.primarySoft : '#fff',
                    borderRadius: R.md,
                    borderWidth: 2,
                    borderColor: active ? C.primary : C.line,
                    padding: 12,
                    alignItems: 'center',
                    gap: 2,
                  }, shadow]}
                >
                  <T style={{ fontSize: 18, fontFamily: F.b, color: active ? C.primaryDark : C.ink }}>{item.symbol}</T>
                  <T style={{ fontFamily: F.b, fontSize: 13, color: active ? C.primaryDark : C.ink }}>{item.id}</T>
                </Pressable>
              );
            })}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// Hidden for now (FEATURES.languagePicker, lib/config.ts): a deep link to this screen lands on the profile instead.
export default function LanguageRoute() {
  return FEATURES.languagePicker ? <LanguageSettings /> : <Redirect href="/(tabs)/profile" />;
}
