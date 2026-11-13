import { create } from 'zustand';
import { api } from './api';

type P = { lat: number; lng: number };
type Picked = P & { city: string | null };
// Same shape as location.ts. The browser decides itself whether to prompt, so `ask` and `blocked` do nothing here.
// There is deliberately no fallback point: lib/where.ts decides what to show without a fix (lib/useHere.ts).
type S = {
  pos: P | null; city: string | null; denied: boolean; blocked: boolean; settled: boolean; picked: Picked | null;
  locate: (o?: { ask?: boolean }) => Promise<P | null>; pick: (p: Picked | null) => void;
};

// The browser prompt can sit unanswered and desktop fixes can take long; never hang the caller.
const fix = () => new Promise<GeolocationPosition | GeolocationPositionError | null>(resolve => {
  if (!navigator.geolocation) return resolve(null);
  const t = setTimeout(() => resolve(null), 20_000);
  navigator.geolocation.getCurrentPosition(p => { clearTimeout(t); resolve(p); }, e => { clearTimeout(t); resolve(e); },
    { maximumAge: 10 * 60_000, timeout: 15_000 });
});

export const useLocation = create<S>((set, get) => ({
  pos: null, city: null, denied: false, blocked: false, settled: false, picked: null,
  pick: picked => set({ picked }),
  // Never throws: no fix (denied, no GPS, insecure origin) just keeps the previous position.
  locate: async () => {
    const r = await fix().catch(() => null);
    set({ settled: true });
    if (!r || !('coords' in r)) { if (r?.code === 1) set({ denied: true }); return get().pos; }
    const pos = { lat: r.coords.latitude, lng: r.coords.longitude };
    set({ pos, denied: false, picked: null });
    api<{ city: string | null }>('/me/location', { body: pos }).then(r => set({ city: r.city })).catch(() => {});
    return pos;
  },
}));
