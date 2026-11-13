import * as Location from 'expo-location';
import { create } from 'zustand';
import { api } from './api';
import { resolvePermission } from './location-permission';

type P = { lat: number; lng: number };
type Picked = P & { city: string | null };
// denied: the last answer was no. blocked: Android won't ask again (see location-permission.ts), so only Settings can help.
// settled: locate() has answered at least once (a fix, a no, or nothing), so screens stop waiting for the phone.
// picked: a city chosen on the "pick a city" screen (app/pick-city.tsx); it wins until a fix arrives from asking again.
// There is deliberately no fallback point here: lib/where.ts decides what to show without a fix (lib/useHere.ts).
type S = {
  pos: P | null; city: string | null; denied: boolean; blocked: boolean; settled: boolean; picked: Picked | null;
  locate: (o?: { ask?: boolean }) => Promise<P | null>; pick: (p: Picked | null) => void;
};

export const useLocation = create<S>((set, get) => {
  // Never throws: no fix (indoors, GPS off, airplane mode) just keeps the previous position.
  // ask: false checks the permission without showing the prompt (the map's automatic call after a no in onboarding).
  const fix = async (ask: boolean): Promise<P | null> => {
    try {
      const { granted, blocked } = await resolvePermission({ request: Location.requestForegroundPermissionsAsync, check: Location.getForegroundPermissionsAsync }, ask);
      if (!granted) { set({ denied: true, blocked }); return get().pos; }
      set({ blocked: false });
    } catch { return get().pos; }
    // A cached fix is fine only if it's fresh: a traveler who just landed would otherwise see their last city.
    const fresh = await Location.getLastKnownPositionAsync({ maxAge: 10 * 60_000, requiredAccuracy: 2000 }).catch(() => null);
    const cur = fresh
      ?? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null)
      ?? (get().pos ? null : await Location.getLastKnownPositionAsync().catch(() => null)); // stale beats nothing on first load
    if (!cur) return get().pos;
    const pos = { lat: cur.coords.latitude, lng: cur.coords.longitude };
    set({ pos, denied: false, picked: null });
    api<{ city: string | null }>('/me/location', { body: pos }).then(r => set({ city: r.city })).catch(() => {});
    return pos;
  };
  return {
    pos: null, city: null, denied: false, blocked: false, settled: false, picked: null,
    pick: picked => set({ picked }),
    locate: async ({ ask = true } = {}) => { try { return await fix(ask); } finally { set({ settled: true }); } },
  };
});
