import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useSession } from './session';
import { readLaunchOffer, type LaunchOffer } from './launch-offer';

/**
 * The launch offer for the signed-in person (lib/launch-offer.ts), and `ready`: whether the answer is known yet. A screen
 * that sells Plus holds its buy buttons back until `ready`, so nobody is shown "Subscribe" for a moment during the offer.
 * The offer comes from GET /billing/me, or from `launchOffer` on /me (already fetched by every signed-in screen). An API
 * without the route answers 404; that is "no offer", never retried.
 */
export function useLaunchOffer(): LaunchOffer & { ready: boolean } {
  const signedIn = !!useSession(s => s.tokens);
  const billing = useQuery({ queryKey: ['billing-me'], queryFn: () => api<unknown>('/billing/me'), enabled: signedIn, retry: false, staleTime: 5 * 60_000 });
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<unknown>('/me'), enabled: signedIn });
  const fromBilling = readLaunchOffer(billing.data);
  const offer = fromBilling.active ? fromBilling : readLaunchOffer(me.data);
  return { ...offer, ready: !signedIn || billing.isFetched };
}
