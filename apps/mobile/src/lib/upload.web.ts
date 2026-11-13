import * as ImagePicker from 'expo-image-picker';
import { api } from './api';

/** Re-encode as a JPEG no bigger than `max` px (phone photos are 5-12 MB; HEIC won't show in most browsers).
 *  `square` center-crops, like the native avatar editor. Falls back to the original file. */
export async function toJpeg(file: Blob, { max = 1600, square = false } = {}): Promise<Blob> {
  try {
    const img = await createImageBitmap(file);
    const side = Math.min(img.width, img.height);
    const [sw, sh] = square ? [side, side] : [img.width, img.height];
    const s = Math.min(1, max / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.round(sw * s); c.height = Math.round(sh * s);
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, c.width, c.height);
    img.close();
    return await new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.8));
  } catch { return file; }
}

export const imageType = (f: Blob) => f.type === 'image/png' ? 'image/png' : 'image/jpeg';

/** Send the image to our API, which stores it (the shared bucket has no browser CORS). */
export async function uploadDirect(kind: 'avatar' | 'chat', file: Blob, contentType: string): Promise<{ publicUrl: string; key: string }> {
  return api(`/uploads/image/direct?kind=${kind}`, { method: 'POST', raw: file, contentType });
}

/** Pick a photo, upload it through the API, return its public URL. */
export async function pickAndUpload(kind: 'avatar' | 'chat'): Promise<string | null> {
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
  const picked = res.canceled ? null : res.assets?.[0]?.file;
  if (!picked) return null;
  const file = await toJpeg(picked, { square: kind === 'avatar' });
  const contentType = imageType(file);
  return (await uploadDirect(kind, file, contentType)).publicUrl;
}
