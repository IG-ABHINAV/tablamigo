import * as ImagePicker from 'expo-image-picker';
import { uploadAsync, FileSystemUploadType } from 'expo-file-system/legacy';
import { api, ApiError } from './api';

/** Selfie in the pose we ask for; the API compares it with the profile photo automatically.
 *  Same presigned upload as lib/upload.ts, but it needs the storage key and prefers the front camera.
 *  `hint` (the pose) is only shown by the web camera overlay. */
export async function shootAndUpload(hint?: string): Promise<string | null> {
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.7, cameraType: ImagePicker.CameraType.front };
  const cam = await ImagePicker.requestCameraPermissionsAsync().catch(() => null);
  // A live camera shot only: a gallery photo could be anyone's, which would defeat verification.
  if (!cam?.granted) throw new ApiError(0, 'camera_needed');
  const res = await ImagePicker.launchCameraAsync(opts);
  if (res.canceled || !res.assets?.[0]) return null;
  const a = res.assets[0];
  const contentType = a.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
  const { uploadUrl, key } = await api('/verify/upload', { body: { contentType } });
  const put = await uploadAsync(uploadUrl, a.uri, { httpMethod: 'PUT', uploadType: FileSystemUploadType.BINARY_CONTENT, headers: { 'Content-Type': contentType } });
  if (put.status < 200 || put.status >= 300) throw new Error(`upload_failed_${put.status}`);
  return key;
}
