// expo-notifications without a phone. `state` holds the handler the app installed, the tap listeners, the permission the
// phone answers with and the device token; tests fire taps through `state.listeners`.
export const AndroidImportance = { DEFAULT: 3, HIGH: 4 };
// tokenListeners: the app's addPushTokenListener callbacks (tests rotate the token through them); permissionError makes the
// permission read throw.
export const state = { handler: null, listeners: [], tokenListeners: [], permissionError: null, permission: 'granted', canAskAgain: true, afterAsking: 'granted', asked: 0, token: 'fcm-device-token-1', tokenError: null, lastResponse: null, channels: [] };
export function reset() {
  Object.assign(state, { importance: null, listeners: [], tokenListeners: [], permissionError: null, permission: 'granted', canAskAgain: true, afterAsking: 'granted', asked: 0, token: 'fcm-device-token-1', tokenError: null, lastResponse: null, channels: [] });
}
export function setNotificationHandler(h) { state.handler = h; }
export function addNotificationResponseReceivedListener(fn) {
  state.listeners.push(fn);
  return { remove: () => { state.listeners = state.listeners.filter(f => f !== fn); } };
}
export async function getLastNotificationResponseAsync() { return state.lastResponse; }
export async function setNotificationChannelAsync(id, opts) { state.channels.push([id, opts]); return null; }
export async function getPermissionsAsync() { if (state.permissionError) throw state.permissionError; return { status: state.permission, canAskAgain: state.canAskAgain, ...(state.importance != null ? { android: { importance: state.importance } } : {}) }; }
export async function requestPermissionsAsync() {
  state.asked++; state.permission = state.afterAsking; if (state.afterAsking === 'denied') state.canAskAgain = false;
  return { status: state.afterAsking, canAskAgain: state.canAskAgain, ...(state.importance != null ? { android: { importance: state.importance } } : {}) };
}
export async function getDevicePushTokenAsync() {
  if (state.tokenError) throw state.tokenError;
  return { type: 'android', data: state.token };
}
export function addPushTokenListener(fn) {
  state.tokenListeners.push(fn);
  return { remove: () => { state.tokenListeners = state.tokenListeners.filter(f => f !== fn); } };
}
