// DELETE /me and the person's uploaded files on Cloudflare R2. account-deletion.test.ts covers the local-disk branch of
// deleteUserFiles; production runs this one: list every object under avatar/, chat/, id_doc/ and audio/ (voice notes) for the
// user, under the bucket's key prefix, and delete them page by page. A fake S3 client stands in for R2; nothing leaves the machine.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const D = '@acctr2.tablamigo';
process.env.REVIEW_EMAILS = ['gone', 'stays', 'broken'].map(n => n + D).join(',');
process.env.REVIEW_CODE = '616161';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { config } = await import('./lib/config.js');
const { putImage, putAudio } = await import('./lib/storage.js');
const { setMailTransport } = await import('./lib/mail.js');

// ---- R2 (fake): a map of key -> body, listed in pages of two so pagination is exercised ----
const bucket = new Map<string, string>();
const listed: string[] = [];
let failList = false;
vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (cmd: unknown) => {
  if (cmd instanceof PutObjectCommand) { bucket.set(cmd.input.Key!, 'x'); return {}; }
  if (cmd instanceof ListObjectsV2Command) {
    const prefix = cmd.input.Prefix!;
    if (failList) throw new Error('R2 is down');
    listed.push(prefix);
    // Like S3, the continuation token is a position in key order ("after this key"), so deleting a page doesn't skip the next one.
    const after = cmd.input.ContinuationToken;
    const keys = [...bucket.keys()].filter(k => k.startsWith(prefix) && (!after || k > after)).sort();
    const page = keys.slice(0, 2);
    return { Contents: page.map(Key => ({ Key })), NextContinuationToken: keys.length > 2 ? page[page.length - 1] : undefined };
  }
  if (cmd instanceof DeleteObjectsCommand) { for (const o of cmd.input.Delete!.Objects!) bucket.delete(o.Key!); return {}; }
  throw new Error(`unexpected S3 command ${(cmd as object).constructor.name}`);
}) as never);

let app: Awaited<ReturnType<typeof build>>;
const mails: string[] = [];
const id: Record<string, string> = {};
const tok: Record<string, string> = {};
let ip = 0;
async function login(name: string) {
  const email = name + D, remoteAddress = `10.89.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '616161' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  tok[name] = r.json().accessToken;
  id[name] = (await sql`select id from users where email = ${email}`)[0].id;
}
const del = (name: string) => app.inject({ method: 'DELETE', url: '/me', headers: { authorization: `Bearer ${tok[name]}` } });
// Everything a person can upload, 3 files of each kind (more than one page of the fake listing).
async function upload(who: string) {
  const keys: string[] = [];
  for (let i = 0; i < 3; i++) {
    for (const kind of ['avatar', 'chat', 'id_doc'] as const) keys.push((await putImage(id[who], kind, 'image/jpeg', Buffer.from('x'))).key);
    keys.push((await putAudio(id[who], 'audio/webm', Buffer.from('x'))).key);
  }
  return keys;
}

beforeAll(async () => {
  setMailTransport(async m => { mails.push(m.subject); return { id: `re_${mails.length}` }; });
  Object.assign(config.r2, { accountId: 'acct', accessKey: 'ak', secretKey: 'sk', bucket: 'tablamigo-test', publicUrl: 'https://media.example.test', prefix: 'tablamigo/' });
  app = await build();
  await sql`delete from users where email like ${'%' + D}`;
  for (const n of ['gone', 'stays', 'broken']) await login(n);
});
afterAll(async () => {
  await vi.waitFor(() => expect(mails.filter(m => m === 'Your Tablamigo account is deleted')).toHaveLength(2), { timeout: 5000 });   // the confirmation emails go out after the response
  setMailTransport(null);
  Object.assign(config.r2, { accountId: '', accessKey: '', secretKey: '', bucket: '', publicUrl: '', prefix: '' });
  vi.restoreAllMocks();
  await sql`delete from users where email like ${'%' + D} or id = any(${Object.values(id)}::uuid[])`;
  await app.close();
  await sql.end();
});

describe('account deletion and R2', () => {
  it('removes every avatar, chat photo, ID document and voice note of the person under the bucket prefix, and nobody else\'s', async () => {
    const mine = await upload('gone'), theirs = await upload('stays');
    bucket.set('tablamigo/avatar/not-a-user/x.jpg', 'x');   // something that merely shares a folder
    expect(mine).toHaveLength(12);
    for (const k of mine) expect(k, k).toMatch(new RegExp(`^tablamigo/(avatar|chat|id_doc|audio)/${id.gone}/[0-9a-f]{16}\\.(jpg|webm)$`));
    for (const k of mine) expect(bucket.has(k), k).toBe(true);

    expect((await del('gone')).statusCode).toBe(200);

    for (const k of mine) expect(bucket.has(k), `${k} still in R2`).toBe(false);
    for (const k of theirs) expect(bucket.has(k), `${k} belongs to someone else`).toBe(true);
    expect(bucket.has('tablamigo/avatar/not-a-user/x.jpg')).toBe(true);
    // All four kinds were looked at, voice notes (audio/) included, each under the bucket prefix.
    expect(new Set(listed.filter(p => p.includes(id.gone)))).toEqual(new Set(['avatar', 'chat', 'id_doc', 'audio'].map(k => `tablamigo/${k}/${id.gone}/`)));
    expect((await sql`select deleted_at from users where id = ${id.gone}`)[0].deletedAt).not.toBeNull();
  });

  it('an R2 outage does not stop the deletion: the account is wiped, the file cleanup fails quietly', async () => {
    await upload('broken');
    failList = true;
    try {
      expect((await del('broken')).statusCode).toBe(200);
    } finally { failList = false; }
    const [row] = await sql`select deleted_at, name, email from users where id = ${id.broken}`;
    expect(row.deletedAt).not.toBeNull();
    expect(row.name).toBe('Deleted user');
    expect(row.email).toBe(`deleted-${id.broken}@deleted.tablamigo`);
  });
});
