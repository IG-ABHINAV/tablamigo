// The few react-native exports the libs under test use. Tests change Platform.OS and Share.share, and read Alert.calls.
export const Platform = { OS: 'android', select: o => o[Platform.OS] ?? o.default };
export const Alert = { calls: [], alert: (...args) => { Alert.calls.push(args); } };
export const Share = { calls: [], share: async content => { Share.calls.push(content); return { action: 'sharedAction' }; } };
// Keyboard and AppState for lib/review-prompt.ts: tests flip Keyboard.visible and AppState.currentState.
export const Keyboard = { visible: false, isVisible: () => Keyboard.visible };
export const AppState = { currentState: 'active', listeners: [], addEventListener: (_type, fn) => { AppState.listeners.push(fn); return { remove() {} }; } };
// Linking.openSettings for Profile > Notifications (lib/push.ts): tests count the calls.
export const Linking = { settingsOpened: 0, openSettings: async () => { Linking.settingsOpened++; } };
export default { Platform, Alert, Share, Keyboard, AppState, Linking };
