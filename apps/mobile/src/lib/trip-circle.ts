/**
 * Whether a trip screen shows its Trip Circle group chat. QA 1 Nov 2026: an empty circle sat under the city chat as
 * "Join Trip Circle Chat · 0 travelers in this circle" while 7 people overlapped the trip; joining it meant talking to
 * nobody. It shows once someone else is in it; until then one line says a chat comes when others join.
 */
export function showTripCircle(c: { memberCount?: number | null; isMember?: boolean | null } | null | undefined): boolean {
  if (!c) return false;
  return (c.memberCount ?? 0) - (c.isMember ? 1 : 0) > 0;
}

export const EMPTY_CIRCLE_NOTE = "You'll get a group chat when others join your dates.";
