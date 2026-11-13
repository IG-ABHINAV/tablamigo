import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'node:crypto';
import { config } from './config.js';

const r2Ready = () => !!(config.r2.accountId && config.r2.accessKey && config.r2.bucket);
let s3: S3Client | null = null;
const client = () => (s3 ??= new S3Client({
  region: 'auto',
  endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: config.r2.accessKey, secretAccessKey: config.r2.secretKey },
}));

/** URL for a stored key, served by GET /media/* (verification selfies are stored by key, not URL). */
export const fileUrl = (key: string) => r2Ready() ? `${config.r2.publicUrl.replace(/\/$/, '')}/${key}` : `${config.publicUrl}/dev-files/${key}`;

export const IMAGE_EXTS = ['jpg', 'png', 'webp'] as const;
export const AUDIO_EXTS = ['m4a', 'webm', 'ogg', 'wav', 'mp3'] as const;

/**
 * True only for a URL this API handed `userId` for one of their own uploads (presignImage, putImage, putAudio):
 * our public base, then `<kind>/<userId>/<16 hex>.<ext>`. Anything else, including another person's upload or any
 * other host, is refused, so a message or post can't make readers' browsers fetch a URL the sender chose.
 */
export function isOwnUpload(url: string, userId: string, kinds: readonly string[], exts: readonly string[] = IMAGE_EXTS) {
  const base = r2Ready() ? `${config.r2.publicUrl.replace(/\/$/, '')}/${config.r2.prefix}` : `${config.publicUrl}/dev-files/`;
  if (!url.startsWith(base)) return false;
  return new RegExp(`^(?:${kinds.join('|')})/${userId}/[0-9a-f]{16}\\.(?:${exts.join('|')})$`).test(url.slice(base.length));
}

/** A short-lived upload URL the app PUTs the image to, plus the public URL it will live at. */
export async function presignImage(userId: string, kind: 'avatar' | 'chat' | 'id_doc', contentType: string) {
  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  const name = `${kind}/${userId}/${crypto.randomBytes(8).toString('hex')}.${ext}`;
  if (!r2Ready()) {
    return { uploadUrl: `${config.publicUrl}/dev-upload/${name}`, publicUrl: `${config.publicUrl}/dev-files/${name}`, key: name };
  }
  const key = config.r2.prefix + name;
  const uploadUrl = await getSignedUrl(client(), new PutObjectCommand({ Bucket: config.r2.bucket, Key: key, ContentType: contentType }), { expiresIn: 300 });
  return { uploadUrl, publicUrl: `${config.r2.publicUrl.replace(/\/$/, '')}/${key}`, key };
}

/**
 * Stores an image the API received itself (the web app uploads through us, because the R2 bucket has no
 * browser CORS). Same key layout as presignImage.
 */
export async function putImage(userId: string, kind: 'avatar' | 'chat' | 'id_doc', contentType: string, body: Buffer) {
  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  const name = `${kind}/${userId}/${crypto.randomBytes(8).toString('hex')}.${ext}`;
  if (!r2Ready()) {
    const file = path.resolve('.dev-files', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
    return { publicUrl: `${config.publicUrl}/dev-files/${name}`, key: name };
  }
  const key = config.r2.prefix + name;
  await client().send(new PutObjectCommand({ Bucket: config.r2.bucket, Key: key, ContentType: contentType, Body: body }));
  return { publicUrl: `${config.r2.publicUrl.replace(/\/$/, '')}/${key}`, key };
}

/**
 * Stores a voice note/audio file.
 */
export async function putAudio(userId: string, contentType: string, body: Buffer) {
  const ext = contentType.includes('webm') ? 'webm' : contentType.includes('ogg') ? 'ogg' : contentType.includes('wav') ? 'wav' : contentType.includes('mp4') || contentType.includes('m4a') ? 'm4a' : 'mp3';
  const name = `audio/${userId}/${crypto.randomBytes(8).toString('hex')}.${ext}`;
  if (!r2Ready()) {
    const file = path.resolve('.dev-files', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
    return { publicUrl: `${config.publicUrl}/dev-files/${name}`, key: name };
  }
  const key = config.r2.prefix + name;
  await client().send(new PutObjectCommand({ Bucket: config.r2.bucket, Key: key, ContentType: contentType, Body: body }));
  return { publicUrl: `${config.r2.publicUrl.replace(/\/$/, '')}/${key}`, key };
}

const MEDIA_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg',
};

/**
 * Content type for a storage key that GET /media/* may serve, or null. Only the layout the upload helpers make
 * (`<prefix><kind>/<userId>/<16 hex>.<ext>`), and never id_doc/: government-ID images are not served to anyone.
 */
export function servableMedia(key: string) {
  if (!key.startsWith(config.r2.prefix)) return null;
  const m = /^(?:avatar|chat|audio)\/[0-9A-Za-z-]+\/[0-9a-f]{16}\.([a-z0-9]+)$/.exec(key.slice(config.r2.prefix.length));
  return m ? MEDIA_TYPES[m[1]] ?? null : null;
}

const MAX_READ = 15_000_000;

/**
 * Reads back an image we stored, by storage key or by the public URL we handed out (users.photo_url).
 * Returns null for anything that is not ours: a URL on another host is never fetched (no SSRF).
 */
export async function readImage(keyOrUrl: string): Promise<Buffer | null> {
  let key = keyOrUrl;
  const base = r2Ready() ? config.r2.publicUrl.replace(/\/$/, '') + '/' : `${config.publicUrl}/dev-files/`;
  if (/^https?:\/\//.test(keyOrUrl)) {
    if (!keyOrUrl.startsWith(base)) return null;
    key = decodeURIComponent(keyOrUrl.slice(base.length).split(/[?#]/)[0]);
  }
  if (!key || key.includes('..')) return null;
  if (!r2Ready()) {
    const root = path.resolve('.dev-files');
    const file = path.resolve(root, key);
    if (!file.startsWith(root + path.sep)) return null;
    const buf = await fs.readFile(file).catch(() => null);
    return buf && buf.length <= MAX_READ ? buf : null;
  }
  try {
    const obj = await client().send(new GetObjectCommand({ Bucket: config.r2.bucket, Key: key }));
    if ((obj.ContentLength ?? 0) > MAX_READ) return null;
    return Buffer.from(await obj.Body!.transformToByteArray());
  } catch (e) {
    if ((e as { name?: string }).name === 'NoSuchKey') return null;
    throw e;
  }
}

/** Removes every file a user uploaded (avatars, chat photos, id documents, voice notes). Used by account deletion. */
export async function deleteUserFiles(userId: string) {
  const prefixes = [`avatar/${userId}/`, `chat/${userId}/`, `id_doc/${userId}/`, `audio/${userId}/`];
  if (!r2Ready()) {
    for (const p of prefixes) await fs.rm(path.resolve('.dev-files', p), { recursive: true, force: true });
    return;
  }
  for (const p of prefixes) {
    const Prefix = config.r2.prefix + p;
    let token: string | undefined;
    do {
      const page = await client().send(new ListObjectsV2Command({ Bucket: config.r2.bucket, Prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).map(o => ({ Key: o.Key! }));
      if (keys.length) await client().send(new DeleteObjectsCommand({ Bucket: config.r2.bucket, Delete: { Objects: keys } }));
      token = page.NextContinuationToken;
    } while (token);
  }
}
