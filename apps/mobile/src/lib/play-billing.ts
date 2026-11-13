// Google Play purchases in the Android app. Every purchase is verified with the API (POST /billing/google/verify grants Plus and
// acknowledges or consumes it with Google), wherever the person is in the app. The listener used to live in the paywall only, so a
// payment that settles later (UPI, cash at a shop: Play reports it "pending" first) completed with nobody listening, was never
// verified or acknowledged, and Google refunds an unacknowledged purchase after 3 days. Now it runs from app start (the tabs, once
// signed in, while anything is for sale) until sign-out, and each start also verifies purchases that completed while the app was
// closed. The paywall shares this connection and only shows the outcome (onPurchaseEvent).
import { initConnection, endConnection, getAvailablePurchases, finishTransaction, purchaseUpdatedListener, purchaseErrorListener } from 'expo-iap';
import { Platform } from 'react-native';
import { api } from './api';
import { queryClient } from './query';

export const SKU = 'tablamigo_plus';
export const PASS = 'tablamigo_trip_pass'; // one-time, 14 days of Plus; the API grants and consumes it

export type PurchaseEvent =
  | { kind: 'verified'; productId: string }
  | { kind: 'pending'; productId: string }
  | { kind: 'verify_failed'; productId: string }
  | { kind: 'error'; code?: string };

const listeners = new Set<(e: PurchaseEvent) => void>();
/** What the paywall shows ("You're Plus!", "Purchase did not go through"). Returns the unsubscribe. */
export function onPurchaseEvent(fn: (e: PurchaseEvent) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
const emit = (e: PurchaseEvent) => listeners.forEach(fn => { try { fn(e); } catch {} });

const tokenOf = (p: any): string | undefined => p?.purchaseToken ?? p?.purchaseTokenAndroid ?? undefined;
const verifying = new Set<string>();

/**
 * One purchase from Play: a pending one waits (Play delivers it again once it is paid); a completed one is verified with the API,
 * then finished on the phone. A failed verify leaves it unfinished, so the next app start (getAvailablePurchases) tries again.
 */
export async function handlePurchase(p: any): Promise<PurchaseEvent['kind'] | 'skipped'> {
  const token = tokenOf(p);
  const productId: string = p?.productId ?? SKU;
  if (!token) return 'skipped';
  if (p.purchaseState === 'pending') { emit({ kind: 'pending', productId }); return 'pending'; }
  if (verifying.has(token)) return 'skipped';
  verifying.add(token);
  try {
    try { await api('/billing/google/verify', { body: { productId, purchaseToken: token } }); }
    catch { emit({ kind: 'verify_failed', productId }); return 'verify_failed'; }
    // The API has already acknowledged (subscription) or consumed (Trip Pass) it with Google; this is the phone's side of it.
    await finishTransaction({ purchase: p, isConsumable: productId === PASS }).catch(() => {});
    await queryClient.invalidateQueries();
    emit({ kind: 'verified', productId });
    return 'verified';
  } finally { verifying.delete(token); }
}

let connection: Promise<boolean> | null = null;
/** The app's one Play Billing connection; the paywall waits on it instead of opening (and closing) its own. */
export function connectPlay(): Promise<boolean> {
  return (connection ??= initConnection().then(() => true, () => { connection = null; return false; }));
}

let stop: (() => void) | null = null;
/**
 * Android only: listen for purchases from now until the returned stop (sign-out), and verify the purchases Play still holds
 * unacknowledged (completed while the app was closed, or whose verify failed last time). Calling it again while it runs is a no-op
 * that returns the same stop.
 */
export function startPlayPurchases(): () => void {
  if (Platform.OS !== 'android') return () => {};
  if (stop) return stop;
  let alive = true;
  const upd = purchaseUpdatedListener(p => { void handlePurchase(p); });
  const err = purchaseErrorListener(e => emit({ kind: 'error', code: (e as any)?.code }));
  void (async () => {
    if (!(await connectPlay()) || !alive) return;
    try {
      const owned: any[] = (await getAvailablePurchases()) ?? [];
      for (const p of owned) if (alive && p?.purchaseState === 'purchased' && p.isAcknowledgedAndroid !== true) await handlePurchase(p);
    } catch {}
  })();
  const mine = () => {
    if (stop !== mine) return;
    alive = false; stop = null; connection = null;
    upd.remove(); err.remove();
    endConnection().catch(() => {});
  };
  stop = mine;
  return mine;
}
