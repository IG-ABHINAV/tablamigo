// Who is arriving where, and when a trip has just started: the "Lands today" labels on a city page and the "You've landed"
// card on the map. Dates are the trip's calendar days ('2026-11-02'), compared with today's date where the phone is.
// Tested in tests/unit/arrivals.test.mjs.

/** Today's calendar date where the phone is, as 'YYYY-MM-DD'. */
export const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Whole days from `from` to `to`, both 'YYYY-MM-DD' (or longer ISO strings, of which the date part counts). */
export function daysBetween(from: string, to: string) {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

/** The label under a traveller visiting a city: 'Here now', 'Lands today', 'Lands tomorrow' or 'Arrives 12 Nov'. */
export function arrivalLabel(startDate: string | null | undefined, today = localDay()) {
  if (!startDate) return null;
  const d = daysBetween(today, startDate);
  if (d < 0) return 'Here now';
  if (d === 0) return 'Lands today';
  if (d === 1) return 'Lands tomorrow';
  const dt = new Date(Date.UTC(+startDate.slice(0, 4), +startDate.slice(5, 7) - 1, +startDate.slice(8, 10)));
  return `Arrives ${dt.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dt.getUTCMonth()]}`;
}

/** Travellers visiting a city, those already there or landing soonest first. */
export const byArrival = <P extends { tripStartDate?: string | null }>(people: P[]) =>
  [...(people ?? [])].sort((a, b) => String(a.tripStartDate ?? '9999').localeCompare(String(b.tripStartDate ?? '9999')));

type Trip = { id: string; city: string; countryCode?: string | null; cityKey?: string | null; startDate: string; endDate: string };

/**
 * The trip someone has just landed on: it started today or yesterday and hasn't ended. The map shows a "You've landed in X"
 * card for it (who's here, today's plans), once per trip. Null when no trip started in that window.
 */
export function landedTrip<P extends Trip>(trips: P[] | null | undefined, today = localDay(), dismissed: string[] = []): P | null {
  const fresh = (trips ?? []).filter(t => {
    if (!t?.startDate || !t?.endDate || dismissed.includes(t.id)) return false;
    const since = daysBetween(t.startDate, today);
    return since >= 0 && since <= 1 && daysBetween(today, t.endDate) >= 0;
  });
  // The most recent start wins (a trip that began today over yesterday's).
  return fresh.sort((a, b) => b.startDate.localeCompare(a.startDate))[0] ?? null;
}
