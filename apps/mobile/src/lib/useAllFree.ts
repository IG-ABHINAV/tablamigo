import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useSession } from './session';
import { readAllFree } from './all-free';

/**
 * Whether everything is free right now (lib/all-free.ts), and `ready`: whether the answer is known yet. Read from GET /meta
 * (public, so it works signed out too) and from /me (already fetched by every signed-in screen). A screen that sells holds
 * its buy buttons back until `ready`, so nobody sees a price for a moment while everything is free.
 */
export function useAllFree(): { allFree: boolean; ready: boolean } {
  const signedIn = !!useSession(s => s.tokens);
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api('/meta') });
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<unknown>('/me'), enabled: signedIn });
  const allFree = readAllFree(meta.data) || readAllFree(me.data);
  return { allFree, ready: allFree || meta.isFetched || (signedIn && me.isFetched) };
}
