// Connect as a request (API migration 077, 4 Nov 2026). Plain TypeScript, no React Native imports, so tests/unit can run it.

export type ConnectStatus = 'none' | 'requested' | 'incoming' | 'connected';

/** Where this person and I stand, from GET /users/:id. An older API answered only isConnected. */
export function connectStatus(u: { connectionStatus?: string | null; isConnected?: boolean | null } | null | undefined): ConnectStatus {
  const s = u?.connectionStatus;
  if (s === 'none' || s === 'requested' || s === 'incoming' || s === 'connected') return s;
  return u?.isConnected ? 'connected' : 'none';
}

/** The profile's Connect button for each status ('incoming' shows Accept and Decline instead). */
export function connectButton(s: Exclude<ConnectStatus, 'incoming'>): { title: string; icon: 'person-add' | 'time-outline' | 'people'; primary: boolean } {
  if (s === 'connected') return { title: 'Connected', icon: 'people', primary: false };
  if (s === 'requested') return { title: 'Requested', icon: 'time-outline', primary: false };
  return { title: 'Connect', icon: 'person-add', primary: true };
}

/** The world list after another page: keyset pages never repeat a plan, and this keeps it so if a plan moved between two pages. */
export function appendPage<T extends { id: string }>(shown: T[], page: T[]): T[] {
  const seen = new Set(shown.map(a => a.id));
  return [...shown, ...page.filter(a => !seen.has(a.id) && (seen.add(a.id), true))];
}

/** A person's first name for "Hey <first name>" and "When <first name> accepts". */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
