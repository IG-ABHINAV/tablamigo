/**
 * Profile > Delete account (components/LeaveSheet.tsx). 12 Nov 2026: the first screen also offers the two ways to step back
 * without losing anything (snooze, as Bumble and Hinge offer before deleting, and "Notify me when someone near me posts"), and its
 * way on is "Delete anyway". Still one screen before the confirm, still 2 taps. The review of 1 Nov 2026: 3 accounts deleted within 5 minutes of
 * signing up, one saying "no one near me", each one tap from Profile. Now there is one honest screen first: why (optional), and
 * for "no one near me" the two things that change that (a trip, so we message you when a traveller's dates overlap, and the
 * nearest open plan), then the same final confirm as before. Deleting stays 2 taps after the Profile row ("Delete anyway",
 * then "Delete my account"), with no reason required: Google Play requires in-app deletion that is easy to find and finish.
 */
export type LeaveStage = 'why' | 'confirm';

/** The API's DELETION_REASONS (routes/me.ts), in the words the sheet shows. */
export const LEAVE_REASONS: [string, string][] = [
  ['no_one_near', 'No one near me'], ['wrong_city', 'It showed the wrong city'], ['paywall', 'Too much needs Plus'],
  ['not_what_i_wanted', 'Not what I was looking for'], ['privacy', 'Privacy or safety worries'], ['other', 'Something else'],
];

/** Which offer the "why" screen shows for a reason. Only an empty city has a fix we can honestly offer here. */
export const offerFor = (reason: string | null): 'nearby' | null => (reason === 'no_one_near' ? 'nearby' : null);

/** The body DELETE /me gets: the reason when one was picked, nothing otherwise. */
export const deleteBody = (reason: string | null) => (reason && LEAVE_REASONS.some(([c]) => c === reason) ? { reason } : {});

/** The first screen's words (owner, 12 Nov 2026). */
export const RETENTION = {
  line: 'Wait, new travellers join every week. You can come back to people near you in a few weeks.',
  snooze: 'Snooze my account instead',
  notify: 'Notify me when someone near me posts',
};

/** Taps from the "why" screen to a deleted account, whatever is picked: Delete anyway, Delete my account. */
export const TAPS_TO_DELETE = 2;
