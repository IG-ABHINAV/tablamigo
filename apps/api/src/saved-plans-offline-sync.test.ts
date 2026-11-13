import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['sync_host', 'sync_traveler', 'sync_other', 'sync_woman'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@sync.tablamigo`).join(',');
process.env.REVIEW_CODE = '888888';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown, headers?: Record<string, string>) => Promise<import('light-my-request').Response>;

let ip = 3900;
async function login(name: string): Promise<Api> {
  const email = `${name}@sync.tablamigo`;
  const remoteAddress = `10.99.12.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '888888' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload, headers) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}`, ...(headers ?? {}) },
    remoteAddress
  });
  await call('PATCH', '/me', {
    name,
    birthdate: '1996-06-06',
    gender: name.includes('woman') ? 'woman' : 'man',
    homeCountry: 'IN',
    emergencyContactName: 'Aarav Sharma',
    emergencyContactPhone: '+919876543210'
  });
  return call;
}

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@sync.tablamigo'`;
  for (const p of PEOPLE) {
    u[p] = await login(p);
  }
  // Grant Plus to host so they can create >2 activities
  await sql`update users set plus_until = now() + interval '30 days' where email = 'sync_host@sync.tablamigo'`;
});

afterAll(async () => {
  await sql`delete from users where email like '%@sync.tablamigo'`;
  await app.close();
});

describe('Feature 32: Offline Caching & Plan Bookmarks Auto-Sync', () => {
  let plan1Id: string;
  let plan2Id: string;
  let plan3Id: string;

  beforeAll(async () => {
    // Host creates 3 plans in Mumbai
    const p1 = await u.sync_host('POST', '/activities', {
      title: 'Colaba Heritage & Chai Walk',
      emoji: '☕',
      category: 'culture',
      placeName: 'Gateway of India',
      lat: 18.922,
      lng: 72.834,
      startsAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString()
    });
    plan1Id = p1.json().id;

    const p2 = await u.sync_host('POST', '/activities', {
      title: 'Marine Drive Sunset Stroll',
      emoji: '🌅',
      category: 'outdoors',
      placeName: 'Girgaon Chowpatty',
      lat: 18.954,
      lng: 72.815,
      startsAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString()
    });
    plan2Id = p2.json().id;

    const p3 = await u.sync_host('POST', '/activities', {
      title: 'Bandra Street Food Tour',
      emoji: '🍜',
      category: 'food',
      placeName: 'Carter Road Food Strip',
      lat: 19.065,
      lng: 72.825,
      startsAt: new Date(Date.now() + 36 * 3600 * 1000).toISOString()
    });
    plan3Id = p3.json().id;
  });

  it('saves a plan with private offline notes and retrieves them via GET /activities/saved', async () => {
    const saveRes = await u.sync_traveler('POST', `/activities/${plan1Id}/save`, {
      save: true,
      notes: 'Meet near entrance gate 2. Carry umbrella and water bottle.'
    });
    expect(saveRes.statusCode).toBe(200);
    expect(saveRes.json().ok).toBe(true);
    expect(saveRes.json().saved).toBe(true);

    const listRes = await u.sync_traveler('GET', '/activities/saved');
    expect(listRes.statusCode).toBe(200);
    const item = listRes.json().saved.find((x: any) => x.id === plan1Id);
    expect(item).toBeDefined();
    expect(item.savedNotes).toBe('Meet near entrance gate 2. Carry umbrella and water bottle.');
    expect(item.cachedAt).toBeDefined();
    expect(item.updatedAt).toBeDefined();
  });

  it('updates private notes on a bookmarked plan via PUT /activities/:id/save/notes', async () => {
    const updateRes = await u.sync_traveler('PUT', `/activities/${plan1Id}/save/notes`, {
      notes: 'Updated: Meeting point shifted to Leopold Cafe front porch.'
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().ok).toBe(true);
    expect(updateRes.json().notes).toBe('Updated: Meeting point shifted to Leopold Cafe front porch.');

    const listRes = await u.sync_traveler('GET', '/activities/saved');
    const item = listRes.json().saved.find((x: any) => x.id === plan1Id);
    expect(item.savedNotes).toBe('Updated: Meeting point shifted to Leopold Cafe front porch.');
  });

  it('enforces notes length limit (max 500 chars)', async () => {
    const tooLong = 'A'.repeat(501);
    const res = await u.sync_traveler('PUT', `/activities/${plan1Id}/save/notes`, {
      notes: tooLong
    });
    expect(res.statusCode).toBe(400);
  });

  it('batch syncs offline queued bookmark changes via POST /activities/saved/sync', async () => {
    // Traveler queues actions offline: save plan 2, save plan 3 with notes, unsave plan 1
    const syncRes = await u.sync_traveler('POST', '/activities/saved/sync', {
      items: [
        { activityId: plan2Id, save: true, notes: 'Rent a cycle near Chowpatty' },
        { activityId: plan3Id, save: true, notes: 'Try the butter chicken roll' },
        { activityId: plan1Id, save: false }
      ]
    });

    expect(syncRes.statusCode).toBe(200);
    expect(syncRes.json().ok).toBe(true);
    expect(syncRes.json().syncedCount).toBe(3);

    const saved = syncRes.json().saved;
    const hasP1 = saved.some((s: any) => s.id === plan1Id);
    const hasP2 = saved.find((s: any) => s.id === plan2Id);
    const hasP3 = saved.find((s: any) => s.id === plan3Id);

    expect(hasP1).toBe(false);
    expect(hasP2).toBeDefined();
    expect(hasP2.savedNotes).toBe('Rent a cycle near Chowpatty');
    expect(hasP3).toBeDefined();
    expect(hasP3.savedNotes).toBe('Try the butter chicken roll');
  });

  it('downloads a full offline travel pack via GET /activities/saved/offline-bundle', async () => {
    // Traveler also joins plan 2
    const joinRes = await u.sync_traveler('POST', `/activities/${plan2Id}/join`);
    expect(joinRes.statusCode).toBe(200);

    const bundleRes = await u.sync_traveler('GET', '/activities/saved/offline-bundle');
    expect(bundleRes.statusCode).toBe(200);
    const bundle = bundleRes.json();

    expect(bundle.version).toBe(1);
    expect(bundle.generatedAt).toBeDefined();
    expect(bundle.saved.length).toBeGreaterThanOrEqual(2);
    expect(bundle.joined.length).toBeGreaterThanOrEqual(1);

    // Verify joined plans include meeting details and RSVP status
    const joinedPlan = bundle.joined.find((j: any) => j.id === plan2Id);
    expect(joinedPlan).toBeDefined();
    expect(joinedPlan.myRsvpStatus).toBe('going');
    expect(joinedPlan.placeName).toBe('Girgaon Chowpatty');

    // Verify emergency contacts and country helplines
    expect(bundle.emergencyContact.name).toBe('Aarav Sharma');
    expect(bundle.emergencyContact.phone).toBe('+919876543210');
    expect(bundle.helplines.length).toBeGreaterThanOrEqual(3);
    const indiaHelpline = bundle.helplines.find((h: any) => h.country === 'India');
    expect(indiaHelpline.police).toBe('112');
    expect(indiaHelpline.womenHelpline).toBe('181');
  });

  it('protects private notes from other travelers', async () => {
    const otherSaved = await u.sync_other('GET', '/activities/saved');
    expect(otherSaved.statusCode).toBe(200);
    expect(otherSaved.json().saved.length).toBe(0);

    // Other traveler saves plan 2 without notes
    await u.sync_other('POST', `/activities/${plan2Id}/save`, { save: true });
    const otherSavedList = await u.sync_other('GET', '/activities/saved');
    const match = otherSavedList.json().saved.find((s: any) => s.id === plan2Id);
    expect(match.savedNotes).toBeNull();
  });

  it('verifies GET /chats exposes womenOnly flag accurately', async () => {
    // Woman user joins women-only city chat in Mumbai (she is in Mumbai, so the free city-chat window applies)
    await sql`update users set city = 'Mumbai' where email = 'sync_woman@sync.tablamigo'`;
    const joinRes = await u.sync_woman('POST', '/cities/mumbai/join-chat', { womenOnly: true });
    expect(joinRes.statusCode).toBe(200);
    expect(joinRes.json().womenOnly).toBe(true);

    const chatsRes = await u.sync_woman('GET', '/chats');
    expect(chatsRes.statusCode).toBe(200);
    const womenChat = chatsRes.json().chats.find((c: any) => c.id === joinRes.json().chatId);
    expect(womenChat).toBeDefined();
    expect(womenChat.womenOnly).toBe(true);
    expect(womenChat.emoji).toBe('🌸');
  });

  it('exploit: a man cannot save, sync or download a women-only plan, and saved lists drop plans he cannot see', async () => {
    const wo = (await u.sync_woman('POST', '/activities', {
      title: 'Women Only Sunrise Yoga', category: 'outdoors', placeName: 'Juhu Beach', placeAddress: 'Juhu, Mumbai',
      lat: 19.098, lng: 72.826, startsAt: new Date(Date.now() + 20 * 3600 * 1000).toISOString(), womenOnly: true,
    })).json();
    expect(wo.id).toBeTruthy();
    const man = u.sync_other;
    // Every write path refuses it, as GET /activities/:id does.
    expect((await man('GET', `/activities/${wo.id}`)).statusCode).toBe(404);
    expect((await man('POST', `/activities/${wo.id}/save`, { save: true })).statusCode).toBe(404);
    expect((await man('PUT', `/activities/${wo.id}/save/notes`, { notes: 'x' })).statusCode).toBe(404);
    const synced = (await man('POST', '/activities/saved/sync', { items: [{ activityId: wo.id, save: true }] })).json();
    expect(synced.saved.map((a: any) => a.id)).not.toContain(wo.id);
    const manId = (await sql`select id from users where email = 'sync_other@sync.tablamigo'`)[0].id;
    expect((await sql`select count(*)::int as n from saved_activities where user_id = ${manId} and activity_id = ${wo.id}`)[0].n).toBe(0);

    // A save left over from before (the old code allowed it) no longer returns the plan's address, members or chat.
    await sql`insert into saved_activities (user_id, activity_id) values (${manId}, ${wo.id}) on conflict do nothing`;
    const listed = JSON.stringify((await man('GET', '/activities/saved')).json());
    const bundle = JSON.stringify((await man('GET', '/activities/saved/offline-bundle')).json());
    for (const body of [listed, bundle]) { expect(body).not.toContain(wo.id); expect(body).not.toContain('Juhu'); }

    // Women still can.
    expect((await u.sync_woman('POST', `/activities/${wo.id}/save`, { save: true })).statusCode).toBe(200);
  });

  it('exploit: a plan whose host is on either side of a block drops out of saved lists and cannot be saved', async () => {
    const travelerId = (await sql`select id from users where email = 'sync_traveler@sync.tablamigo'`)[0].id;
    await u.sync_traveler('POST', `/activities/${plan3Id}/save`, { save: true });
    expect((await u.sync_traveler('GET', '/activities/saved')).json().saved.map((a: any) => a.id)).toContain(plan3Id);
    await u.sync_host('POST', `/blocks/${travelerId}`);
    expect((await u.sync_traveler('GET', '/activities/saved')).json().saved.map((a: any) => a.id)).not.toContain(plan3Id);
    expect(JSON.stringify((await u.sync_traveler('GET', '/activities/saved/offline-bundle')).json())).not.toContain(plan3Id);
    expect((await u.sync_traveler('POST', `/activities/${plan2Id}/save`, { save: true })).statusCode).toBe(404);
    await u.sync_host('DELETE', `/blocks/${travelerId}`);
  });
});
