import { OAuth2Client } from 'google-auth-library';
import { config } from './config.js';
import { HttpError } from './errors.js';

const client = new OAuth2Client();

/** Checks a Google ID token (signature, expiry, issuer, audience = our web client id) and returns the verified email.
 *  Throws 401 google_token_invalid for anything we can't trust, 403 google_email_unverified for an unverified address. */
export async function verifyGoogleIdToken(idToken: string): Promise<{ email: string; name?: string }> {
  let p;
  try {
    p = (await client.verifyIdToken({ idToken, audience: config.googleWebClientId })).getPayload();
  } catch {
    throw new HttpError(401, 'google_token_invalid');
  }
  // verifyIdToken already checks the audience; checking again keeps a mocked or misconfigured verifier from widening it.
  if (!p || p.aud !== config.googleWebClientId || !p.email) throw new HttpError(401, 'google_token_invalid');
  if (p.email_verified !== true) throw new HttpError(403, 'google_email_unverified');
  // Onboarding asks for a first name, so prefer given_name over the full name.
  return { email: p.email.toLowerCase(), name: p.given_name || p.name };
}
