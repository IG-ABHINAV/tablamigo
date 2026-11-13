import { router } from 'expo-router';
import { signupExtras } from './install-referrer';
import { api, ApiError } from './api';
import { useSession } from './session';
import { queryClient } from './query';

/** Trades a Google ID token (from the Android picker or the web button) for our own session, then carries on where
 *  the email code would: onboarding for a new or unfinished profile, the app otherwise. Throws ApiError. */
export async function finishGoogleSignIn(idToken: string) {
  let r: { accessToken: string; refreshToken: string; isNew: boolean };
  try {
    r = await api('/auth/google', { body: { idToken, ...(await signupExtras()) }, auth: false });
  } catch (e) {
    throw e instanceof ApiError ? e : new ApiError(0, 'no_connection');
  }
  await useSession.getState().setTokens({ accessToken: r.accessToken, refreshToken: r.refreshToken });
  await queryClient.invalidateQueries({ queryKey: ['me'] });
  router.replace(r.isNew ? '/(auth)/onboarding' : '/(tabs)');
}
