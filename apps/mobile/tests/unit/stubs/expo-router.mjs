// expo-router's imperative router: records where the app navigated.
export const pushed = [];
export const router = { push: p => { pushed.push(p); }, replace: p => { pushed.push(p); }, back: () => {} };
