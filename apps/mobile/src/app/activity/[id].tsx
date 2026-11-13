import React, { useState } from 'react';
import { Alert, ScrollView, View, Pressable, ActivityIndicator, Linking, Platform } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { askPushOnIntent, askPushAfterValue } from '../../lib/push';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, H1, Muted, Button, Avatar, Pill, Empty, BackButton, IconButton } from '../../components/ui';
import { when } from '../../components/format';
import { api, ApiError } from '../../lib/api';
import { runningLateOpen } from '../../lib/running-late';
import { useNow } from '../../lib/useNow';
import { queryClient } from '../../lib/query';
import { C, F, R, flag, shadow } from '../../lib/theme';
import { reportSheet } from '../../lib/safety';
import { VouchSheet } from '../../components/VouchSheet';
import { PlanPhotos } from '../../components/PlanPhotos';
import { PlanDiscussion } from '../../components/PlanDiscussion';
import { MeetingMap } from '../../components/MeetingMap';
import { RateHostModal } from '../../components/RateHostModal';
import { reviewAfterPlanJoined } from '../../lib/review-prompt';
import { SafetyModal } from '../../components/SafetyModal';
import { RunningLateModal } from '../../components/RunningLateModal';
import { HostTicketsModal } from '../../components/HostTicketsModal';
import { useLocation } from '../../lib/location';
import { shareLink, planLink } from '../../lib/share';
import { FEATURES } from '../../lib/config';
import { planTitleAfterVerb } from '../../lib/plan-title';
import { useOpenDm } from '../../lib/dm';
import { joinErrorText } from '../../lib/quick-join';

export default function ActivityDetail() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useQuery({ queryKey: ['activity', id], queryFn: () => api(`/activities/${id}`) });
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me') });
  const { pos, locate } = useLocation();
  const [err, setErr] = useState('');
  const [vouching, setVouching] = useState(false);
  const [ratingHost, setRatingHost] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false);
  // Message the host or someone going, without leaving the plan for their profile first.
  const { openDm, openingId, dmSheet } = useOpenDm();
  const [lateModalOpen, setLateModalOpen] = useState(false);
  const [hostTicketsOpen, setHostTicketsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const now = useNow();

  // Only reachable with FEATURES.paidEvents on. Before turning that on, this must open Razorpay Checkout for the order
  // and send its paymentId and signature: the server issues no ticket without a payment it has verified.
  const bookTicket = useMutation({
    mutationFn: async () => {
      const order = await api(`/activities/${id}/ticket/order`, { method: 'POST' });
      const verify = await api(`/activities/${id}/ticket/verify`, {
        method: 'POST',
        body: { orderId: order.orderId },
      });
      return verify;
    },
    onSuccess: (res: any) => {
      queryClient.invalidateQueries();
      Alert.alert(
        'Ticket Booked! 🎟️',
        `Your digital pass (${res.ticket.ticketCode}) has been confirmed! You have been added to the attendee circle.`
      );
    },
    onError: (e: any) => {
      Alert.alert('Booking Failed', e instanceof ApiError ? e.message : 'Could not complete ticket booking.');
    },
  });

  const clearRunningLate = useMutation({
    mutationFn: () => api(`/activities/${id}/running-late`, { method: 'DELETE' }),
    onSuccess: () => {
      Alert.alert("Arrived! 🎉", "Your running late status has been cleared.");
      queryClient.invalidateQueries();
    },
    onError: (e: any) => Alert.alert('Error', e instanceof ApiError ? e.message : 'Could not clear status.'),
  });
  const join = useMutation({
    mutationFn: (body?: { rsvp?: 'going' | 'maybe' | 'waitlist' }) => api(`/activities/${id}/join`, { method: 'POST', body }),
    onSuccess: (r: any) => {
      queryClient.invalidateQueries();
      // Joining (as going) may bring the store rating ask, once the plan's chat has opened and settled (lib/review-trigger.ts).
      // The notification reason first; the store rating ask only when that did not show (never two asks on one join).
      if (!r.waitlisted && r.rsvpStatus === 'going') askPushAfterValue('plan').then(shown => { if (!shown) reviewAfterPlanJoined(); });
      if (r.waitlisted) {
        Alert.alert("You're on the waitlist! ⏳", "If someone leaves, you'll be automatically promoted and notified.");
      } else if (r.rsvpStatus === 'maybe') {
        Alert.alert("Interested! ✨", "You've marked yourself as maybe. You're in the group chat to stay updated.");
      }
      if (r.chatId) {
        router.push(`/chat/${r.chatId}`);
      }
    },
    onError: (e: any) => setErr(e instanceof ApiError ? joinErrorText(e.code, e.message) : 'No connection.'),
  });

  const updateRsvp = useMutation({
    mutationFn: (rsvp: 'going' | 'maybe') => api(`/activities/${id}/rsvp`, { method: 'POST', body: { rsvp } }),
    onSuccess: (r: any) => {
      queryClient.invalidateQueries();
      if (r.waitlisted) {
        Alert.alert("Waitlist ⏳", "This plan is full. You've been placed on the waitlist.");
      } else if (r.rsvpStatus === 'going') {
        // From maybe to going is joining too; the rating ask may follow once this alert is closed (lib/review-trigger.ts).
        Alert.alert("You're Going! 🎉", "Your spot is confirmed.", [{ text: 'OK', onPress: reviewAfterPlanJoined }]);
      } else if (r.rsvpStatus === 'maybe') {
        Alert.alert("Updated to Maybe ✨", "Your spot was released for other travelers, but you stay in the group chat.");
      }
    },
    onError: (e: any) => Alert.alert('Could not update RSVP', e instanceof ApiError ? e.message : 'Error'),
  });
  const a = q.data;
  const seriesQ = useQuery({
    queryKey: ['activity-series', a?.seriesId || id],
    queryFn: () => api(`/activities/${id}/series`),
    enabled: !!a?.recurrence,
  });

  const advanceRecurrence = useMutation({
    mutationFn: () => api(`/activities/${id}/advance-recurrence`, { method: 'POST' }),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries();
      Alert.alert("Next session scheduled! 🗓️", `Session #${res.occurrenceNumber} has been created and attendees notified.`);
      if (res.nextActivityId) {
        router.push(`/activity/${res.nextActivityId}`);
      }
    },
    onError: (e: any) => Alert.alert('Could not schedule next session', e.message),
  });

  const toggleAutoAdvance = useMutation({
    mutationFn: (newVal: boolean) => api(`/activities/${id}/recurrence`, { method: 'PATCH', body: { autoAdvance: newVal } }),
    onSuccess: () => {
      queryClient.invalidateQueries();
    },
    onError: (e: any) => Alert.alert('Could not update recurrence', e.message),
  });

  // A cancelled, removed or women-only plan (or a bad link) is a 404: say so instead of spinning forever.
  if (!a) return <SafeAreaView style={{ flex: 1, justifyContent: 'center', backgroundColor: C.bg }}>
    {q.isError ? <Empty emoji="🗺️" title="This plan isn't available" body={q.error instanceof ApiError && q.error.status === 404 ? 'It may have been cancelled, or it is only open to some people.' : 'Check your connection and try again.'}
      action={<Button title="See plans nearby" onPress={() => router.replace('/(tabs)')} style={{ marginTop: 12, paddingHorizontal: 28 }} />} />
      : <ActivityIndicator color={C.primary} />}
  </SafeAreaView>;
  const isHost = a.host.id === me.data?.id;
  const full = a.maxPeople && a.going >= a.maxPeople;
  const started = new Date(a.startsAt).getTime() <= now;
  const isWaitlisted = a.myRsvp === 'waitlist';

  const checkin = async () => {
    try {
      setCheckingIn(true);
      const coords = pos ?? await locate().catch(() => null);
      if (!coords) {
        Alert.alert('Location required', 'Please enable location permissions to check in at the meetup.');
        return;
      }
      await api(`/activities/${a.id}/checkin`, { method: 'POST', body: { lat: coords.lat, lng: coords.lng } });
      Alert.alert('You arrived! 📍', `You're checked in at ${a.placeName}.`);
      queryClient.invalidateQueries();
    } catch (e: any) {
      Alert.alert('Check-in failed', e instanceof ApiError ? e.message : 'Could not check in.');
    } finally {
      setCheckingIn(false);
    }
  };

  const setClosed = async (closed: boolean) => { await api(`/activities/${a.id}/close`, { body: { closed } }).catch(() => {}); queryClient.invalidateQueries(); };
  const sendLate = (minutes: number) => {
    api(`/activities/${a.id}/running-late`, { method: 'POST', body: { minutes } })
      .then(() => Alert.alert('Sent!', `Posted to the group chat that you're ~${minutes} min late.`))
      .catch((e: any) => Alert.alert("Couldn't send update", e instanceof ApiError ? e.message : 'Error'));
  };

  const leave = () => Alert.alert('Leave this plan?', "You'll leave the group chat too. You can join again while there's space.", [{ text: 'Stay' }, { text: 'Leave', style: 'destructive', onPress: async () => {
    try { await api(`/activities/${a.id}/leave`, { method: 'POST' }); setErr(''); } catch (e) { setErr(e instanceof ApiError ? e.message : 'No connection.'); }
    queryClient.invalidateQueries();
  } }]);

  const toggleSave = async () => {
    try {
      const res = await api(`/activities/${a.id}/save`, { method: 'POST' });
      queryClient.setQueryData(['activity', id], (old: any) => old ? { ...old, isSaved: res.saved, savedCount: res.savedCount } : old);
      queryClient.invalidateQueries({ queryKey: ['saved-activities'] });
      queryClient.invalidateQueries({ queryKey: ['activities'] });
    } catch (e: any) {
      Alert.alert('Bookmark error', e instanceof ApiError ? e.message : 'Could not save plan.');
    }
  };

  return (
    // The bottom bar pads itself for the system navigation bar (Android draws edge to edge), so only the top edge here.
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top']}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 8 }}>
        <BackButton />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          {copied ? <T style={{ fontFamily: F.sb, fontSize: 13, color: C.go }}>Link copied</T> : null}
          <IconButton name={a.isSaved ? 'bookmark' : 'bookmark-outline'} label="Save plan" size={24} color={a.isSaved ? C.primary : C.ink} edge="none" onPress={toggleSave} />
          <IconButton name="shield-checkmark" label="Safety toolkit" size={24} color="#059669" edge="none" onPress={() => setSafetyOpen(true)} />
          <IconButton name="share-outline" label="Share this plan" size={24} edge="none" onPress={async () => {
            const r = await shareLink(`${isHost ? 'Join my plan' : `${a.host.name} wants to ${planTitleAfterVerb(a.title)}`} on Tablamigo:`, planLink(a.id));
            if (r === 'copied') { setCopied(true); setTimeout(() => setCopied(false), 2000); }
          }} />
          {!isHost ? <IconButton name="ellipsis-horizontal" label="More options" size={24} edge="right" onPress={() => reportSheet({ type: 'activity', id: a.id, userId: a.host.id, userName: a.host.name })} /> : null}
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: 140 + insets.bottom }}>
        <View style={{ width: 84, height: 84, borderRadius: 26, backgroundColor: C.bgSoft, alignItems: 'center', justifyContent: 'center' }}><T style={{ fontSize: 46 }}>{a.emoji}</T></View>
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            <Pill>{when(a.startsAt)}</Pill>
            {a.isPaid && a.ticketPricePaise ? <Pill bg="#FEF3C7" fg="#B45309">🎟️ Ticketed · ₹{Math.round(a.ticketPricePaise / 100)}</Pill> : null}
            {a.recurrence ? <Pill bg="#EEF2FF" fg="#4F46E5">🔁 {a.recurrence.charAt(0).toUpperCase() + a.recurrence.slice(1)} · Session #{a.occurrenceNumber || 1}</Pill> : null}
            {a.womenOnly ? <Pill bg={C.womenSoft} fg={C.women}>Women only</Pill> : null}
            {a.closed ? <Pill bg={C.bgSoft} fg={C.ink2}>Closed to new people</Pill> : null}
          </View>
          <H1>{a.title}</H1>
          <Pressable onPress={() => Linking.openURL(Platform.OS === 'web' ? `https://www.google.com/maps/search/?api=1&query=${a.lat},${a.lng}` : `geo:${a.lat},${a.lng}?q=${encodeURIComponent(a.placeName)}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Ionicons name="location" size={18} color={C.primary} /><T style={{ fontFamily: F.sb, color: C.ink2, flex: 1 }}>{a.placeName}</T>
          </Pressable>
          <T style={{ color: C.ink2 }}>🗓 {new Date(a.startsAt).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' })}</T>
        </View>
        {a.description ? <T style={{ fontSize: 16, lineHeight: 24, color: C.ink }}>{a.description}</T> : null}

        {/* Visual Meeting Point Map */}
        <MeetingMap lat={a.lat} lng={a.lng} placeName={a.placeName} emoji={a.emoji} />

        {/* Ticketed Event Card / Digital Pass */}
        {a.isPaid && a.ticketPricePaise ? (
          <View style={{ backgroundColor: '#FFFBEB', borderRadius: R.lg, padding: 16, borderWidth: 1.5, borderColor: '#FDE68A', gap: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <T style={{ fontSize: 24 }}>🎟️</T>
                <View>
                  <T style={{ fontFamily: F.b, fontSize: 16, color: '#92400E' }}>
                    {a.myTicket ? 'Your Digital Event Pass' : 'Ticketed Event'}
                  </T>
                  <Muted style={{ fontSize: 12, color: '#B45309' }}>
                    ₹{Math.round(a.ticketPricePaise / 100)} per traveler · {a.ticketsSold || 0} booked{a.maxTickets ? ` / ${a.maxTickets} max` : ''}
                  </Muted>
                </View>
              </View>

              {isHost ? (
                <Button
                  title="Host Sales 📊"
                  kind="ghost"
                  style={{ paddingHorizontal: 12, paddingVertical: 6, borderColor: '#D97706', borderWidth: 1 }}
                  onPress={() => setHostTicketsOpen(true)}
                />
              ) : null}
            </View>

            {a.myTicket ? (
              <View style={{ backgroundColor: '#fff', borderRadius: R.md, padding: 14, borderWidth: 1, borderColor: '#FCD34D', gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name="checkmark-circle" size={18} color="#059669" />
                    <T style={{ fontFamily: F.b, fontSize: 13, color: '#065F46' }}>
                      {a.myTicket.status === 'used' ? 'Ticket Redeemed' : 'Valid Entry Pass'}
                    </T>
                  </View>
                  <T style={{ fontFamily: F.xb, fontSize: 14, color: '#92400E', letterSpacing: 0.5 }}>
                    {a.myTicket.ticketCode}
                  </T>
                </View>
                <T style={{ fontSize: 12, color: C.ink2, lineHeight: 17 }}>
                  {a.myTicket.status === 'used'
                    ? 'You have checked in at this event. Enjoy the meetup!'
                    : `Show this pass to ${a.host.name} when you arrive at ${a.placeName}.`}
                </T>
              </View>
            ) : !isHost ? (
              <View style={{ gap: 8 }}>
                <T style={{ fontSize: 12.5, color: '#78350F', lineHeight: 18 }}>
                  This is a curated paid event. Booking a ticket guarantees your spot and immediately unlocks access to the attendee group chat.
                </T>
                <Button
                  title={`Book Ticket (₹${Math.round(a.ticketPricePaise / 100)}) 🎟️`}
                  loading={bookTicket.isPending}
                  onPress={() => bookTicket.mutate()}
                  style={{ backgroundColor: '#D97706' }}
                />
              </View>
            ) : null}
          </View>
        ) : null}

        {/* Recurring Series Tracking Card */}
        {a.recurrence ? (
          <View style={{ backgroundColor: '#fff', borderRadius: R.lg, padding: 16, borderWidth: 1, borderColor: '#E0E7FF', gap: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <T style={{ fontSize: 20 }}>🔁</T>
                <View>
                  <T style={{ fontFamily: F.b, fontSize: 15, color: '#312E81' }}>Recurring Series</T>
                  <Muted style={{ fontSize: 12 }}>Repeats {a.recurrence} · Session #{a.occurrenceNumber || 1}</Muted>
                </View>
              </View>
              {isHost && !a.nextActivityId ? (
                <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                  <Button
                    title={a.autoAdvance !== false ? 'Pause' : 'Resume'}
                    kind="ghost"
                    style={{ paddingHorizontal: 10, paddingVertical: 5 }}
                    loading={toggleAutoAdvance.isPending}
                    onPress={() => toggleAutoAdvance.mutate(a.autoAdvance === false)}
                  />
                  <Button
                    title="Next session"
                    kind="ghost"
                    style={{ paddingHorizontal: 10, paddingVertical: 5 }}
                    loading={advanceRecurrence.isPending}
                    onPress={() => Alert.alert('Schedule next session?', `This will create Session #${(a.occurrenceNumber || 1) + 1} and notify past attendees.`, [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Schedule', onPress: () => advanceRecurrence.mutate() }
                    ])}
                  />
                </View>
              ) : null}
            </View>

            {a.autoAdvance === false ? (
              <View style={{ backgroundColor: '#FFFBEB', padding: 8, borderRadius: R.sm }}>
                <T style={{ fontSize: 12, color: '#92400E' }}>⏸️ Automatic session generation is paused by the host.</T>
              </View>
            ) : null}

            {seriesQ.data?.sessions?.length ? (
              <View style={{ gap: 8, marginTop: 4 }}>
                <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink2 }}>All Sessions in Series:</T>
                {seriesQ.data.sessions.map((sess: any) => (
                  <Pressable
                    key={sess.id}
                    onPress={() => sess.id !== a.id ? router.push(`/activity/${sess.id}`) : null}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: 10,
                      borderRadius: R.md,
                      backgroundColor: sess.id === a.id ? '#EEF2FF' : C.bgSoft,
                      borderWidth: sess.id === a.id ? 1 : 0,
                      borderColor: '#C7D2FE',
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <T style={{ fontFamily: F.b, fontSize: 13, color: sess.id === a.id ? '#4338CA' : C.ink }}>
                        Session #{sess.occurrenceNumber || 1}
                      </T>
                      <T style={{ fontSize: 12, color: C.ink2 }}>
                        {new Date(sess.startsAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                      </T>
                      {sess.id === a.id ? (
                        <View style={{ backgroundColor: '#4338CA', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                          <T style={{ fontSize: 10, fontFamily: F.b, color: '#fff' }}>This one</T>
                        </View>
                      ) : null}
                    </View>
                    <T style={{ fontSize: 12, color: C.ink2 }}>{sess.goingCount} going</T>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        <Pressable onPress={() => router.push(`/user/${a.host.id}`)} style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: R.lg, backgroundColor: '#fff', borderWidth: 1, borderColor: C.line }]}>
          <Avatar uri={a.host.photoUrl} name={a.host.name} size={48} cc={a.host.homeCountry} />
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <T style={{ fontFamily: F.b, fontSize: 16 }}>Hosted by {a.host.name} {a.host.verified ? '✅' : ''}</T>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
              <Muted>{flag(a.host.homeCountry)}</Muted>
              {a.host.rating ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#FEF3C7', paddingHorizontal: 6, paddingVertical: 1, borderRadius: R.sm }}>
                  <Ionicons name="star" size={11} color="#D97706" />
                  <T style={{ fontSize: 11, fontFamily: F.b, color: '#D97706' }}>{a.host.rating} ({a.host.ratingsCount})</T>
                </View>
              ) : null}
              {a.host.rating && a.host.rating >= 4.7 && a.host.ratingsCount >= 3 ? (
                <T style={{ fontSize: 11, fontFamily: F.b, color: C.primaryDark }}>🌟 Superhost</T>
              ) : null}
            </View>
          </View>
          {!isHost && me.data ? (
            <Pressable accessibilityRole="button" accessibilityLabel={`Message ${a.host.name}`} hitSlop={6} onPress={() => openDm(a.host.id)} disabled={!!openingId}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, height: 36, borderRadius: R.pill, backgroundColor: C.primarySoft }}>
              {openingId === a.host.id ? <ActivityIndicator size="small" color={C.primaryDark} /> : <Ionicons name="chatbubble-ellipses-outline" size={16} color={C.primaryDark} />}
              <T style={{ fontFamily: F.b, fontSize: 13, color: C.primaryDark }}>Message</T>
            </Pressable>
          ) : <Ionicons name="chevron-forward" size={18} color={C.ink3} />}
        </Pressable>

        {isWaitlisted ? (
          <View style={{ backgroundColor: '#FEF3C7', padding: 12, borderRadius: R.md, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <T style={{ fontSize: 20 }}>⏳</T>
            <View style={{ flex: 1 }}>
              <T style={{ fontFamily: F.b, color: '#92400E', fontSize: 13 }}>You're on the waitlist</T>
              <Muted style={{ fontSize: 12, color: '#B45309' }}>If a spot opens up, you'll be automatically promoted.</Muted>
            </View>
          </View>
        ) : null}

        {a.myRsvp === 'maybe' ? (
          <View style={{ backgroundColor: '#F5F3FF', borderWidth: 1, borderColor: '#DDD6FE', padding: 12, borderRadius: R.md, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <T style={{ fontSize: 20 }}>🤔</T>
            <View style={{ flex: 1 }}>
              <T style={{ fontFamily: F.b, color: '#5B21B6', fontSize: 13 }}>You're marked as Maybe</T>
              <Muted style={{ fontSize: 12, color: '#6D28D9' }}>You have access to the group chat to stay in the loop.</Muted>
            </View>
          </View>
        ) : null}

        {a.myRunningLateMins ? (
          <View style={{ backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#FDE68A', padding: 12, borderRadius: R.md, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <T style={{ fontSize: 20 }}>⏰</T>
            <View style={{ flex: 1 }}>
              <T style={{ fontFamily: F.b, color: '#92400E', fontSize: 13 }}>
                You're marked as ~{a.myRunningLateMins}m late
              </T>
              <Muted style={{ fontSize: 12, color: '#B45309' }}>
                {a.myRunningLateNote ? `"${a.myRunningLateNote}" · ` : ''}The group has been notified in chat.
              </Muted>
            </View>
            <Pressable onPress={() => clearRunningLate.mutate()} style={{ backgroundColor: '#fff', paddingHorizontal: 10, paddingVertical: 6, borderRadius: R.sm, borderWidth: 1, borderColor: '#FCD34D' }}>
              <T style={{ fontSize: 12, fontFamily: F.b, color: '#92400E' }}>I've arrived</T>
            </Pressable>
          </View>
        ) : null}

        {a.myCheckedIn ? (
          <View style={{ backgroundColor: '#ECFDF5', padding: 10, borderRadius: R.md, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Ionicons name="checkmark-circle" size={18} color="#059669" />
            <T style={{ fontFamily: F.b, color: '#059669', fontSize: 13 }}>You are checked in at this meetup!</T>
          </View>
        ) : null}

        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <T style={{ fontFamily: F.b, fontSize: 17 }}>
              {a.going} going{a.maybeCount ? ` · ${a.maybeCount} maybe` : ''}{a.maxPeople ? ` · ${Math.max(0, a.maxPeople - a.going)} spots left` : ''}
            </T>
            {a.checkedInCount > 0 ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: C.bgSoft, paddingHorizontal: 8, paddingVertical: 2, borderRadius: R.pill }}>
                <T style={{ fontSize: 11 }}>📍</T>
                <Muted style={{ fontSize: 11 }}>{a.checkedInCount} arrived</Muted>
              </View>
            ) : null}
          </View>
          {(a.attendees ?? []).map((u: any) => (
            <Pressable key={u.id} onPress={() => router.push(`/user/${u.id}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Avatar uri={u.photoUrl} name={u.name} size={40} cc={u.homeCountry} />
              <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <T style={{ fontFamily: F.sb, fontSize: 15 }}>{u.name}{u.id === a.host.id ? '  · host' : ''}</T>
                {u.rsvpStatus === 'maybe' ? (
                  <View style={{ backgroundColor: '#EDE9FE', paddingHorizontal: 6, paddingVertical: 1, borderRadius: R.sm }}>
                    <T style={{ fontSize: 10, fontFamily: F.b, color: '#6D28D9' }}>Maybe</T>
                  </View>
                ) : null}
                {u.rsvpStatus === 'waitlist' ? (
                  <View style={{ backgroundColor: '#FEF3C7', paddingHorizontal: 6, paddingVertical: 1, borderRadius: R.sm }}>
                    <T style={{ fontSize: 10, fontFamily: F.b, color: '#92400E' }}>Waitlist</T>
                  </View>
                ) : null}
                {u.runningLateMins ? (
                  <View style={{ backgroundColor: '#FEF3C7', paddingHorizontal: 6, paddingVertical: 1, borderRadius: R.sm }}>
                    <T style={{ fontSize: 10, fontFamily: F.b, color: '#B45309' }}>⏰ +{u.runningLateMins}m</T>
                  </View>
                ) : null}
                {u.checkedIn ? (
                  <View style={{ backgroundColor: '#ECFDF5', paddingHorizontal: 6, paddingVertical: 1, borderRadius: R.sm }}>
                    <T style={{ fontSize: 10, fontFamily: F.b, color: '#059669' }}>📍 Here</T>
                  </View>
                ) : null}
              </View>
              {me.data && u.id !== me.data.id && u.id !== a.host.id ? (
                <Pressable accessibilityRole="button" accessibilityLabel={`Message ${u.name}`} hitSlop={8} onPress={() => openDm(u.id)} disabled={!!openingId}
                  style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: C.bgSoft, alignItems: 'center', justifyContent: 'center' }}>
                  {openingId === u.id ? <ActivityIndicator size="small" color={C.ink2} /> : <Ionicons name="chatbubble-ellipses-outline" size={18} color={C.ink2} />}
                </Pressable>
              ) : null}
            </Pressable>
          ))}
        </View>

        {/* Public Plan Discussion & Questions */}
        <PlanDiscussion activityId={a.id} hostId={a.host.id} isHost={isHost} />

        {/* Meetup Photo Album */}
        <PlanPhotos activityId={a.id} canAdd={a.joined || isHost} isHost={isHost} />
      </ScrollView>
      <View style={[{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 20, paddingBottom: 16 + insets.bottom, backgroundColor: '#fff', gap: 8 }, shadow]}>
        {err ? <T style={{ color: C.danger, textAlign: 'center' }}>{err}</T> : null}
        {a.joined && started && !a.myCheckedIn ? (
          <Button title="📍 I'm here (Check in)" kind="go" loading={checkingIn} onPress={checkin} />
        ) : null}
        {a.joined && started && !isHost ? (
          <Button title="⭐ Rate host" kind="ghost" onPress={() => setRatingHost(true)} />
        ) : null}
        {a.joined && started && (a.attendees ?? []).length > 1 ? <Button title="👍 Thumbs-up people you met" kind="go" onPress={() => setVouching(true)} /> : null}
        {a.joined && a.status === 'active' && !a.myCheckedIn && runningLateOpen(a.startsAt) ? (
          <Button title="🏃 Running late?" kind="ghost" onPress={() => {
            Alert.alert(
              'Running late?',
              'Let everyone in the meetup know:',
              [
                { text: '5 min late', onPress: () => sendLate(5) },
                { text: '15 min late', onPress: () => sendLate(15) },
                { text: '30 min late', onPress: () => sendLate(30) },
                { text: 'Cancel', style: 'cancel' }
              ]
            );
          }} />
        ) : null}
        {a.joined ? (
          <>
            <Button title="Open group chat" kind="dark" onPress={() => router.push(`/chat/${a.chatId}`)} />
            {a.myRsvp === 'maybe' ? (
              <Button
                title={full ? 'Join waitlist to go' : "I'm Going! (Confirm spot)"}
                kind="go"
                loading={updateRsvp.isPending}
                onPress={() => updateRsvp.mutate('going')}
              />
            ) : null}
            {a.myRsvp === 'going' && a.status === 'active' && !a.myCheckedIn && runningLateOpen(a.startsAt) ? (
              <T
                onPress={() => setLateModalOpen(true)}
                style={{ textAlign: 'center', color: '#D97706', fontFamily: F.sb, fontSize: 13, marginTop: 4 }}
              >
                {a.myRunningLateMins ? 'Update running late time ⏰' : 'Running late? Tell the group ⏰'}
              </T>
            ) : null}
            {a.myRsvp === 'going' && !isHost && a.status === 'active' ? (
              <T
                onPress={() => updateRsvp.mutate('maybe')}
                style={{ textAlign: 'center', color: C.ink2, fontFamily: F.sb, fontSize: 13, marginTop: 4 }}
              >
                Switch to Maybe / Interested
              </T>
            ) : null}
          </>
        ) : a.closed ? (
          <Button title="Closed to new people" kind="ghost" disabled />
        ) : a.isPaid && !isHost && !a.myTicket ? (
          <View style={{ gap: 8 }}>
            {FEATURES.paidEvents ? (
              <Button
                title={`Book Ticket (₹${Math.round(a.ticketPricePaise / 100)}) 🎟️`}
                kind="primary"
                loading={bookTicket.isPending}
                onPress={() => bookTicket.mutate()}
                style={{ backgroundColor: '#D97706' }}
              />
            ) : (
              <Button title="Tickets aren't on sale yet" kind="ghost" disabled />
            )}
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            <Button
              title={full ? 'Join waitlist' : 'Join chat'}
              kind={full ? 'ghost' : 'go'}
              loading={join.isPending}
              onPress={() => { askPushOnIntent(); join.mutate(full ? { rsvp: 'waitlist' } : { rsvp: 'going' }); }}
            />
            {!full ? (
              <Button
                title="Interested / Maybe"
                kind="ghost"
                loading={join.isPending}
                onPress={() => join.mutate({ rsvp: 'maybe' })}
              />
            ) : null}
          </View>
        )}
        {a.joined && !isHost && a.status === 'active' ? <T onPress={leave} style={{ textAlign: 'center', color: C.ink2, fontFamily: F.sb, marginTop: 6 }}>Leave plan</T> : null}
        {isHost && a.status === 'active' ? <T onPress={() => a.closed ? setClosed(false) : Alert.alert('Close to new people?', 'Nobody new can join. Everyone already in keeps the chat.', [{ text: 'Not now' }, { text: 'Close', onPress: () => setClosed(true) }])} style={{ textAlign: 'center', color: C.ink2, fontFamily: F.sb, marginTop: 6 }}>{a.closed ? 'Reopen to new people' : 'Close to new people'}</T> : null}
        {isHost && a.status === 'active' ? <T onPress={() => Alert.alert('Cancel this plan?', 'Everyone in the chat will be told.', [{ text: 'Keep it' }, { text: 'Cancel plan', style: 'destructive', onPress: async () => { await api(`/activities/${a.id}/cancel`, { method: 'POST' }); queryClient.invalidateQueries(); router.back(); } }])} style={{ textAlign: 'center', color: C.danger, fontFamily: F.sb, marginTop: 6 }}>Cancel plan</T> : null}
      </View>
      <VouchSheet activityId={a.id} members={a.attendees ?? []} visible={vouching} onClose={() => setVouching(false)} />
      <RateHostModal activityId={a.id} hostName={a.host.name} visible={ratingHost} onClose={() => setRatingHost(false)} />
      {dmSheet}
      <SafetyModal
        activityId={a.id}
        activityTitle={a.title}
        placeName={a.placeName}
        placeAddress={a.placeAddress}
        city={a.city}
        visible={safetyOpen}
        onClose={() => setSafetyOpen(false)}
      />
      <RunningLateModal
        activityId={a.id}
        visible={lateModalOpen}
        initialMins={a.myRunningLateMins || 15}
        initialNote={a.myRunningLateNote || ''}
        onClose={() => setLateModalOpen(false)}
      />
      <HostTicketsModal
        activityId={a.id}
        activityTitle={a.title}
        visible={hostTicketsOpen}
        onClose={() => setHostTicketsOpen(false)}
      />
    </SafeAreaView>
  );
}
