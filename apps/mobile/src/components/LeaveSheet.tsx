import React, { useState } from 'react';
import { ScrollView, Switch, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { T, Muted, Chip, Button } from './ui';
import { ModalSheet } from './ModalSheet';
import { ActivityCard, type Activity } from './ActivityCard';
import { api } from '../lib/api';
import { useHere } from '../lib/useHere';
import { startPlans } from '../lib/next-step';
import { LEAVE_REASONS, offerFor, deleteBody, RETENTION, type LeaveStage } from '../lib/leave-flow';
import { notificationState, fixNotifications } from '../lib/push';
import { C, F, R } from '../lib/theme';

/**
 * Delete account: one "before you go" screen (the two ways to step back instead, snooze or hear about new plans near you, an
 * optional why, and an honest offer for an empty city), then the final confirm (lib/leave-flow.ts). `onDelete` gets DELETE /me's
 * body and does the deleting and signing out; it throws to keep the sheet open. `onSnooze` opens the snooze sheet instead.
 */
export function LeaveSheet({ visible, onClose, onDelete, onSnooze }: { visible: boolean; onClose: () => void; onDelete: (body: { reason?: string }) => Promise<void>; onSnooze: () => void }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<any>('/me'), enabled: visible });
  const [alerts, setAlerts] = useState<boolean | null>(null);
  const alertsOn = alerts ?? !!me.data?.nearbyPlanAlerts;
  const [alertsErr, setAlertsErr] = useState('');
  const toggleAlerts = async (on: boolean) => {
    setAlerts(on); setAlertsErr('');
    try { await api('/me', { method: 'PATCH', body: { nearbyPlanAlerts: on } }); }
    catch { setAlerts(!on); setAlertsErr('No connection. Try again.'); return; }
    // Saved. Asking for notifications is a separate step: its failure never flips the switch back.
    try { if (on && (await notificationState()) === 'off') await fixNotifications(); } catch { /* the switch stays on */ }
  };
  const [stage, setStage] = useState<LeaveStage>('why');
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { here } = useHere();
  const offer = offerFor(reason);
  const acts = useQuery({
    queryKey: ['leave-plans', here?.lat.toFixed(3), here?.lng.toFixed(3)],
    queryFn: () => api<{ activities: Activity[]; wider?: { radiusKm: number; activities: Activity[] } | null }>(`/activities?lat=${here!.lat}&lng=${here!.lng}&when=week`),
    enabled: visible && offer === 'nearby' && !!here,
  });
  const { plans, radiusKm } = startPlans(acts.data?.activities, acts.data?.wider, Date.now(), 1);
  const close = () => { if (busy) return; setStage('why'); setReason(null); onClose(); };
  // Leaving the sheet for one of the offers keeps the account as it is.
  const go = (path: string) => { close(); router.push(path as any); };
  const del = async () => {
    setBusy(true);
    // onDelete already told the person what went wrong; the sheet stays open for another try.
    try { await onDelete(deleteBody(reason)); setStage('why'); setReason(null); }
    catch { /* shown by onDelete */ }
    finally { setBusy(false); }
  };

  return (
    <ModalSheet visible={visible} onClose={close}>
      {stage === 'why' ? <>
        {/* The reasons and the offer scroll; the two buttons below always stay on screen (the sheet is at most 80% high). */}
        <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ gap: 4 }}>
        <T style={{ fontFamily: F.xb, fontSize: 20 }}>Before you go</T>
        <Muted style={{ lineHeight: 21, marginTop: 4 }}>{RETENTION.line}</Muted>
        <View style={{ gap: 10, marginTop: 12 }}>
          <Button title={RETENTION.snooze} kind="soft" onPress={() => { close(); onSnooze(); }} />
          <Muted style={{ fontSize: 13, lineHeight: 19, marginTop: -4 }}>Your profile, chats and plans are kept; nobody sees you until you're back.</Muted>
          <View testID="leave-nearby-alerts" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: R.md, backgroundColor: C.bgSoft }}>
            <T style={{ flex: 1, fontFamily: F.b }}>{RETENTION.notify}</T>
            <Switch accessibilityLabel={RETENTION.notify} value={alertsOn} onValueChange={toggleAlerts} trackColor={{ true: C.primary, false: C.line }} thumbColor="#fff" />
          </View>
          {alertsErr ? <T style={{ color: C.danger }}>{alertsErr}</T> : null}
        </View>
        <T style={{ fontFamily: F.b, marginTop: 14 }}>Why are you leaving? <T style={{ color: C.ink2, fontFamily: F.r }}>(optional)</T></T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {LEAVE_REASONS.map(([code, label]) => <Chip key={code} label={label} active={reason === code} onPress={() => setReason(reason === code ? null : code)} />)}
        </View>
        {offer === 'nearby' ? <View style={{ marginTop: 14, padding: 14, gap: 10, borderRadius: R.md, backgroundColor: C.bgSoft }}>
          <Muted style={{ lineHeight: 20 }}>Fair. Tablamigo is new and some cities are still quiet. Two things that help:</Muted>
          <Button title="Tell me when a traveller is here" kind="soft" onPress={() => go('/trip/new')} />
          <Muted style={{ lineHeight: 19, fontSize: 13 }}>Add where you'll be and when. When another traveller's dates overlap, we message you both.</Muted>
          {plans.length ? <>
            <Muted style={{ lineHeight: 20 }}>{radiusKm ? `Or join the nearest plan (within ${radiusKm} km):` : 'Or join a plan near you this week:'}</Muted>
            {plans.map(a => <ActivityCard key={a.id} a={a} compact onOpen={close} />)}
          </> : null}
        </View> : null}
        </ScrollView>
        <View style={{ gap: 10, marginTop: 16 }}>
          <Button title="Delete anyway" kind="dark" onPress={() => setStage('confirm')} />
          <Button title="Keep my account" kind="ghost" onPress={close} />
        </View>
      </> : <>
        <T style={{ fontFamily: F.xb, fontSize: 20 }}>Delete your account?</T>
        <Muted style={{ lineHeight: 20 }}>Your profile, plans, trips, photos and messages are removed. This cannot be undone.</Muted>
        <Muted style={{ lineHeight: 20, marginTop: 4 }}>Have Plus? Deleting cancels it, on Google Play and on the website: no more charges.</Muted>
        <View style={{ gap: 10, marginTop: 16 }}>
          <Button title="Delete my account" kind="dark" loading={busy} onPress={del} />
          <Button title="Keep my account" kind="ghost" disabled={busy} onPress={close} />
        </View>
      </>}
    </ModalSheet>
  );
}
