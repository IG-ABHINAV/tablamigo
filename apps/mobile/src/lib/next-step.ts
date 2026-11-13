/**
 * The "what now" screen right after onboarding (app/start.tsx). The 30-day review of 1 Nov 2026: 95% finish onboarding, then
 * land on a map that is mostly empty, and three people deleted their account within 5 minutes. This screen gives the two
 * actions that put a person in front of other people: a trip (overlapping travellers are shown on it, and both sides get a
 * trip-match message), or a plan near them (most are the team's starter plans: real meetups with a group chat).
 */
type Plan = { id: string; startsAt: string; going: number; maxPeople?: number | null; joined: boolean; distanceM?: number };

/** The first name to greet with: the first word of the profile name, or nothing. */
export const firstName = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0] ?? '';

/**
 * Up to `n` plans to offer: open ones (not full, not already joined, not started more than 2 hours ago), nearest first, then
 * soonest. Nearby plans when there are any; otherwise the nearest further out, with that radius, so the screen can say how far.
 */
export function startPlans<P extends Plan>(near: P[] | undefined, wider: { radiusKm: number; activities: P[] } | null | undefined, now = Date.now(), n = 2): { plans: P[]; radiusKm: number | null } {
  const open = (list: P[] | undefined) => (list ?? [])
    .filter(a => !a.joined && !(a.maxPeople != null && a.going >= a.maxPeople) && Date.parse(a.startsAt) > now - 2 * 3600_000)
    .sort((x, y) => (x.distanceM ?? Infinity) - (y.distanceM ?? Infinity) || Date.parse(x.startsAt) - Date.parse(y.startsAt));
  const close = open(near);
  if (close.length) return { plans: close.slice(0, n), radiusKm: null };
  const far = open(wider?.activities);
  return far.length ? { plans: far.slice(0, n), radiusKm: wider!.radiusKm } : { plans: [], radiusKm: null };
}
