import React, { useState } from 'react';
import { Pressable, ScrollView, Switch, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { T, H1, H2, Muted, Button } from '../components/ui';
import { api } from '../lib/api';
import { FEATURES } from '../lib/config';
import { queryClient } from '../lib/query';
import { C, F, R, shadow, getThemeColors } from '../lib/theme';

type ThemeMode = 'system' | 'light' | 'dark';
type MapThemeMode = 'auto' | 'light' | 'dark';

function DisplaySettings() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me') });
  const prefs = useQuery({
    queryKey: ['displayPreferences'],
    queryFn: () => api('/me/display-preferences'),
  });

  // What the person has chosen on this screen wins; until they choose, what the server has.
  const saved = prefs.data ?? me.data;
  const [local, setLocal] = useState<{ theme?: ThemeMode; oledDark?: boolean; mapTheme?: MapThemeMode; highContrast?: boolean }>({});
  const theme: ThemeMode = local.theme ?? saved?.theme ?? 'system';
  const oledDark: boolean = local.oledDark ?? (typeof saved?.oledDark === 'boolean' ? saved.oledDark : false);
  const mapTheme: MapThemeMode = local.mapTheme ?? saved?.mapTheme ?? 'auto';
  const highContrast: boolean = local.highContrast ?? (typeof saved?.highContrast === 'boolean' ? saved.highContrast : false);

  const saveMutation = useMutation({
    mutationFn: (patch: { theme?: ThemeMode; oledDark?: boolean; mapTheme?: MapThemeMode; highContrast?: boolean }) =>
      api('/me/display-preferences', { method: 'PATCH', body: patch }),
    onSuccess: r => {
      queryClient.setQueryData(['displayPreferences'], r.preferences);
      queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  const updateTheme = (newTheme: ThemeMode) => {
    Haptics.selectionAsync().catch(() => {});
    setLocal(l => ({ ...l, theme: newTheme }));
    saveMutation.mutate({ theme: newTheme });
  };

  const updateOled = (val: boolean) => {
    Haptics.selectionAsync().catch(() => {});
    setLocal(l => ({ ...l, oledDark: val }));
    saveMutation.mutate({ oledDark: val });
  };

  const updateMapTheme = (newMap: MapThemeMode) => {
    Haptics.selectionAsync().catch(() => {});
    setLocal(l => ({ ...l, mapTheme: newMap }));
    saveMutation.mutate({ mapTheme: newMap });
  };

  const updateHighContrast = (val: boolean) => {
    Haptics.selectionAsync().catch(() => {});
    setLocal(l => ({ ...l, highContrast: val }));
    saveMutation.mutate({ highContrast: val });
  };

  const previewColors = getThemeColors(theme === 'system' ? 'light' : theme, oledDark, highContrast);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={12} style={{ padding: 4 }}>
          <Ionicons name="chevron-back" size={28} color={C.ink} />
        </Pressable>
        <T style={{ fontFamily: F.b, fontSize: 17 }}>Display & Theme</T>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, gap: 24, paddingBottom: 60 }}>
        <View style={{ gap: 4 }}>
          <H1>Appearance</H1>
          <Muted>Choose your preferred interface theme, contrast, and map styling.</Muted>
        </View>

        {/* Theme Options */}
        <View style={{ gap: 10 }}>
          <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>Theme Mode</T>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {([
              { id: 'light', label: 'Light', icon: 'sunny-outline', desc: 'Clean & warm' },
              { id: 'dark', label: 'Dark', icon: 'moon-outline', desc: 'Midnight slate' },
              { id: 'system', label: 'System', icon: 'phone-portrait-outline', desc: 'Match device' },
            ] as const).map(item => {
              const active = theme === item.id;
              return (
                <Pressable
                  key={item.id}
                  onPress={() => updateTheme(item.id)}
                  style={[{
                    flex: 1,
                    backgroundColor: active ? C.primarySoft : '#fff',
                    borderRadius: R.md,
                    borderWidth: 2,
                    borderColor: active ? C.primary : C.line,
                    padding: 14,
                    alignItems: 'center',
                    gap: 6,
                  }, shadow]}
                >
                  <Ionicons name={item.icon} size={24} color={active ? C.primary : C.ink} />
                  <T style={{ fontFamily: F.b, fontSize: 14, color: active ? C.primaryDark : C.ink }}>{item.label}</T>
                  <Muted style={{ fontSize: 11, textAlign: 'center' }}>{item.desc}</Muted>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Live Theme Preview */}
        <View style={{ gap: 8 }}>
          <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>Live Preview</T>
          <View style={[{
            backgroundColor: previewColors.card,
            borderRadius: R.lg,
            padding: 18,
            borderWidth: 1,
            borderColor: previewColors.line,
            gap: 12,
          }, shadow]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ backgroundColor: previewColors.primarySoft, paddingHorizontal: 10, paddingVertical: 4, borderRadius: R.pill }}>
                <T style={{ color: previewColors.primaryDark, fontFamily: F.b, fontSize: 12 }}>🍜 FOOD & DRINKS</T>
              </View>
              <T style={{ fontSize: 12, color: previewColors.ink2 }}>Today · 7:30 PM</T>
            </View>
            <View style={{ gap: 4 }}>
              <T style={{ fontFamily: F.b, fontSize: 18, color: previewColors.ink }}>Shibuya Ramen & Izakaya Crawl</T>
              <T style={{ fontSize: 14, color: previewColors.ink2 }}>Tokyo, Japan · 4 travelers attending</T>
            </View>
            <View style={{
              height: 40,
              borderRadius: R.pill,
              backgroundColor: previewColors.primary,
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <T style={{ color: '#fff', fontFamily: F.b, fontSize: 15 }}>Join Plan</T>
            </View>
          </View>
        </View>

        {/* Dark Theme Settings */}
        <View style={{ backgroundColor: '#fff', borderRadius: R.lg, borderWidth: 1, borderColor: C.line, overflow: 'hidden' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 }}>
            <View style={{ flex: 1, paddingRight: 16, gap: 2 }}>
              <T style={{ fontFamily: F.sb, fontSize: 15 }}>Pure Black (AMOLED)</T>
              <Muted style={{ fontSize: 12 }}>True pitch-black #000000 background for reduced battery usage on OLED displays.</Muted>
            </View>
            <Switch
              value={oledDark}
              onValueChange={updateOled}
              trackColor={{ true: C.primary, false: C.line }}
              thumbColor="#fff"
            />
          </View>

          <View style={{ height: 1, backgroundColor: C.line }} />

          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 }}>
            <View style={{ flex: 1, paddingRight: 16, gap: 2 }}>
              <T style={{ fontFamily: F.sb, fontSize: 15 }}>High Contrast</T>
              <Muted style={{ fontSize: 12 }}>Bolder borders and enhanced element contrast for clear outdoor visibility.</Muted>
            </View>
            <Switch
              value={highContrast}
              onValueChange={updateHighContrast}
              trackColor={{ true: C.primary, false: C.line }}
              thumbColor="#fff"
            />
          </View>
        </View>

        {/* Map Styling Options */}
        <View style={{ gap: 10 }}>
          <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>Map Style</T>
          <View style={{ backgroundColor: '#fff', borderRadius: R.lg, borderWidth: 1, borderColor: C.line, overflow: 'hidden' }}>
            {([
              { id: 'auto', label: 'Match App Theme', desc: 'Syncs map tiles with active light/dark mode', icon: 'sync-outline' },
              { id: 'light', label: 'Always Day / Light', desc: 'Clean positron high-contrast day tiles', icon: 'sunny-outline' },
              { id: 'dark', label: 'Always Night / Dark', desc: 'Dim tiles for evening exploration', icon: 'moon-outline' },
            ] as const).map((m, idx) => {
              const active = mapTheme === m.id;
              return (
                <Pressable
                  key={m.id}
                  onPress={() => updateMapTheme(m.id)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    padding: 16,
                    gap: 14,
                    borderTopWidth: idx > 0 ? 1 : 0,
                    borderColor: C.line,
                    backgroundColor: active ? C.bgSoft : 'transparent',
                  }}
                >
                  <Ionicons name={m.icon} size={22} color={active ? C.primary : C.ink2} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <T style={{ fontFamily: active ? F.b : F.m, fontSize: 15, color: active ? C.primaryDark : C.ink }}>{m.label}</T>
                    <Muted style={{ fontSize: 12 }}>{m.desc}</Muted>
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
      </ScrollView>
    </SafeAreaView>
  );
}

// Hidden for now (FEATURES.themePicker, lib/config.ts): a deep link to this screen lands on the profile instead.
export default function DisplayRoute() {
  return FEATURES.themePicker ? <DisplaySettings /> : <Redirect href="/(tabs)/profile" />;
}
