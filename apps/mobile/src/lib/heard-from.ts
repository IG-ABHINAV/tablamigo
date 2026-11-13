// Onboarding's "How did you hear about us?" step: one tap, or Skip. The ids are the API's (apps/api/src/lib/heard-from.ts; a
// unit test keeps the two lists equal). Play tags organic installs as "Google Play", which hid where most people came from.
export const HEARD_FROM_OPTIONS = [
  ['instagram', 'Instagram'],
  ['youtube', 'YouTube'],
  ['tiktok', 'TikTok'],
  ['google', 'Google search'],
  ['play_store', 'Play Store'],
  ['friend', 'A friend or an invite link'],
  ['ai', 'ChatGPT or another AI'],
  ['other', 'Somewhere else'],
] as const;
export type HeardFrom = typeof HEARD_FROM_OPTIONS[number][0] | 'skipped';

/** Saves the answer without holding up onboarding: a failed save only loses this one answer, never the sign-up. */
export function saveHeardFrom(api: (path: string, init: { body: unknown }) => Promise<unknown>, source: HeardFrom): Promise<void> {
  return api('/me/heard-from', { body: { source } }).then(() => {}, () => {});
}
