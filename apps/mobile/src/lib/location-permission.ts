// Whether to show Android's location prompt, and what the answer means. Plain TypeScript, no Expo imports, so
// e2e-web/location-permission.test.mjs can run it with fakes.
//
// Android shows the prompt at most twice: the second "Don't allow" is final and every later request returns "denied"
// without showing anything. Onboarding asks, then opens the map, and the map used to ask again on mount, so a person who
// said no once was asked again within a second and lost their last chance, and the map's locate button then did nothing.
// Now the map's automatic call only checks when this session already heard a no, and a final no offers Settings.
export type Perm = { status: string; canAskAgain?: boolean };
export type PermApi = { request: () => Promise<Perm>; check: () => Promise<Perm> };

/** ask: false only reads the current permission and never shows the system prompt. */
export async function resolvePermission(p: PermApi, ask: boolean): Promise<{ granted: boolean; blocked: boolean }> {
  const r = await (ask ? p.request() : p.check());
  const granted = r.status === 'granted';
  // blocked: Android will not show the prompt again, so only the system Settings can turn location on.
  return { granted, blocked: !granted && r.canAskAgain === false };
}

/** An automatic request (the map opening) may show the prompt only if nobody said no to it in this session. */
export const mayAutoAsk = (s: { denied: boolean }) => !s.denied;
