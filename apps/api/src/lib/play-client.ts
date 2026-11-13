/**
 * The Google Play Developer API client (service account PLAY_SERVICE_ACCOUNT_JSON), shared by lib/play.ts (verify, grant,
 * void) and lib/play-ack.ts (the acknowledgement safety net).
 */
import fs from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { config } from './config.js';

export const PASS_SKU = 'tablamigo_trip_pass';

let auth: GoogleAuth | null = null;
export function playAuth() {
  if (!config.playServiceAccount) return null;
  return (auth ??= new GoogleAuth({
    credentials: JSON.parse(fs.readFileSync(config.playServiceAccount, 'utf8')),
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  }));
}

export async function playClient() {
  const a = playAuth();
  if (!a) throw new Error('play_not_configured');
  return a.getClient();
}

export const playBase = () => `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${config.playPackage}`;

/** The Play resource of a purchase: a subscription (v2, by token) or the Trip Pass (an in-app product). */
export const subscriptionUrl = (token: string) => `${playBase()}/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`;
export const passUrl = (token: string) => `${playBase()}/purchases/products/${PASS_SKU}/tokens/${encodeURIComponent(token)}`;
/**
 * Developer-side cancel of a Play subscription (purchases.subscriptionsv2.cancel, DEVELOPER_REQUESTED_STOP_PAYMENTS): no
 * further payments and it can't be restored; access runs to the end of the period already paid. Used when the account is
 * deleted (routes/me.ts DELETE /me). Play's RTDN then reports the cancellation like any other (lib/play.ts). Throws on failure.
 * https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/cancel
 */
export async function cancelPlaySubscription(token: string) {
  const c = await playClient();
  await c.request({ method: 'POST', url: `${subscriptionUrl(token)}:cancel`, data: { cancellationContext: { cancellationType: 'DEVELOPER_REQUESTED_STOP_PAYMENTS' } } });
}
/** Acknowledging a subscription; for the Trip Pass, consuming it acknowledges it (and lets it be bought again next trip). */
export const acknowledgeUrl = (kind: 'subscription' | 'pass', productId: string, token: string) => kind === 'pass'
  ? `${passUrl(token)}:consume`
  : `${playBase()}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`;
