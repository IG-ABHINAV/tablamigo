// GET /media/*: uploaded files served from Tablamigo's private bucket (here the local .dev-files stand-in). No database needed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const { build } = await import('./server.js');
const { servableMedia } = await import('./lib/storage.js');

const uid = '0b7c1f2e-6a3d-4e8f-9a1b-2c3d4e5f6a7b';
const avatar = `avatar/${uid}/0123456789abcdef.jpg`;
const idDoc = `id_doc/${uid}/0123456789abcdef.jpg`;
const dir = path.resolve('.dev-files');
let app: Awaited<ReturnType<typeof build>>;

beforeAll(async () => {
  app = await build();
  for (const key of [avatar, idDoc]) {
    fs.mkdirSync(path.dirname(path.join(dir, key)), { recursive: true });
    fs.writeFileSync(path.join(dir, key), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  }
});

afterAll(async () => {
  for (const key of [avatar, idDoc]) fs.rmSync(path.join(dir, key.split('/').slice(0, 2).join('/')), { recursive: true, force: true });
  await app.close();
});

describe('servableMedia', () => {
  it('accepts only the key layout the upload helpers make', () => {
    expect(servableMedia(avatar)).toBe('image/jpeg');
    expect(servableMedia(`chat/${uid}/0123456789abcdef.webp`)).toBe('image/webp');
    expect(servableMedia(`audio/${uid}/0123456789abcdef.m4a`)).toBe('audio/mp4');
  });

  it('never serves government-ID images, other paths or unknown types', () => {
    expect(servableMedia(idDoc)).toBeNull();
    expect(servableMedia(`avatar/${uid}/../../id_doc/${uid}/0123456789abcdef.jpg`)).toBeNull();
    expect(servableMedia(`db-backups/tablamigo/x.dump`)).toBeNull();
    expect(servableMedia(`avatar/${uid}/0123456789abcdef.html`)).toBeNull();
    expect(servableMedia(`avatar/${uid}/short.jpg`)).toBeNull();
  });
});

describe('GET /media/*', () => {
  it('serves a stored photo with its type and a cache header', async () => {
    const r = await app.inject({ method: 'GET', url: `/media/${avatar}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.headers['cache-control']).toBe('public, max-age=14400');
    expect(r.rawPayload.length).toBe(4);
  });

  it('is 404 for an ID image, even though the file exists', async () => {
    expect((await app.inject({ method: 'GET', url: `/media/${idDoc}` })).statusCode).toBe(404);
  });

  it('is 404 for a file that is not there', async () => {
    expect((await app.inject({ method: 'GET', url: `/media/avatar/${uid}/fedcba9876543210.jpg` })).statusCode).toBe(404);
  });
});
