// expo-iap (Google Play Billing) without a phone. `state` holds what Play answers (the purchases it still holds, whether the
// connection fails) and records what the app did; tests deliver purchases through `deliver` as Play's purchase listener would.
export const state = { connects: 0, ends: 0, connectError: null, available: [], finished: [], updated: [], errorListeners: [] };
export function reset() {
  Object.assign(state, { connects: 0, ends: 0, connectError: null, available: [], finished: [], updated: [], errorListeners: [] });
}
export const deliver = p => Promise.all(state.updated.map(fn => fn(p)));
export async function initConnection() { if (state.connectError) throw state.connectError; state.connects++; return true; }
export async function endConnection() { state.ends++; return true; }
export async function getAvailablePurchases() { return state.available; }
export async function finishTransaction(args) { state.finished.push(args); return true; }
export async function fetchProducts() { return []; }
export async function requestPurchase() { return null; }
export function purchaseUpdatedListener(fn) {
  state.updated.push(fn);
  return { remove: () => { state.updated = state.updated.filter(f => f !== fn); } };
}
export function purchaseErrorListener(fn) {
  state.errorListeners.push(fn);
  return { remove: () => { state.errorListeners = state.errorListeners.filter(f => f !== fn); } };
}
