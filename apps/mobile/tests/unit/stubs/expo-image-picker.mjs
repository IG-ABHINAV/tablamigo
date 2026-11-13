// expo-image-picker without a phone. Tests set `state` (permission, what the camera / gallery returns) and read `calls`.
export const CameraType = { front: 'front', back: 'back' };
export const calls = [];
const shot = { canceled: false, assets: [{ uri: 'file:///cache/shot.jpg', mimeType: 'image/jpeg' }] };
export const state = { cameraPermission: { granted: true, status: 'granted' }, camera: shot, library: shot };
export function reset() {
  calls.length = 0;
  Object.assign(state, { cameraPermission: { granted: true, status: 'granted' }, camera: shot, library: shot });
}
export async function requestCameraPermissionsAsync() {
  calls.push(['requestCameraPermissionsAsync']);
  if (state.cameraPermission instanceof Error) throw state.cameraPermission;
  return state.cameraPermission;
}
export async function launchCameraAsync(opts) { calls.push(['launchCameraAsync', opts]); return state.camera; }
export async function launchImageLibraryAsync(opts) { calls.push(['launchImageLibraryAsync', opts]); return state.library; }
