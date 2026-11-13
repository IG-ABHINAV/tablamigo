import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, Share, View, ActivityIndicator, Linking } from 'react-native';
import { Modal } from './Modal';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { T, H1, H2, Muted, Button } from './ui';
import { api, ApiError } from '../lib/api';
import { useLocation } from '../lib/location';
import { C, F, R, shadow } from '../lib/theme';
import { TrustedContactsManager, type TrustedContact } from './TrustedContactsManager';

export function SafetyModal({
  activityId,
  activityTitle,
  placeName,
  placeAddress,
  city,
  visible,
  onClose
}: {
  activityId: string;
  activityTitle: string;
  placeName: string;
  placeAddress?: string | null;
  city: string;
  visible: boolean;
  onClose: () => void;
}) {
  const { pos, locate } = useLocation();
  const [sharing, setSharing] = useState(false);
  const [broadcastingSos, setBroadcastingSos] = useState(false);
  const [sosResult, setSosResult] = useState<any>(null);
  const [contactsManagerOpen, setContactsManagerOpen] = useState(false);

  const contactsQuery = useQuery({
    queryKey: ['trusted-contacts'],
    queryFn: () => api<{ contacts: TrustedContact[]; limit: number; remaining: number }>('/safety/contacts'),
    enabled: visible
  });

  const contacts = contactsQuery.data?.contacts ?? [];

  // The links this person has made to this plan that still work, so they can turn them off.
  const linksQuery = useQuery({
    queryKey: ['plan-shares', activityId],
    queryFn: () => api<{ shares: { id: string }[] }>(`/activities/${activityId}/shares`),
    enabled: visible
  });
  const activeLinks = linksQuery.data?.shares.length ?? 0;

  const turnOffLinks = () => Alert.alert(
    'Turn off your links?',
    `${activeLinks === 1 ? 'The link' : 'The links'} you shared to this plan will stop working right away. Anyone you sent ${activeLinks === 1 ? 'it' : 'them'} to will see that the link is no longer valid.`,
    [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Turn off',
        style: 'destructive',
        onPress: async () => {
          try { await api(`/activities/${activityId}/shares`, { method: 'DELETE' }); } catch (e: any) {
            Alert.alert("Couldn't turn them off", e instanceof ApiError ? e.message : 'Check your connection and try again.');
          }
          linksQuery.refetch();
        }
      }
    ]
  );

  // "Mon 5 Oct, 7:30 pm": when the link stops working, so the person sending it can say so.
  const until = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const makeLink = async () => {
    const res = await api<{ shareUrl: string; expiresAt: string }>(`/activities/${activityId}/share`, { method: 'POST', body: {} });
    linksQuery.refetch();
    return res;
  };

  const onShareWithContact = async () => {
    try {
      setSharing(true);
      const res = await makeLink();
      const link = res.shareUrl;

      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(link).catch(() => {});
      }

      await Share.share({
        message: `I'm going to a meetup on Tablamigo: "${activityTitle}" at ${placeName}, ${city}. This link shows the plan's venue, time and who's going. It doesn't show where I am, and it works until ${until(res.expiresAt)}: ${link}`,
        url: link
      });
    } catch (e: any) {
      Alert.alert('Share Failed', e instanceof ApiError ? e.message : 'Could not generate share link.');
    } finally {
      setSharing(false);
    }
  };

  const shareDirectlyToContact = async (contact: TrustedContact) => {
    try {
      const res = await makeLink();
      const link = res.shareUrl;
      const cleanPhone = contact.phone.replace(/[^0-9+]/g, '');
      const msg = `Hey ${contact.name.split(' ')[0]}! I'm going to a meetup on Tablamigo: "${activityTitle}" at ${placeName}, ${city}.\n\nThis link shows the venue, time, host and who's going. It doesn't show where I am, and it works until ${until(res.expiresAt)}: ${link}`;
      const encoded = encodeURIComponent(msg);
      const url = `https://api.whatsapp.com/send?phone=${cleanPhone.replace(/^\+/, '')}&text=${encoded}`;
      Linking.openURL(url).catch(() => {
        Linking.openURL(`sms:${cleanPhone}?body=${encoded}`).catch(() => {});
      });
    } catch (e: any) {
      Alert.alert('Share Failed', e instanceof ApiError ? e.message : 'Could not share link.');
    }
  };

  const onTriggerSos = () => {
    Alert.alert(
      'Trigger Safety Alert? 🚨',
      // Say exactly what happens: Tablamigo logs the alert and emails the user. It messages nobody else; the user sends
      // the ready-made WhatsApp/SMS alerts to their trusted contacts themselves on the next screen.
      'This logs your location, emails you a copy and shows local emergency numbers. Tablamigo does not message anyone for you: next you can send a ready-made alert to your trusted contacts.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Log Alert',
          style: 'destructive',
          onPress: async () => {
            try {
              setBroadcastingSos(true);
              const coords = pos ?? await locate().catch(() => null);
              const res = await api(`/activities/${activityId}/sos`, {
                method: 'POST',
                body: {
                  lat: coords?.lat,
                  lng: coords?.lng,
                  note: 'Traveler triggered in-app emergency alert'
                }
              });
              setSosResult(res);
            } catch (e: any) {
              Alert.alert('Alert Error', e instanceof ApiError ? e.message : 'Could not log the safety alert. Call the emergency numbers below if you need help.');
            } finally {
              setBroadcastingSos(false);
            }
          }
        }
      ]
    );
  };

  const callNumber = (num: string) => {
    Linking.openURL(`tel:${num.replace(/[^0-9+]/g, '')}`);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: C.bgSoft }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: '#fff' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Ionicons name="shield-checkmark" size={24} color={C.primary} />
            <T style={{ fontFamily: F.b, fontSize: 18 }}>Safety & Emergency Toolkit</T>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={12}>
            <Ionicons name="close" size={24} color={C.ink} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: 60 }}>
          {sosResult ? (
            <View style={{ backgroundColor: '#FEF2F2', borderRadius: R.lg, padding: 18, borderWidth: 1, borderColor: '#FCA5A5', gap: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <T style={{ fontSize: 28 }}>🚨</T>
                <View style={{ flex: 1 }}>
                  <H2 style={{ color: '#B91C1C', fontSize: 18 }}>Safety Alert Logged</H2>
                  <Muted style={{ color: '#991B1B', fontSize: 13 }}>
                    Your location and venue details were logged{sosResult.emailedYou ? ' and emailed to you' : ''}. Nobody else has been contacted yet.
                  </Muted>
                </View>
              </View>

              {/* Trusted Contacts 1-tap SOS Dispatches */}
              {sosResult.dispatches?.length ? (
                <View style={{ gap: 8 }}>
                  <T style={{ fontFamily: F.b, fontSize: 14, color: '#B91C1C' }}>Alert your trusted contacts now (tap to send):</T>
                  {sosResult.dispatches.map((d: any) => (
                    <View key={d.contactId} style={{ backgroundColor: '#fff', borderRadius: R.md, padding: 12, borderWidth: 1, borderColor: '#F87171', gap: 8 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <T style={{ fontFamily: F.b, fontSize: 15 }}>{d.name} ({d.relationship})</T>
                        <Muted style={{ fontSize: 12 }}>{d.phone}</Muted>
                      </View>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <Button
                          title="WhatsApp Alert 📲"
                          kind="go"
                          style={{ flex: 1, height: 38 }}
                          onPress={() => Linking.openURL(d.whatsappUrl)}
                        />
                        <Button
                          title="SMS 💬"
                          kind="ghost"
                          style={{ flex: 1, height: 38 }}
                          onPress={() => Linking.openURL(d.smsUrl)}
                        />
                      </View>
                    </View>
                  ))}
                </View>
              ) : sosResult.emergencyContact?.name ? (
                <View style={{ backgroundColor: '#fff', borderRadius: R.md, padding: 12, borderWidth: 1, borderColor: '#F87171', gap: 8 }}>
                  <T style={{ fontFamily: F.b, fontSize: 14, color: C.ink }}>Your emergency contact (not contacted yet):</T>
                  <T style={{ fontSize: 14, color: C.ink2 }}>
                    {sosResult.emergencyContact.name}{sosResult.emergencyContact.phone ? ` (${sosResult.emergencyContact.phone})` : ''}
                  </T>
                  {sosResult.emergencyContact.phone ? (
                    <Button
                      title={`Call ${sosResult.emergencyContact.name.split(' ')[0]}`}
                      kind="ghost"
                      onPress={() => callNumber(sosResult.emergencyContact.phone)}
                      icon={<Ionicons name="call" size={16} color={C.ink} />}
                    />
                  ) : null}
                </View>
              ) : (
                <Pressable onPress={() => setContactsManagerOpen(true)}>
                  <T style={{ fontSize: 13, color: '#B91C1C', textDecorationLine: 'underline' }}>
                    + Add Trusted Contacts for 1-tap WhatsApp emergency dispatch
                  </T>
                </Pressable>
              )}

              <View style={{ gap: 8, marginTop: 4 }}>
                <T style={{ fontFamily: F.b, fontSize: 14, color: '#B91C1C' }}>Direct Local Emergency Numbers:</T>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Button
                    title={`Police (${sosResult.emergencyNumbers.police})`}
                    kind="dark"
                    onPress={() => callNumber(sosResult.emergencyNumbers.police)}
                    icon={<Ionicons name="call" size={16} color="#fff" />}
                    style={{ flex: 1, backgroundColor: '#DC2626' }}
                  />
                  <Button
                    title={`Ambulance (${sosResult.emergencyNumbers.ambulance})`}
                    kind="dark"
                    onPress={() => callNumber(sosResult.emergencyNumbers.ambulance)}
                    icon={<Ionicons name="medkit" size={16} color="#fff" />}
                    style={{ flex: 1, backgroundColor: '#EA580C' }}
                  />
                </View>
              </View>
            </View>
          ) : null}

          {/* Share with trusted contact card */}
          <View style={[{ backgroundColor: '#fff', borderRadius: R.lg, padding: 18, gap: 12 }, shadow]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
                <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="shield-checkmark" size={22} color={C.primaryDark} />
                </View>
                <View style={{ flex: 1 }}>
                  <T style={{ fontFamily: F.b, fontSize: 16 }}>Share this plan with someone you trust</T>
                  <Muted style={{ fontSize: 12 }}>A link to the plan's details. It doesn't show where you are.</Muted>
                </View>
              </View>
              <Pressable onPress={() => setContactsManagerOpen(true)} style={{ padding: 6 }}>
                <T style={{ fontFamily: F.b, fontSize: 13, color: C.primaryDark }}>Manage</T>
              </Pressable>
            </View>

            {contacts.length > 0 ? (
              <View style={{ gap: 8 }}>
                <T style={{ fontSize: 13, fontFamily: F.sb, color: C.ink }}>Send directly to saved contacts:</T>
                {contacts.map(c => (
                  <View key={c.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.bgSoft, padding: 10, borderRadius: R.md }}>
                    <View style={{ flex: 1 }}>
                      <T style={{ fontFamily: F.b, fontSize: 14 }}>{c.name}</T>
                      <Muted style={{ fontSize: 12 }}>{c.relationship} · {c.phone}</Muted>
                    </View>
                    <Pressable
                      onPress={() => shareDirectlyToContact(c)}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: C.go, paddingHorizontal: 12, paddingVertical: 6, borderRadius: R.pill }}
                    >
                      <Ionicons name="paper-plane" size={12} color="#fff" />
                      <T style={{ color: '#fff', fontSize: 12, fontFamily: F.b }}>Share</T>
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : (
              <T style={{ fontSize: 13, color: C.ink2, lineHeight: 19 }}>
                Whoever you send it to sees the venue, the start time, the host and who is going, in their browser and without an account. It stops working a day after the plan starts, or sooner if you turn it off. It does not show where you are.
              </T>
            )}

            <Button
              title="Share a link to this plan"
              kind="primary"
              loading={sharing}
              onPress={onShareWithContact}
              icon={<Ionicons name="link" size={18} color="#fff" />}
            />
            {activeLinks > 0 ? (
              <Pressable onPress={turnOffLinks} hitSlop={8} style={{ alignSelf: 'center', paddingVertical: 4 }}>
                <T style={{ fontFamily: F.sb, fontSize: 13, color: C.danger }}>
                  {activeLinks === 1 ? '1 link is working' : `${activeLinks} links are working`} · Turn off
                </T>
              </Pressable>
            ) : null}
          </View>

          {/* Emergency SOS button */}
          <View style={[{ backgroundColor: '#fff', borderRadius: R.lg, padding: 18, gap: 12 }, shadow]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#FEE2E2', alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="alert-circle" size={24} color="#DC2626" />
              </View>
              <View style={{ flex: 1 }}>
                <T style={{ fontFamily: F.b, fontSize: 16, color: '#DC2626' }}>Emergency Assistance & SOS</T>
                <Muted style={{ fontSize: 12 }}>Feeling unsafe or need immediate help?</Muted>
              </View>
            </View>
            <T style={{ fontSize: 13, color: C.ink2, lineHeight: 19 }}>
              Logs your location and gives you one-tap calls to local police and ambulance, plus ready-made WhatsApp or SMS alerts you can send to your trusted contacts.
            </T>
            <Button
              title="Emergency SOS"
              kind="dark"
              loading={broadcastingSos}
              onPress={onTriggerSos}
              icon={<Ionicons name="warning" size={18} color="#fff" />}
              style={{ backgroundColor: '#DC2626' }}
            />
          </View>

          {/* Venue Info to show Driver or Police */}
          <View style={{ backgroundColor: '#fff', borderRadius: R.lg, padding: 18, gap: 10 }}>
            <T style={{ fontFamily: F.b, fontSize: 15 }}>📍 Current Venue Details</T>
            <Muted style={{ fontSize: 12 }}>Show this screen to a taxi driver, venue staff, or local authorities if needed:</Muted>
            <View style={{ backgroundColor: C.bgSoft, padding: 12, borderRadius: R.md }}>
              <T style={{ fontFamily: F.b, fontSize: 15 }}>{placeName}</T>
              {placeAddress ? <T style={{ fontSize: 13, color: C.ink2, marginTop: 2 }}>{placeAddress}</T> : null}
              <T style={{ fontSize: 13, color: C.ink2, marginTop: 2 }}>{city}</T>
            </View>
          </View>
        </ScrollView>

        <TrustedContactsManager
          visible={contactsManagerOpen}
          onClose={() => setContactsManagerOpen(false)}
        />
      </View>
    </Modal>
  );
}
