// expo-store-review in memory: tests read `calls` and steer `state.available` / `state.fail`.
export const calls = { isAvailableAsync: 0, requestReview: 0 };
export const state = { available: true, fail: false };
export const isAvailableAsync = async () => { calls.isAvailableAsync++; return state.available; };
export const requestReview = async () => { calls.requestReview++; if (state.fail) throw new Error('ERR_STORE_REVIEW_FAILED'); };
export const storeUrl = () => null;
export const hasAction = async () => state.available;
