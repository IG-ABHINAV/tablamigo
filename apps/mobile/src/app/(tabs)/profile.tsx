import React, { useState } from 'react';
import { Alert, Image, Linking, Pressable, ScrollView, Switch, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { T, H1, Muted, Avatar, Chip, Button, Input } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { closeSocket } from '../../lib/socket';
import { pickAndUpload } from '../../lib/upload';
import { queryClient } from '../../lib/query';
import { LeaveSheet } from '../../components/LeaveSheet';
import { PhotoViewModal } from '../../components/PhotoViewModal';
import { SnoozeSheet, snoozeLabel } from '../../components/SnoozeSheet';
import { CountriesVisited } from '../../components/CountriesVisited';
import { InstallApp } from '../../components/InstallApp';
import { ProfilePromptsEdit } from '../../components/ProfilePrompts';
import { UserTimeline } from '../../components/UserTimeline';
import { SavedPlansSheet } from '../../components/SavedPlansSheet';
import { TrustedContactsManager } from '../../components/TrustedContactsManager';
import { NotificationsRow } from '../../components/NotificationsRow';
import { MyTicketsModal } from '../../components/MyTicketsModal';
import Constants from 'expo-constants';
import { LANGUAGES, toggleLanguage } from '../../lib/languages';
import { FEATURES } from '../../lib/config';
import { useLaunchOffer } from '../../lib/useLaunchOffer';
import { offerDate, offerShort, plusIsFromOffer } from '../../lib/launch-offer';
import { useAllFree } from '../../lib/useAllFree';
import { ALL_FREE_SHORT } from '../../lib/all-free';
import { TERMS_URL, PRIVACY_URL } from '../../lib/legal';
import { useAds, openAdPrivacyOptions } from '../../lib/ads';
import { plusUntilLine } from '../../lib/paywall-copy';
import { C, F, R, flag, interestLabel, interestEmoji, TRAVEL_STYLES, travelStyleLabel, travelStyleEmoji } from '../../lib/theme';

const Row = ({ icon, label, onPress, danger, detail }: { icon: any; label: string; onPress: () => void; danger?: boolean; detail?: string }) => (
  <Pressable onPress={onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 15, paddingHorizontal: 16, backgroundColor: pressed ? C.bgSoft : '#fff' })}>
    <Ionicons name={icon} size={21} color={danger ? C.danger : C.ink2} />
    <T style={{ flex: 1, fontFamily: F.sb, color: danger ? C.danger : C.ink }}>{label}</T>
    {detail ? <T style={{ fontFamily: F.b, color: C.ink2 }}>{detail}</T> : null}
    <Ionicons name="chevron-forward" size={18} color={C.ink3} />
  </Pressable>
);

/**
 * A settings switch's save. Offline (or a server error) it used to fail silently: the switch flipped back with no word.
 * Now the person is told, and the screen re-reads the account either way, so the switch shows what is saved.
 */
async function saveSetting(save: () => Promise<unknown>) {
  try { await save(); }
  catch (e) { Alert.alert("Couldn't save that setting", e instanceof ApiError && e.code !== 'no_connection' ? e.message : 'Check your connection and try again.'); }
  queryClient.invalidateQueries({ queryKey: ['me'] });
}

export default function Profile() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me') });
  // The form fields below start from the loaded profile, so the screen is mounted once there is one (and again for
  // another account), instead of copying the profile into state from an effect.
  return me.data ? <ProfileScreen key={me.data.id} u={me.data} /> : null;
}

function ProfileScreen({ u }: { u: any }) {
  // The launch offer (lib/launch-offer.ts): while it runs nothing on this screen asks anyone to pay.
  const offer = useLaunchOffer();
  const fromOffer = plusIsFromOffer(offer, u.plusUntil);
  // Everything free (lib/all-free.ts): no Plus card, no upgrade prompts, no Trip Pass wallet, no Plus wording.
  const { allFree } = useAllFree();
  // Google's consent message requires this entry for users in regions such as the EEA and UK (lib/ads.ts). Never shown without ads.
  const adPrivacy = useAds(st => st.privacyOptions);
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api('/meta') });
  const requests = useQuery({ queryKey: ['connection-requests'], queryFn: () => api<{ received: unknown[] }>('/connections/requests') });
  const requestsCount = requests.data?.received.length ?? 0;
  const viewers = useQuery({ queryKey: ['viewers'], queryFn: () => api('/me/viewers') });
  const savedQ = useQuery({ queryKey: ['saved-activities'], queryFn: () => api('/activities/saved') });
  const myTicketsQ = useQuery({ queryKey: ['my-tickets'], queryFn: () => api('/me/tickets') });
  const [snoozing, setSnoozing] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [trustedContactsOpen, setTrustedContactsOpen] = useState(false);
  const [myTicketsOpen, setMyTicketsOpen] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<any>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const setTokens = useSession(s => s.setTokens);
  const [editing, setEditing] = useState(false); const [bio, setBio] = useState<string>(u.bio ?? ''); const [interests, setInterests] = useState<string[]>(u.interests ?? []); const [langs, setLangs] = useState<string[]>(u.languages ?? []); const [travelStyles, setTravelStyles] = useState<string[]>(u.travelStyle ?? []);
  const [instagram, setInstagram] = useState<string>(u.instagram ?? '');
  const [emergencyName, setEmergencyName] = useState<string>(u.emergencyContactName ?? '');
  const [emergencyPhone, setEmergencyPhone] = useState<string>(u.emergencyContactPhone ?? '');
  const logout = async () => { const t = useSession.getState().tokens; api('/auth/logout', { body: { refreshToken: t?.refreshToken } }).catch(() => {}); closeSocket(); await setTokens(null); queryClient.clear(); router.replace('/(auth)/welcome'); };
  // Delete account (components/LeaveSheet.tsx): why (optional, kept without anything that says who it was), then the confirm.
  const [deleting, setDeleting] = useState(false);
  const del = () => setDeleting(true);
  const deleteAccount = async (body: { reason?: string }) => {
    try { await api('/me', { method: 'DELETE', body }); }
    catch (e) { Alert.alert(e instanceof ApiError ? e.message : 'No connection.'); throw e; }
    setDeleting(false); closeSocket(); await setTokens(null); queryClient.clear(); router.replace('/(auth)/welcome');
  };
  const unsnooze = async () => { await api('/me/snooze', { method: 'DELETE' }).catch(() => {}); queryClient.invalidateQueries({ queryKey: ['me'] }); };
  const [saving, setSaving] = useState(false);
  // A refused field (a bad phone number, an Instagram handle with spaces) or no connection says so and keeps the edits open.
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api('/me', { method: 'PATCH', body: { bio: bio.trim() || null, interests, languages: langs, travelStyle: travelStyles, instagram: instagram.trim() || null, emergencyContactName: emergencyName.trim() || null, emergencyContactPhone: emergencyPhone.trim() || null } });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      setEditing(false);
    } catch (e) {
      Alert.alert("Couldn't save your profile", e instanceof ApiError && e.code !== 'no_connection' ? e.message : 'Check your connection and try again.');
    } finally { setSaving(false); }
  };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bgSoft }} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
        <View style={{ alignItems: 'center', paddingTop: 24, paddingBottom: 20, gap: 10, backgroundColor: C.bgSoft }}>
          <View style={{ position: 'relative' }}>
            <Pressable
              onPress={async () => {
                if (u.photoUrl) {
                  setSelectedPhoto({ id: 'main', url: u.photoUrl, position: 0 });
                } else {
                  const url = await pickAndUpload('avatar').catch(() => null);
                  if (url) {
                    await api('/me', { method: 'PATCH', body: { photoUrl: url } });
                    queryClient.invalidateQueries({ queryKey: ['me'] });
                  }
                }
              }}
            >
              <Avatar uri={u.photoUrl} name={u.name} size={110} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Change profile photo"
              onPress={async () => {
                const url = await pickAndUpload('avatar').catch(() => null);
                if (url) {
                  await api('/me', { method: 'PATCH', body: { photoUrl: url } });
                  queryClient.invalidateQueries({ queryKey: ['me'] });
                }
              }}
              style={{ position: 'absolute', right: -3, bottom: -3, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
              hitSlop={6}
            >
              <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: C.bgSoft }}>
                <Ionicons name="camera" size={16} color="#fff" />
              </View>
            </Pressable>
          </View>
          <H1>{u.name} {u.idVerified ? '🛡️' : u.verified ? '✅' : ''}</H1>
          <Muted>{flag(u.homeCountry)} {u.city ? `Now in ${u.city}` : 'Explorer'}</Muted>
        </View>
        <InstallApp />
        {u.snoozed ? <View style={{ marginHorizontal: 16, marginBottom: 12, padding: 14, borderRadius: R.lg, backgroundColor: C.primarySoft, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <T style={{ fontSize: 24 }}>😴</T>
          <View style={{ flex: 1 }}><T style={{ fontFamily: F.b }}>You're snoozed until {snoozeLabel(u.snoozedUntil)}</T><Muted style={{ fontSize: 13 }}>Hidden from Travelers and the map</Muted></View>
          <T onPress={unsnooze} style={{ color: C.primaryDark, fontFamily: F.b }}>Undo</T>
        </View> : null}
        {allFree ? <LinearGradient colors={['#FF7A55', '#FF5A36']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ marginHorizontal: 16, padding: 16, borderRadius: R.lg, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <T style={{ fontSize: 26 }}>🎉</T><View style={{ flex: 1 }}><T style={{ color: '#fff', fontFamily: F.b }}>Tablamigo is free</T><T style={{ color: 'rgba(255,255,255,0.9)', fontSize: 13 }}>{ALL_FREE_SHORT}</T></View></LinearGradient>
          // Your Plus opens the Plus screen: its dates, and Manage subscriptions (Google Play) for a subscriber. It was a dead card.
          : u.plus ? <Pressable disabled={fromOffer} onPress={() => router.push('/paywall')} accessibilityRole={fromOffer ? undefined : 'button'} accessibilityHint={fromOffer ? undefined : 'Opens your Plus details'}><LinearGradient colors={['#FF7A55', '#FF5A36']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ marginHorizontal: 16, padding: 16, borderRadius: R.lg, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <T style={{ fontSize: 26 }}>⭐</T><View style={{ flex: 1 }}><T style={{ color: '#fff', fontFamily: F.b }}>You're on Plus</T><T style={{ color: 'rgba(255,255,255,0.9)', fontSize: 13 }}>{fromOffer ? (offerDate(offer.until) ? `Free for everyone until ${offerDate(offer.until)}` : 'Free for everyone during the launch offer') : plusUntilLine(u.plusUntil)}</T></View>
            {fromOffer ? null : <Ionicons name="chevron-forward" size={20} color="#fff" />}</LinearGradient></Pressable>
          : <Pressable onPress={() => router.push('/paywall')}><LinearGradient colors={['#FF7A55', '#FF5A36']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ marginHorizontal: 16, padding: 18, borderRadius: R.lg, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <T style={{ fontSize: 28 }}>✨</T><View style={{ flex: 1 }}><T style={{ color: '#fff', fontFamily: F.xb, fontSize: 17 }}>{offer.active ? offerShort(offer) : 'Get Tablamigo Plus'}</T><T style={{ color: 'rgba(255,255,255,0.9)', fontSize: 13 }}>{offer.active ? 'Launch offer: nothing to buy' : 'See everyone on your trip dates, city chats early'}</T></View>
            <Ionicons name="chevron-forward" size={20} color="#fff" /></LinearGradient></Pressable>}

        {/* Profile Boost (24h Spotlight) */}
        <View style={{ marginHorizontal: 16, marginTop: 12, padding: 14, borderRadius: R.lg, backgroundColor: u.isBoosted ? '#FFFBEB' : '#fff', borderWidth: 1, borderColor: u.isBoosted ? '#FCD34D' : C.line, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: u.isBoosted ? '#FEF3C7' : C.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
            <T style={{ fontSize: 20 }}>⚡</T>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <T style={{ fontFamily: F.b, fontSize: 15, color: u.isBoosted ? '#92400E' : C.ink }}>
              {u.isBoosted ? 'Spotlight Active ⚡' : 'Boost Your Profile'}
            </T>
            <Muted style={{ fontSize: 12.5, color: u.isBoosted ? '#B45309' : C.ink3 }}>
              {u.isBoosted
                ? `Ranked first in nearby travelers until ${new Date(u.boostedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                : 'Get seen first by travelers nearby for 24 hours'}
            </Muted>
          </View>
          {!u.isBoosted ? (
            <Button
              title="Boost ⚡"
              onPress={async () => {
                if (!u.plus) {
                  router.push('/paywall');
                  return;
                }
                Alert.alert('Activate 24h Spotlight Boost?', 'Your profile will be pinned at the top of nearby travelers and city feeds for the next 24 hours.', [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Boost Now',
                    onPress: async () => {
                      try {
                        await api('/me/boost', { method: 'POST' });
                        queryClient.invalidateQueries({ queryKey: ['me'] });
                        Alert.alert('Spotlight Activated! ⚡', 'You are now featured at the top of traveler discovery for 24 hours.');
                      } catch (err: any) {
                        Alert.alert('Boost failed', err.message || 'Please try again.');
                      }
                    }
                  }
                ]);
              }}
              style={{ paddingHorizontal: 14, paddingVertical: 8, height: 38 }}
            />
          ) : (
            <View style={{ backgroundColor: '#FEF3C7', paddingHorizontal: 10, paddingVertical: 4, borderRadius: R.pill }}>
              <T style={{ color: '#D97706', fontFamily: F.b, fontSize: 12 }}>ACTIVE</T>
            </View>
          )}
        </View>

        {/* Trip Pass wallet: only for someone holding passes while bundles are not on sale */}
        {!allFree && (FEATURES.tripPassBundles || u.tripPassesAvailable > 0) ? (
        <Pressable
          onPress={() => router.push('/trip-passes' as any)}
          style={{
            marginHorizontal: 16,
            marginTop: 12,
            padding: 14,
            borderRadius: R.lg,
            backgroundColor: u.tripPassesAvailable > 0 ? '#EFF6FF' : '#fff',
            borderWidth: 1,
            borderColor: u.tripPassesAvailable > 0 ? '#BFDBFE' : C.line,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: u.tripPassesAvailable > 0 ? '#DBEAFE' : C.primarySoft,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <T style={{ fontSize: 20 }}>🎫</T>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <T style={{ fontFamily: F.b, fontSize: 15, color: u.tripPassesAvailable > 0 ? '#1E40AF' : C.ink }}>
                Trip Pass Wallet
              </T>
              {u.tripPassesAvailable > 0 ? (
                <View style={{ backgroundColor: '#2563EB', paddingHorizontal: 7, paddingVertical: 1.5, borderRadius: R.pill }}>
                  <T style={{ color: '#fff', fontFamily: F.b, fontSize: 11 }}>{u.tripPassesAvailable} READY</T>
                </View>
              ) : null}
            </View>
            <Muted style={{ fontSize: 12.5, color: u.tripPassesAvailable > 0 ? '#3B82F6' : C.ink3 }}>
              {u.tripPassesAvailable > 0
                ? `${u.tripPassesAvailable} non-expiring pass${u.tripPassesAvailable === 1 ? '' : 'es'} · Tap to manage or redeem`
                : 'Pre-purchase passes & save up to 33%'}
            </Muted>
          </View>
          <Ionicons name="chevron-forward" size={18} color={u.tripPassesAvailable > 0 ? '#2563EB' : C.ink3} />
        </Pressable>
        ) : null}

        {/* Photo Gallery Grid */}
        <View style={{ marginHorizontal: 16, marginTop: 16, padding: 16, borderRadius: R.lg, backgroundColor: '#fff', gap: 12 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View>
              <T style={{ fontFamily: F.b, fontSize: 16 }}>Your Photos</T>
              <Muted style={{ fontSize: 12 }}>{allFree ? 'Up to 6 photos' : u.plus ? 'Up to 6 photos with Plus' : `${u.photos?.length || (u.photoUrl ? 1 : 0)} of 3 photos${offer.active ? '' : ' · Upgrade for 6'}`}</Muted>
            </View>
            {!u.plus && !offer.active && (u.photos?.length || (u.photoUrl ? 1 : 0)) >= 3 ? (
              <Pressable onPress={() => router.push('/paywall')} hitSlop={8}>
                <T style={{ color: C.primary, fontFamily: F.b, fontSize: 13 }}>⭐ Unlock 6</T>
              </Pressable>
            ) : null}
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingVertical: 4 }}>
            {(u.photos && u.photos.length > 0 ? u.photos : (u.photoUrl ? [{ id: 'main', url: u.photoUrl, position: 0 }] : [])).map((p: any, idx: number) => (
              <Pressable
                key={p.id || String(idx)}
                onPress={() => setSelectedPhoto(p)}
                style={{ width: 84, height: 100, borderRadius: R.md, overflow: 'hidden', backgroundColor: C.bgSoft, borderWidth: p.position === 0 ? 2 : 1, borderColor: p.position === 0 ? C.primary : C.line }}
              >
                <Image source={{ uri: p.url }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                {p.position === 0 ? (
                  <View style={{ position: 'absolute', bottom: 4, left: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 4, paddingVertical: 2, alignItems: 'center' }}>
                    <T style={{ color: '#fff', fontSize: 10, fontFamily: F.b }}>MAIN</T>
                  </View>
                ) : null}
              </Pressable>
            ))}

            {((u.photos?.length ?? (u.photoUrl ? 1 : 0)) < (u.plus ? 6 : 3)) ? (
              <Pressable
                onPress={async () => {
                  const url = await pickAndUpload('avatar').catch(() => null);
                  if (url) {
                    await api('/me/photos', { method: 'POST', body: { url } });
                    queryClient.invalidateQueries({ queryKey: ['me'] });
                  }
                }}
                style={{ width: 84, height: 100, borderRadius: R.md, borderWidth: 1.5, borderColor: C.line, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', backgroundColor: C.bgSoft }}
              >
                <Ionicons name="add" size={26} color={C.ink3} />
                <T style={{ fontSize: 11, color: C.ink3, fontFamily: F.sb, marginTop: 2 }}>Add</T>
              </Pressable>
            ) : !u.plus && !offer.active ? (
              <Pressable
                onPress={() => router.push('/paywall')}
                style={{ width: 84, height: 100, borderRadius: R.md, borderWidth: 1, borderColor: C.primarySoft, alignItems: 'center', justifyContent: 'center', backgroundColor: C.primarySoft }}
              >
                <Ionicons name="lock-closed" size={20} color={C.primary} />
                <T style={{ fontSize: 11, color: C.primaryDark, fontFamily: F.b, marginTop: 4 }}>Get Plus</T>
              </Pressable>
            ) : null}
          </ScrollView>
        </View>

        <View style={{ margin: 16, padding: 16, borderRadius: R.lg, backgroundColor: '#fff', gap: 12 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <T style={{ fontFamily: F.b, fontSize: 16 }}>About you</T>
            <Pressable onPress={() => (editing ? save() : setEditing(true))} accessibilityRole="button" hitSlop={{ top: 12, bottom: 12, left: 16, right: 16 }}>
              <T style={{ color: C.primary, fontFamily: F.b }}>{editing ? (saving ? 'Saving…' : 'Save') : 'Edit'}</T>
            </Pressable>
          </View>
          {editing ? <Input value={bio} onChangeText={setBio} multiline placeholder="A line about how you travel" maxLength={300} /> : <T style={{ color: u.bio ? C.ink : C.ink3, lineHeight: 21 }}>{u.bio || 'Add a short bio so people know who they are meeting.'}</T>}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {(editing ? meta.data?.interests ?? [] : u.interests).map((i: string) => <Chip key={i} label={interestLabel(i)} emoji={interestEmoji(i)} active={editing ? interests.includes(i) : false} onPress={editing ? () => setInterests(v => v.includes(i) ? v.filter(x => x !== i) : v.length < 12 ? [...v, i] : v) : undefined} />)}
          </View>
          <T style={{ fontFamily: F.b, fontSize: 14, color: C.ink2, marginTop: 4 }}>Languages</T>
          {editing ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{LANGUAGES.map(l => <Chip key={l} label={l} active={langs.includes(l)} onPress={() => setLangs(v => toggleLanguage(v, l))} />)}</View>
            : <T style={{ color: u.languages?.length ? C.ink : C.ink3 }}>{u.languages?.length ? u.languages.join(' · ') : 'Add the languages you speak.'}</T>}

          <T style={{ fontFamily: F.b, fontSize: 14, color: C.ink2, marginTop: 4 }}>Travel style</T>
          {editing ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {TRAVEL_STYLES.map(s => (
                <Chip
                  key={s.id}
                  label={s.label}
                  emoji={s.emoji}
                  active={travelStyles.includes(s.id)}
                  onPress={() => setTravelStyles(v => v.includes(s.id) ? v.filter(x => x !== s.id) : v.length < 5 ? [...v, s.id] : v)}
                />
              ))}
            </View>
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {u.travelStyle?.length ? (
                u.travelStyle.map((s: string) => <Chip key={s} label={travelStyleLabel(s)} emoji={travelStyleEmoji(s)} />)
              ) : (
                <T style={{ color: C.ink3 }}>Pick how you like to travel (foodie, hiker, early bird...).</T>
              )}
            </View>
          )}

          <T style={{ fontFamily: F.b, fontSize: 14, color: C.ink2, marginTop: 4 }}>Instagram</T>
          {editing ? (
            <View style={{ gap: 4 }}>
              <Input
                value={instagram}
                onChangeText={setInstagram}
                placeholder="e.g. username"
                maxLength={30}
                autoCapitalize="none"
              />
              <Muted style={{ fontSize: 11 }}>{allFree ? 'Visible to other travelers on Tablamigo.' : 'Only visible to Plus members or travelers you share a plan with.'}</Muted>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="logo-instagram" size={16} color={u.instagram ? '#DB2777' : C.ink3} />
              <T style={{ color: u.instagram ? C.ink : C.ink3 }}>
                {u.instagram ? `@${u.instagram}` : 'Add your Instagram handle.'}
              </T>
            </View>
          )}

          <T style={{ fontFamily: F.b, fontSize: 14, color: C.ink2, marginTop: 4 }}>Emergency contact (Private)</T>
          {editing ? (
            <View style={{ gap: 6 }}>
              <Input
                value={emergencyName}
                onChangeText={setEmergencyName}
                placeholder="Contact name (e.g. Mom, Alex)"
                maxLength={40}
              />
              <Input
                value={emergencyPhone}
                onChangeText={setEmergencyPhone}
                placeholder="Phone number (e.g. +91 98765 43210)"
                maxLength={30}
                keyboardType="phone-pad"
              />
              <Muted style={{ fontSize: 11 }}>Only notified if you trigger the SOS emergency toolkit during a meetup.</Muted>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="call-outline" size={16} color={u.emergencyContactName ? '#059669' : C.ink3} />
              <T style={{ color: u.emergencyContactName ? C.ink : C.ink3 }}>
                {u.emergencyContactName ? `${u.emergencyContactName} (${u.emergencyContactPhone || 'Phone saved'})` : 'Add an emergency contact for meetup safety.'}
              </T>
            </View>
          )}
          {/* The form runs about three screens; a Save at its end so nobody has to scroll back up to the small link. */}
          {editing ? <Button title="Save profile" loading={saving} onPress={save} style={{ marginTop: 8 }} /> : null}
        </View>

        {/* Conversation Starters / Prompts */}
        <View style={{ marginHorizontal: 16, marginBottom: 16, padding: 16, borderRadius: R.lg, backgroundColor: '#fff', gap: 12 }}>
          <View>
            <T style={{ fontFamily: F.b, fontSize: 16 }}>Conversation starters</T>
            <Muted style={{ fontSize: 12 }}>3 short answers to break the ice</Muted>
          </View>
          <ProfilePromptsEdit prompts={u.prompts} />
        </View>

        <View style={{ marginHorizontal: 16, marginBottom: 16, padding: 16, borderRadius: R.lg, backgroundColor: '#fff', gap: 14 }}>
          <CountriesVisited codes={u.countriesVisited ?? []} onPress={() => router.push('/countries')} />
          <View style={{ gap: 2 }}>
            <T style={{ fontFamily: F.b, fontSize: 16 }}>👍 {u.vouches} thumbs-up from meetups</T>
            {!u.vouches ? <Muted>After a plan, people you met can give you a thumbs-up.</Muted> : null}
          </View>
        </View>

        {/* My Activity Timeline */}
        <View style={{ marginHorizontal: 16, marginBottom: 16, padding: 16, borderRadius: R.lg, backgroundColor: '#fff', gap: 12 }}>
          <View>
            <T style={{ fontFamily: F.b, fontSize: 16 }}>My Activity & Memories</T>
            <Muted style={{ fontSize: 12 }}>Your past trips, meetups and photo albums</Muted>
          </View>
          <UserTimeline userId={u.id} isSelf={true} />
        </View>

        <View style={{ marginHorizontal: 16, marginBottom: 16, borderRadius: R.lg, overflow: 'hidden', backgroundColor: '#fff' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 11, paddingHorizontal: 16 }}>
            <Ionicons name="moon-outline" size={21} color={C.ink2} />
            <T style={{ flex: 1, fontFamily: F.sb }}>Snooze: hide me from Travelers and the map</T>
            <Switch accessibilityLabel="Snooze" value={!!u.snoozed} onValueChange={v => (v ? setSnoozing(true) : unsnooze())} trackColor={{ true: C.primary, false: C.line }} thumbColor="#fff" />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 11, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: C.line }}>
            <Ionicons name="eye-off-outline" size={21} color={C.ink2} />
            <T style={{ flex: 1, fontFamily: F.sb }}>Hide meetup history from public profile</T>
            <Switch
              accessibilityLabel="Hide meetup history from public profile"
              value={!!u.hidePlanHistory}
              onValueChange={v => saveSetting(() => api('/me', { method: 'PATCH', body: { hidePlanHistory: v } }))}
              trackColor={{ true: C.primary, false: C.line }}
              thumbColor="#fff"
            />
          </View>
          <NotificationsRow />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 11, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: C.line }}>
            <Ionicons name="people-outline" size={21} color={C.ink2} />
            <View style={{ flex: 1 }}>
              <T style={{ fontFamily: F.sb }}>Trip match alerts</T>
              <Muted style={{ fontSize: 12 }}>Tell me when someone will be in my trip's city on my dates. Off also keeps me out of other people's alerts.</Muted>
            </View>
            <Switch
              accessibilityLabel="Trip match alerts"
              value={u.tripMatchAlerts !== false}
              onValueChange={v => saveSetting(() => api('/me', { method: 'PATCH', body: { tripMatchAlerts: v } }))}
              trackColor={{ true: C.primary, false: C.line }}
              thumbColor="#fff"
            />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 11, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: C.line }}>
            <Ionicons name="calendar-outline" size={21} color={C.ink2} />
            <View style={{ flex: 1 }}>
              <T style={{ fontFamily: F.sb }}>Plan alerts</T>
              <Muted style={{ fontSize: 12 }}>Who looked at my plans, plan reminders by email, and tips when my trip city has no plans yet.</Muted>
            </View>
            <Switch
              accessibilityLabel="Plan alerts"
              value={u.planAlerts !== false}
              onValueChange={v => saveSetting(() => api('/me', { method: 'PATCH', body: { planAlerts: v } }))}
              trackColor={{ true: C.primary, false: C.line }}
              thumbColor="#fff"
            />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 11, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: C.line }}>
            <Ionicons name="glasses-outline" size={21} color={C.ink2} />
            <View style={{ flex: 1 }}>
              <T style={{ fontFamily: F.sb }}>Incognito Mode</T>
              <Muted style={{ fontSize: 12 }}>Browse traveler profiles anonymously</Muted>
            </View>
            <Switch
              accessibilityLabel="Incognito Mode"
              value={!!u.isIncognito}
              onValueChange={async (v) => {
                if (v && !u.plus) {
                  Alert.alert('Plus Required', 'Incognito browsing is an exclusive Tablamigo Plus feature.', [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'View Plus', onPress: () => router.push('/paywall') }
                  ]);
                  return;
                }
                await saveSetting(() => api('/me/incognito', { method: 'POST', body: { enabled: v } }));
              }}
              trackColor={{ true: C.primary, false: C.line }}
              thumbColor="#fff"
            />
          </View>
          {FEATURES.themePicker ? (
            <Row
              icon="color-palette-outline"
              label="Display & Theme"
              detail={u.theme === 'dark' ? (u.oledDark ? '🌙 Dark (OLED)' : '🌙 Dark') : u.theme === 'light' ? '☀️ Light' : '⚙️ System'}
              onPress={() => router.push('/display' as any)}
            />
          ) : null}
          {FEATURES.languagePicker ? (
            <Row
              icon="language-outline"
              label="Language & Region"
              detail={u.locale === 'hi' ? '🇮🇳 हिन्दी' : u.locale === 'es' ? '🇪🇸 Español' : '🇬🇧 English'}
              onPress={() => router.push('/language' as any)}
            />
          ) : null}
          <Row
            icon="bookmark-outline"
            label="Saved Plans"
            detail={savedQ.data?.saved?.length ? String(savedQ.data.saved.length) : undefined}
            onPress={() => setSavedOpen(true)}
          />
          {!allFree && (FEATURES.tripPassBundles || u.tripPassesAvailable > 0) ? (
            <Row
              icon="ticket-outline"
              label={FEATURES.tripPassBundles ? 'Trip Pass Wallet & Bundles' : 'Trip Pass Wallet'}
              detail={u.tripPassesAvailable > 0 ? `${u.tripPassesAvailable} available` : 'Save up to 33%'}
              onPress={() => router.push('/trip-passes' as any)}
            />
          ) : null}
          {FEATURES.paidEvents || myTicketsQ.data?.tickets?.length ? (
            <Row
              icon="receipt-outline"
              label="My Event Tickets"
              detail={myTicketsQ.data?.tickets?.length ? `${myTicketsQ.data.tickets.length} tickets` : undefined}
              onPress={() => setMyTicketsOpen(true)}
            />
          ) : null}
          <Row icon="people-outline" label="My connections" detail={requestsCount ? `${requestsCount} new` : undefined} onPress={() => router.push('/connections' as any)} />
          <Row icon="gift-outline" label={allFree ? 'Invite friends' : 'Invite friends · Get 7 days Plus'} onPress={() => router.push('/referral' as any)} />
          <Row icon="cash-outline" label="Partner programme · Earn 30%" onPress={() => router.push('/partner' as any)} />
          <Row icon="eye-outline" label="Profile views" detail={viewers.data ? String(viewers.data.count) : undefined} onPress={() => router.push('/viewers')} />
          <Row icon="checkmark-circle-outline" label="Identity Verification" detail={u.idVerified ? '🛡️ ID Verified' : u.verified ? '✅ Selfie Verified' : u.verification === 'pending' ? 'Verification pending' : 'Get verified'} onPress={() => router.push('/verify')} />
        </View>

        <View style={{ marginHorizontal: 16, borderRadius: R.lg, overflow: 'hidden', backgroundColor: '#fff' }}>
          <Row icon="shield-outline" label="Trusted contacts & safety" onPress={() => setTrustedContactsOpen(true)} />
          <Row icon="shield-checkmark-outline" label="Safety tips" onPress={() => Alert.alert('Meet safely', '• Meet in public places\n• Tell a friend where you are\n• Trust your gut and leave if something feels off\n• Report anyone who makes you uncomfortable')} />
          <Row icon="document-text-outline" label="Privacy policy" onPress={() => Linking.openURL(PRIVACY_URL)} />
          {adPrivacy ? <Row icon="options-outline" label="Ad privacy choices" onPress={() => openAdPrivacyOptions().catch(() =>
            Alert.alert('Ad privacy choices', "Couldn't open Google's privacy options. Check your connection and try again."))} /> : null}
          <Row icon="reader-outline" label="Terms of service" onPress={() => Linking.openURL(TERMS_URL)} />
          <Row icon="mail-outline" label="Contact support" onPress={() => Linking.openURL('mailto:support@hookstep.in?subject=Tablamigo%20support')} />
          <Row icon="log-out-outline" label="Log out" onPress={logout} />
          <Row icon="trash-outline" label="Delete account" onPress={del} danger />
        </View>
        <Muted style={{ textAlign: 'center', marginTop: 20, fontSize: 12 }}>Tablamigo {Constants.expoConfig?.version ?? ''}</Muted>
      </ScrollView>
      <SnoozeSheet visible={snoozing} onClose={() => setSnoozing(false)} />
      <SavedPlansSheet visible={savedOpen} onClose={() => setSavedOpen(false)} />
      <TrustedContactsManager visible={trustedContactsOpen} onClose={() => setTrustedContactsOpen(false)} />
      <MyTicketsModal visible={myTicketsOpen} onClose={() => setMyTicketsOpen(false)} />
      <PhotoViewModal
        visible={!!selectedPhoto}
        photoUrl={selectedPhoto?.url}
        title={selectedPhoto?.position === 0 || selectedPhoto?.id === 'main' ? 'Main Profile Photo' : 'Gallery Photo'}
        subtitle={selectedPhoto?.position === 0 || selectedPhoto?.id === 'main' ? 'Shown as your primary avatar on feeds, chats, and search.' : 'Shown in your profile photo gallery.'}
        isMain={selectedPhoto?.position === 0 || selectedPhoto?.id === 'main'}
        busy={photoBusy}
        onClose={() => { if (!photoBusy) setSelectedPhoto(null); }}
        onChangePhoto={(selectedPhoto?.position === 0 || selectedPhoto?.id === 'main') ? async () => {
          try {
            setPhotoBusy(true);
            const url = await pickAndUpload('avatar').catch(() => null);
            if (url) {
              if (selectedPhoto.id && selectedPhoto.id !== 'main') {
                await api(`/me/photos/${selectedPhoto.id}`, { method: 'DELETE' }).catch(() => {});
              }
              await api('/me/photos', { method: 'POST', body: { url } }).catch(() => {});
              await api('/me', { method: 'PATCH', body: { photoUrl: url } });
              await queryClient.invalidateQueries({ queryKey: ['me'] });
              setSelectedPhoto(null);
            }
          } catch (e: any) {
            Alert.alert('Error', e?.message || 'Could not update photo');
          } finally {
            setPhotoBusy(false);
          }
        } : undefined}
        onSetMain={(selectedPhoto?.position !== 0 && selectedPhoto?.id !== 'main') ? async () => {
          try {
            setPhotoBusy(true);
            await api(`/me/photos/${selectedPhoto.id}/main`, { method: 'POST' });
            await queryClient.invalidateQueries({ queryKey: ['me'] });
            setSelectedPhoto(null);
          } catch (e: any) {
            Alert.alert('Error', e?.message || 'Could not set as main');
          } finally {
            setPhotoBusy(false);
          }
        } : undefined}
        onDeletePhoto={async () => {
          try {
            setPhotoBusy(true);
            if (selectedPhoto.id && selectedPhoto.id !== 'main') {
              await api(`/me/photos/${selectedPhoto.id}`, { method: 'DELETE' });
            } else {
              await api('/me', { method: 'PATCH', body: { photoUrl: null } });
            }
            await queryClient.invalidateQueries({ queryKey: ['me'] });
            setSelectedPhoto(null);
          } catch (e: any) {
            Alert.alert('Error', e?.message || 'Could not delete photo');
          } finally {
            setPhotoBusy(false);
          }
        }}
      />
      <LeaveSheet visible={deleting} onClose={() => setDeleting(false)} onDelete={deleteAccount} onSnooze={() => setSnoozing(true)} />
    </SafeAreaView>
  );
}
