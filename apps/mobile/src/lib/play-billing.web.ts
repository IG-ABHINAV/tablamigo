// The web app sells through Razorpay (screens/Paywall.web.tsx), never Google Play: nothing to connect or listen for.
export const SKU = 'tablamigo_plus';
export const PASS = 'tablamigo_trip_pass';
export type PurchaseEvent =
  | { kind: 'verified'; productId: string }
  | { kind: 'pending'; productId: string }
  | { kind: 'verify_failed'; productId: string }
  | { kind: 'error'; code?: string };
export const onPurchaseEvent = (_fn: (e: PurchaseEvent) => void) => () => {};
export const handlePurchase = async (_p: unknown) => 'skipped' as const;
export const connectPlay = async () => false;
export const startPlayPurchases = () => () => {};
