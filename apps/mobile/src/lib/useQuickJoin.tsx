import React, { useState } from 'react';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError, trackEvent } from './api';
import { queryClient } from './query';
import { askPushAfterValue } from './push';
import { reviewAfterPlanJoined } from './review-prompt';
import { momentFor, type Moment } from './paywall-copy';
import { canQuickJoin, joinErrorText } from './quick-join';
import { PaywallSheet } from '../components/PaywallSheet';

/**
 * Join a plan from its card in one tap, as "going", then open its group chat: what the plan page's Join chat does
 * (app/activity/[id].tsx), including the notification ask and the store rating ask after it. A refusal that Plus answers
 * opens the Plus sheet (`sheet`, render it once per screen); any other shows the plan page's words.
 */
export function useQuickJoin(source: string) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<any>('/me') });
  const [moment, setMoment] = useState<Moment | null>(null);
  const m = useMutation({
    mutationFn: (id: string) => api<any>(`/activities/${id}/join`, { method: 'POST', body: { rsvp: 'going' } }),
    onSuccess: (r, id) => {
      trackEvent('plan_quick_join', { activityId: id, source });
      queryClient.invalidateQueries();
      if (!r.waitlisted && r.rsvpStatus === 'going') askPushAfterValue('plan').then(shown => { if (!shown) reviewAfterPlanJoined(); });
      if (r.chatId) router.push(`/chat/${r.chatId}`);
      else router.push(`/activity/${id}`);
    },
    onError: e => {
      const mo = e instanceof ApiError ? momentFor(e.code, e.message, e.data) : null;
      if (mo) setMoment(mo);
      else Alert.alert("Couldn't join", e instanceof ApiError ? joinErrorText(e.code, e.message) : 'No connection.');
    },
  });
  return {
    can: (a: Parameters<typeof canQuickJoin>[0]) => canQuickJoin(a, me.data),
    join: (id: string) => m.mutate(id),
    joiningId: m.isPending ? m.variables : null,
    sheet: <PaywallSheet moment={moment} onClose={() => setMoment(null)} />,
  };
}

export type QuickJoin = ReturnType<typeof useQuickJoin>;
