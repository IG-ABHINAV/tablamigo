import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useLocation } from './location';
import { pickHere, type Here } from './where';

/**
 * The place the map, plans, travelers and feed are about (lib/where.ts has the order): a picked city, the phone's fix, the last
 * place the server saw this person, then their home country's main city. Null while the phone is still answering and nothing
 * else is known, and null for good when nothing is known at all: callers don't query anything then, and show the
 * "turn on location or pick a city" state (components/NoPlace.tsx).
 */
export function useHere(): { here: Here | null; settled: boolean } {
  const { pos, city, picked, settled } = useLocation();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<any>('/me') });
  const here = pickHere({
    picked, device: pos, deviceCity: city,
    saved: me.data ? { lat: me.data.lat, lng: me.data.lng, city: me.data.city } : null,
    homeCountry: me.data?.homeCountry ?? null,
    // The home-country guess needs both answers: the phone's and the profile's.
    settled: settled && !me.isLoading,
  });
  return { here, settled: settled && !me.isLoading };
}
