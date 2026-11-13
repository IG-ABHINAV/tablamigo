import * as ImagePicker from 'expo-image-picker';
import { uploadAsync, FileSystemUploadType } from 'expo-file-system/legacy';
import { api } from './api';

/** Pick a photo, upload it straight to storage via a presigned URL, return its public URL.
 *  Uses the native uploader, not fetch: React Native's fetch sends a Blob body with an empty
 *  Content-Type whatever headers you pass, and R2 rejects a presigned PUT whose type differs. */
export async function pickAndUpload(kind: 'avatar' | 'chat'): Promise<string | null> {
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: kind === 'avatar', aspect: [1, 1], quality: 0.7 });
  if (res.canceled || !res.assets?.[0]) return null;
  const a = res.assets[0];
  const contentType = a.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
  const { uploadUrl, publicUrl } = await api('/uploads/image', { body: { kind, contentType } });
  const put = await uploadAsync(uploadUrl, a.uri, { httpMethod: 'PUT', uploadType: FileSystemUploadType.BINARY_CONTENT, headers: { 'Content-Type': contentType } });
  if (put.status < 200 || put.status >= 300) throw new Error(`upload_failed_${put.status}`);
  return publicUrl;
}
