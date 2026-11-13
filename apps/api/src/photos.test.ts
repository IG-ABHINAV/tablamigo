import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['pic_free', 'pic_plus', 'pic_view'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@photos.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { LIMITS } = await import('./lib/plus.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 500;
async function login(name: string): Promise<Api> {
  const email = `${name}@photos.tablamigo`;
  const remoteAddress = `10.89.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}` },
    remoteAddress
  });
  await call('PATCH', '/me', { name, birthdate: '1995-05-05', gender: 'man', homeCountry: 'es' });
  return call;
}

/** A new avatar upload of `name`'s own, as the app makes before it sets a photo (lib/storage.ts presignImage). */
const upload = async (name: string) => (await u[name]('POST', '/uploads/image', { kind: 'avatar', contentType: 'image/jpeg' })).json().publicUrl as string;
const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@photos.tablamigo'}`)[0].id as string;
const setPlus = (name: string, on = true) => sql`update users set plus_until = ${on ? sql`now() + interval '7 days'` : null} where email = ${name + '@photos.tablamigo'}`;

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@photos.tablamigo'`;
  for (const p of PEOPLE) u[p] = await login(p);
  await setPlus('pic_plus', true);
});

afterAll(async () => {
  await sql`delete from users where email like '%@photos.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('Photo gallery (3 free, 6 with Plus)', () => {
  it('free user can add up to 3 photos, 4th is rejected with 403 photo_limit_reached', async () => {
    expect(LIMITS.free.maxPhotos).toBe(3);

    // Initial state: 0 photos
    const init = await u.pic_free('GET', '/me/photos');
    expect(init.statusCode).toBe(200);
    expect(init.json().photos).toHaveLength(0);

    // Add photo 1
    const [url1, url2, url3, url4] = [await upload('pic_free'), await upload('pic_free'), await upload('pic_free'), await upload('pic_free')];
    const p1 = await u.pic_free('POST', '/me/photos', { url: url1 });
    expect(p1.statusCode).toBe(200);
    expect(p1.json().photo.position).toBe(0);

    // Setting first photo sets users.photo_url
    const me1 = await u.pic_free('GET', '/me');
    expect(me1.json().photoUrl).toBe(url1);
    expect(me1.json().photos).toHaveLength(1);

    // Add photo 2 and 3
    const p2 = await u.pic_free('POST', '/me/photos', { url: url2 });
    const p3 = await u.pic_free('POST', '/me/photos', { url: url3 });
    expect(p2.statusCode).toBe(200);
    expect(p3.statusCode).toBe(200);
    expect(p2.json().photo.position).toBe(1);
    expect(p3.json().photo.position).toBe(2);

    // 4th photo fails for free user
    const p4 = await u.pic_free('POST', '/me/photos', { url: url4 });
    expect(p4.statusCode).toBe(403);
    expect(p4.json().error).toBe('photo_limit_reached');
  });

  it('Plus user can upload up to 6 photos, 7th is rejected', async () => {
    expect(LIMITS.plus.maxPhotos).toBe(6);

    for (let i = 1; i <= 6; i++) {
      const res = await u.pic_plus('POST', '/me/photos', { url: await upload('pic_plus') });
      expect(res.statusCode).toBe(200);
      expect(res.json().photo.position).toBe(i - 1);
    }

    const res7 = await u.pic_plus('POST', '/me/photos', { url: await upload('pic_plus') });
    expect(res7.statusCode).toBe(403);
    expect(res7.json().error).toBe('photo_limit_reached');
  });

  it('reordering photos updates positions and mirrors position 0 to users.photo_url', async () => {
    const list = (await u.pic_free('GET', '/me/photos')).json().photos;
    expect(list).toHaveLength(3);

    // Swap order: [p3, p1, p2]
    const reorderedIds = [list[2].id, list[0].id, list[1].id];
    const reorder = await u.pic_free('PUT', '/me/photos/reorder', { photoIds: reorderedIds });
    expect(reorder.statusCode).toBe(200);

    const after = (await u.pic_free('GET', '/me/photos')).json().photos;
    expect(after[0].id).toBe(list[2].id);
    expect(after[0].position).toBe(0);
    expect(after[1].id).toBe(list[0].id);
    expect(after[1].position).toBe(1);
    expect(after[2].id).toBe(list[1].id);
    expect(after[2].position).toBe(2);

    // Primary photo is now p3
    const me = (await u.pic_free('GET', '/me')).json();
    expect(me.photoUrl).toBe(list[2].url);
  });

  it('set main photo promotes it to position 0 and updates users.photo_url', async () => {
    const list = (await u.pic_free('GET', '/me/photos')).json().photos;
    const target = list[2]; // Currently in position 2

    const res = await u.pic_free('POST', `/me/photos/${target.id}/main`);
    expect(res.statusCode).toBe(200);

    const me = (await u.pic_free('GET', '/me')).json();
    expect(me.photoUrl).toBe(target.url);
    expect(me.photos[0].id).toBe(target.id);
    expect(me.photos[0].position).toBe(0);
  });

  it('deleting a photo reindexes remaining and updates main if deleted', async () => {
    const list = (await u.pic_free('GET', '/me/photos')).json().photos;
    const currentMain = list[0];
    const nextExpectedMain = list[1];

    // Delete position 0
    const del = await u.pic_free('DELETE', `/me/photos/${currentMain.id}`);
    expect(del.statusCode).toBe(200);

    const remaining = (await u.pic_free('GET', '/me/photos')).json().photos;
    expect(remaining).toHaveLength(2);
    expect(remaining[0].id).toBe(nextExpectedMain.id);
    expect(remaining[0].position).toBe(0);
    expect(remaining[1].position).toBe(1);

    const me = (await u.pic_free('GET', '/me')).json();
    expect(me.photoUrl).toBe(nextExpectedMain.url);
  });

  it('other users see the photo gallery in GET /users/:id', async () => {
    const freeId = await idOf('pic_free');
    const view = await u.pic_view('GET', `/users/${freeId}`);
    expect(view.statusCode).toBe(200);
    expect(view.json().photos).toHaveLength(2);
    expect(view.json().photos[0].position).toBe(0);
  });
});

describe('A profile photo is the person\'s own upload', () => {
  const OLD = 'https://images.example.com/from-before.jpg';

  it('a link elsewhere, someone else\'s upload or their own chat photo is refused, by PATCH /me and POST /me/photos', async () => {
    const viewId = await idOf('pic_view');
    const chatPhoto = (await u.pic_view('POST', '/uploads/image', { kind: 'chat', contentType: 'image/jpeg' })).json().publicUrl;
    for (const url of ['https://images.example.com/me.jpg', await upload('pic_free'), chatPhoto]) {
      const r = await u.pic_view('PATCH', '/me', { photoUrl: url, bio: 'Hello' });
      expect([url, r.statusCode, r.json().error]).toEqual([url, 400, 'bad_photo']);
      const p = await u.pic_view('POST', '/me/photos', { url });
      expect([url, p.statusCode, p.json().error]).toEqual([url, 400, 'bad_photo']);
    }
    expect((await sql`select photo_url, bio from users where id = ${viewId}`)[0]).toEqual({ photoUrl: null, bio: null });
    expect(await sql`select 1 from user_photos where user_id = ${viewId}`).toEqual([]);
    // Their own avatar upload goes through both ways.
    const mine = await upload('pic_view');
    expect((await u.pic_view('PATCH', '/me', { photoUrl: mine })).statusCode).toBe(200);
    expect((await u.pic_view('POST', '/me/photos', { url: await upload('pic_view') })).statusCode).toBe(200);
    expect((await u.pic_view('GET', '/me')).json().photoUrl).toBe(mine);
  });

  it('a photo set before the check (a link elsewhere) still saves when the app re-sends it with the rest of the profile', async () => {
    const viewId = await idOf('pic_view');
    await sql`update users set photo_url = ${OLD} where id = ${viewId}`;
    const r = await u.pic_view('PATCH', '/me', { photoUrl: OLD, bio: 'Chai and long walks' });
    expect(r.statusCode).toBe(200);
    expect((await sql`select photo_url, bio from users where id = ${viewId}`)[0]).toEqual({ photoUrl: OLD, bio: 'Chai and long walks' });
    // Changing it is a new photo again: a link elsewhere is refused, and so is the old link once it is gone.
    expect((await u.pic_view('PATCH', '/me', { photoUrl: 'https://images.example.com/new.jpg' })).json().error).toBe('bad_photo');
    expect((await u.pic_view('PATCH', '/me', { photoUrl: null })).statusCode).toBe(200);
    expect((await u.pic_view('PATCH', '/me', { photoUrl: OLD })).json().error).toBe('bad_photo');
  });
});
