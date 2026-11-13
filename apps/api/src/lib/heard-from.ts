// "How did you hear about us?": the onboarding step's answers (apps/mobile/src/lib/heard-from.ts shows them with labels; a
// unit test keeps the two lists equal). 'skipped' means the person was asked and tapped Skip; NULL means never asked.
export const HEARD_FROM = ['instagram', 'youtube', 'tiktok', 'google', 'play_store', 'friend', 'ai', 'other'] as const;
export const HEARD_FROM_ANSWERS = [...HEARD_FROM, 'skipped'] as const;
export type HeardFrom = typeof HEARD_FROM_ANSWERS[number];
