// Everything in Tablamigo is free right now (founder's decision, 4 Oct 2026). The API says so in `allFree: true` on GET /meta,
// /me and /billing/me (apps/api/src/lib/config.ts ALL_FREE). While it is on, the app shows no prices, no buy buttons, no Plus
// sheets, no Trip Pass prompts and no Plus tags; the paid screens stay in the code for when ALL_FREE is switched off on the
// server, which needs no app release. Plain TypeScript, no React imports, so it is unit-tested with node (e2e-web/all-free.test.mjs).

/** True only when a response body says `allFree: true`. An older API without the field, a null or a string all mean false. */
export function readAllFree(body: unknown): boolean {
  return (body as { allFree?: unknown } | null | undefined)?.allFree === true;
}

export const ALL_FREE_HEADLINE = 'Everything in Tablamigo is free right now';
export const ALL_FREE_BODY = 'Every feature, no ads, nothing to buy. Message anyone, see everyone on your trip dates, join city chats early and host as many plans as you like.';
/** The short line for the Profile card. */
export const ALL_FREE_SHORT = 'Every feature is free: no ads, nothing to buy.';
