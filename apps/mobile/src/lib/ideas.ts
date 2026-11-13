import { useEffect, useState } from 'react';
import { api, ApiError } from './api';

/** An AI plan idea from /ai/suggest. lat/lng are only there when the place was really found near the user. */
export type Idea = { emoji: string; title: string; category: string; placeName: string; why: string; lat?: number; lng?: number };

// Session caches. AI suggestions are metered (free 3/day), so the map asks at most once per city per session,
// and stops asking for the rest of the day once the quota is used up.
const byCity = new Map<string, Idea[]>();
const inFlight = new Map<string, Promise<Idea[]>>();
let exhaustedOn: string | null = null;
const today = () => new Date().toISOString().slice(0, 10);
let shown = true;   // the "Ideas" toggle, kept for the session

async function load(city: string, here: { lat: number; lng: number }): Promise<Idea[]> {
  // Checking the quota is free; asking for ideas uses one.
  const q = await api<{ remaining: number }>('/ai/quota');
  if (q.remaining <= 0) { exhaustedOn = today(); return []; }
  try {
    const r = await api<{ ideas: Idea[]; remaining: number }>(`/ai/suggest?city=${encodeURIComponent(city)}&lat=${here.lat}&lng=${here.lng}`);
    if (r.remaining <= 0) exhaustedOn = today();
    return r.ideas ?? [];
  } catch (e) {
    if (e instanceof ApiError && e.code === 'plus_required') exhaustedOn = today();
    return [];
  }
}

/**
 * Idea pins for the map: only ideas with real coordinates. Fetches only when `want` is true (few real plans
 * on the map, the toggle on, a known city), never twice for one city in a session, never after the daily limit.
 */
export function useMapIdeas(city: string | null, here: { lat: number; lng: number }, want: boolean) {
  const [on, setOn] = useState(shown);
  // The last answer that arrived, with the city it was for. What is shown is derived: this city's session cache, else that answer.
  const [arrived, setArrived] = useState<{ city: string; list: Idea[] } | null>(null);
  const ideas = !city ? [] : byCity.get(city) ?? (arrived?.city === city ? arrived.list : []);
  useEffect(() => {
    if (!city || byCity.has(city)) return;
    if (!want || !on || exhaustedOn === today()) return;
    let live = true;
    let p = inFlight.get(city);
    if (!p) {
      p = load(city, here).catch(() => [] as Idea[]);
      inFlight.set(city, p);
    }
    p.then(list => { byCity.set(city, list); inFlight.delete(city); if (live) setArrived({ city, list }); });
    return () => { live = false; };
  }, [city, want, on]);
  const toggle = () => { shown = !on; setOn(!on); };
  const pins = ideas.filter(i => Number.isFinite(i.lat) && Number.isFinite(i.lng));
  // Once the map has enough real plans the ideas step aside (they stay cached for later).
  return { pins: on && want ? pins : [], available: want && pins.length > 0, on, toggle };
}
