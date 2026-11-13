import React, { useState } from 'react';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { momentFor, type Moment } from './paywall-copy';
import { PaywallSheet } from '../components/PaywallSheet';

/**
 * Opens (or starts) the 1:1 chat with a person: POST /dm/:userId returns the chat, then the app opens /chat/<chatId>.
 * There is no /chat/dm/<userId> screen; three buttons used to push that path and landed on "not found".
 * A free account out of new chats for today gets the Plus sheet (`dmSheet`, render it once next to the buttons);
 * any other refusal (blocked, the person is gone) is shown as an alert.
 */
export function useOpenDm() {
  const [moment, setMoment] = useState<Moment | null>(null);
  const start = useMutation({
    mutationFn: (userId: string) => api<{ chatId: string }>(`/dm/${userId}`, { method: 'POST' }),
    onSuccess: r => router.push(`/chat/${r.chatId}`),
    onError: e => {
      const m = e instanceof ApiError ? momentFor(e.code, e.message, e.data) : null;
      if (m) setMoment(m); else Alert.alert(e instanceof ApiError ? e.message : 'No connection.');
    },
  });
  return {
    openDm: (userId: string) => start.mutate(userId),
    /** The person a chat is being opened with right now, for a spinner on that button only. */
    openingId: start.isPending ? start.variables : null,
    dmSheet: <PaywallSheet moment={moment} onClose={() => setMoment(null)} />,
  };
}
