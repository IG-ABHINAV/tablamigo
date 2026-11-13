// One-tap Join on a plan card (components/ActivityCard.tsx, lib/useQuickJoin.tsx): when the card may offer it, and what a
// refusal says. Pure, so tests/unit/quick-join.test.mjs runs it under node. The server still checks everything
// (POST /activities/:id/join: closed, full, women only, profile, blocks); this only decides whether to show the button.

type Card = { joined?: boolean; closed?: boolean; isPaid?: boolean; womenOnly?: boolean; going?: number; maxPeople?: number | null; startsAt?: string; host?: { id?: string } | null };
type Viewer = { id?: string | null; gender?: string | null } | null | undefined;

/**
 * True when a plan card can join in one tap: someone signed in who isn't the host and isn't in yet, a free plan still open to new people
 * (a ticket needs the plan page), not full (the waitlist is a choice made on the plan page), not over, and women-only only for women.
 */
export function canQuickJoin(a: Card, me: Viewer, now = Date.now()) {
  if (!me?.id || !a) return false;
  if (a.joined || a.closed || a.isPaid) return false;
  if (a.host?.id && a.host.id === me.id) return false;
  if (a.maxPeople != null && (a.going ?? 0) >= a.maxPeople) return false;
  if (a.womenOnly && me.gender !== 'woman') return false;
  // A plan that started more than 2 hours ago is over for joining from a list.
  if (a.startsAt && Date.parse(a.startsAt) < now - 2 * 3600_000) return false;
  return true;
}

/** What a refused join says, the same words the plan page uses. */
export function joinErrorText(code?: string | null, message?: string | null) {
  const known: Record<string, string> = {
    full: 'This plan is full.',
    plan_closed: 'The host closed this plan to new people.',
    women_only: 'This plan is for women only.',
    profile_incomplete: 'Finish your profile first.',
  };
  return (code && known[code]) || message || 'No connection.';
}
