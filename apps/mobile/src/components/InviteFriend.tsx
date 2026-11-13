import React, { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Button } from './ui';
import { shareInvite } from '../lib/share';
import { api, trackEvent } from '../lib/api';
import { C } from '../lib/theme';

/** "Invite a friend": the native share sheet with the person's own invite link (both get Plus days when the friend signs up through
 *  it), or the generic Play + website links if that link can't be fetched (signed out, offline, ALL_FREE). */
export function InviteFriendButton({ kind = 'soft', style }: { kind?: 'primary' | 'ghost' | 'soft'; style?: React.ComponentProps<typeof Button>['style'] }) {
  const [copied, setCopied] = useState(false);
  const invite = async () => {
    trackEvent('invite_tapped', { surface: 'empty_plans' });
    const ref = await api<{ referralLink: string | null; rewardDays: number }>('/me/referral', { timeoutMs: 5000 }).catch(() => null);
    const r = await shareInvite(ref?.referralLink ? { link: ref.referralLink, rewardDays: ref.rewardDays } : null);
    if (r === 'copied') { setCopied(true); setTimeout(() => setCopied(false), 2500); }
  };
  return (
    <Button
      title={copied ? 'Invite copied, paste it anywhere' : 'Invite a friend'}
      kind={kind}
      onPress={invite}
      icon={<Ionicons name={copied ? 'checkmark' : 'share-social-outline'} size={18} color={kind === 'primary' ? '#fff' : kind === 'ghost' ? C.ink : C.primaryDark} />}
      style={style}
    />
  );
}
