import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['photo_host', 'photo_member'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@photo.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 1400;
async function login(name: string): Promise<Api> {
  const email = `${name}@photo.tablamigo`;
  const remoteAddress = `10.98.2.${++ip}`;
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
  await call('PATCH', '/me', {
    name: name === 'photo_host' ? 'Host Traveler' : 'Member Traveler',
    birthdate: '1998-05-15',
    gender: 'woman',
    homeCountry: 'IN',
    travelStyle: ['spontaneous', 'culture'],
    interests: ['coffee']
  });
  return call;
}

const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@photo.tablamigo'}`)[0].id as string;

let hostCall: Api;
let memberCall: Api;

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@photo.tablamigo'`;
  hostCall = await login('photo_host');
  memberCall = await login('photo_member');
});

afterAll(async () => {
  await sql`delete from users where email like '%@photo.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('Feature Backlog 8: Plan Photo Album, Reactions & Lightbox View', () => {
  it('supports posting photos, toggling emoji reactions, notifications, and cascade deletes', async () => {
    // 1. Host creates a plan
    const createRes = await hostCall('POST', '/activities', {
      title: 'Sunset Photo Walk',
      description: 'Golden hour walk by Marine Drive',
      category: 'outdoors',
      startsAt: new Date(Date.now() + 3600_000).toISOString(),
      lat: 18.943,
      lng: 72.823,
      placeName: 'Marine Drive Promenade'
    });
    expect(createRes.statusCode).toBe(200);
    const planId = createRes.json().id;

    // 2. Member joins the plan
    const joinRes = await memberCall('POST', `/activities/${planId}/join`);
    expect(joinRes.statusCode).toBe(200);

    // 3. Member posts a photo
    const photoRes = await memberCall('POST', `/activities/${planId}/photos`, {
      url: 'https://images.unsplash.com/photo-sunset.jpg',
      caption: 'Marine Drive golden hour colors!'
    });
    expect(photoRes.statusCode).toBe(200);
    const photoId = photoRes.json().photo.id;

    // 4. View photos in album
    const albumRes = await hostCall('GET', `/activities/${planId}/photos`);
    expect(albumRes.statusCode).toBe(200);
    const photos = albumRes.json().photos;
    expect(photos.length).toBe(1);
    expect(photos[0].id).toBe(photoId);
    expect(photos[0].reactionsCount).toBe(0);
    expect(photos[0].myReaction).toBeNull();
    expect(photos[0].reactions).toEqual([]);

    // 5. Host reacts with ❤️
    const reactRes1 = await hostCall('POST', `/activities/${planId}/photos/${photoId}/react`, { emoji: '❤️' });
    expect(reactRes1.statusCode).toBe(200);
    expect(reactRes1.json().reacted).toBe(true);
    expect(reactRes1.json().myReaction).toBe('❤️');
    expect(reactRes1.json().reactionsCount).toBe(1);

    // Member checks inbox for the reaction notice
    const inboxRes = await memberCall('GET', '/inbox');
    expect(inboxRes.statusCode).toBe(200);
    const notifications = inboxRes.json().notifications;
    const photoNotice = notifications.find((n: any) => n.kind === 'photo_reaction');
    expect(photoNotice).toBeDefined();
    expect(photoNotice.body).toContain('reacted ❤️');

    // 6. Member also reacts with 🔥
    const reactRes2 = await memberCall('POST', `/activities/${planId}/photos/${photoId}/react`, { emoji: '🔥' });
    expect(reactRes2.statusCode).toBe(200);
    expect(reactRes2.json().reactionsCount).toBe(2);

    // Check album summary from member's perspective
    const albumRes2 = await memberCall('GET', `/activities/${planId}/photos`);
    expect(albumRes2.statusCode).toBe(200);
    const p2 = albumRes2.json().photos[0];
    expect(p2.reactionsCount).toBe(2);
    expect(p2.myReaction).toBe('🔥');

    // 7. Member toggles off reaction
    const toggleOff = await memberCall('POST', `/activities/${planId}/photos/${photoId}/react`, { emoji: '🔥' });
    expect(toggleOff.statusCode).toBe(200);
    expect(toggleOff.json().reacted).toBe(false);
    expect(toggleOff.json().myReaction).toBeNull();
    expect(toggleOff.json().reactionsCount).toBe(1);

    // 8. Delete photo by uploader
    const delRes = await memberCall('DELETE', `/activities/${planId}/photos/${photoId}`);
    expect(delRes.statusCode).toBe(200);

    const albumAfterDel = await hostCall('GET', `/activities/${planId}/photos`);
    expect(albumAfterDel.json().photos.length).toBe(0);
  });
});
