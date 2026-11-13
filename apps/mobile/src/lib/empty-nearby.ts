/**
 * Explore's empty state (12 Nov 2026), the parts that are plain so they are unit-tested: the prefilled plan the "Create a plan
 * in <city>" button opens, and the line for each of the nearest cities that have plans (API GET /activities `nearestCities`,
 * sent only when nothing is within 50 km).
 */
export type PlanCity = { city: string; distanceKm: number; plans: number; activityId: string };

type Suggestion = { title: string; emoji: string; category: string };
/** A plan that fits the time of day, so one tap gives the new-plan screen a sensible start. The person can change it all. */
export function suggestedPlan(city: string | null, hour: number): Suggestion {
  const base: Suggestion = hour < 11 ? { title: 'Morning coffee', emoji: '☕', category: 'food' }
    : hour < 15 ? { title: 'Lunch together', emoji: '🍜', category: 'food' }
    : hour < 18 ? { title: 'Sunset walk', emoji: '🌅', category: 'explore' }
    : { title: 'Grab dinner', emoji: '🍽️', category: 'food' };
  const title = city ? `${base.title} in ${city}` : base.title;
  return { ...base, title: title.length <= 80 ? title : base.title };
}

/** "Create a plan in Satara", or "Create a plan here" without a city name. */
export const createInCityLabel = (city: string | null) => (city ? `Create a plan in ${city}` : 'Create a plan here');

/** "Goa · 480 km · 3 plans". */
export function cityLine(c: PlanCity): string {
  const dist = c.distanceKm >= 1000 ? `${c.distanceKm.toLocaleString('en-US')} km` : `${Math.max(1, c.distanceKm)} km`;
  return `${c.city} · ${dist} · ${c.plans} ${c.plans === 1 ? 'plan' : 'plans'}`;
}
