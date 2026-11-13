import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

type Tokens = { accessToken: string; refreshToken: string };
// impersonating: only the web app can be opened by an admin's read-only "Login as user" (session.web.ts); never on a phone.
type S = { tokens: Tokens | null; ready: boolean; impersonating: boolean; setTokens: (t: Tokens | null) => Promise<void>; load: () => Promise<void> };

const KEY = 'tablamigo.tokens';
export const useSession = create<S>(set => ({
  tokens: null, ready: false, impersonating: false,
  setTokens: async t => {
    if (t) await SecureStore.setItemAsync(KEY, JSON.stringify(t)); else await SecureStore.deleteItemAsync(KEY);
    set({ tokens: t });
  },
  load: async () => {
    const raw = await SecureStore.getItemAsync(KEY).catch(() => null);
    set({ tokens: raw ? JSON.parse(raw) : null, ready: true });
  },
}));
