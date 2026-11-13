import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['safe_user'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@trusted.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 1300;
async function login(name: string): Promise<Api> {
  const email = `${name}@trusted.tablamigo`;
  const remoteAddress = `10.97.2.${++ip}`;
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
    name: 'Safety Traveler',
    birthdate: '1998-05-15',
    gender: 'woman',
    homeCountry: 'IN',
    travelStyle: ['spontaneous', 'culture'],
    interests: ['coffee']
  });
  return call;
}

const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@trusted.tablamigo'}`)[0].id as string;

let userCall: Api;

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@trusted.tablamigo'`;
  userCall = await login('safe_user');
});

afterAll(async () => {
  await sql`delete from users where email like '%@trusted.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('Feature 26 & 27: Trusted Contacts & Emergency Safety Dispatch', () => {
  it('manages trusted contacts, enforces free tier limit of 2, and generates emergency dispatch URLs', async () => {
    // 1. Initial list
    const list1 = await userCall('GET', '/safety/contacts');
    expect(list1.statusCode).toBe(200);
    expect(list1.json().contacts).toEqual([]);
    expect(list1.json().limit).toBe(2);
    expect(list1.json().remaining).toBe(2);

    // 2. Add Contact 1
    const add1 = await userCall('POST', '/safety/contacts', {
      name: 'Mom',
      phone: '+919820011111',
      relationship: 'parent',
      notifyOnPlanJoin: true
    });
    expect(add1.statusCode).toBe(200);
    expect(add1.json().ok).toBe(true);
    expect(add1.json().contact.name).toBe('Mom');
    expect(add1.json().contact.relationship).toBe('parent');
    const contact1Id = add1.json().contact.id;

    // 3. Add Contact 2
    const add2 = await userCall('POST', '/safety/contacts', {
      name: 'Priya Partner',
      phone: '+919820022222',
      relationship: 'partner',
      notifyOnPlanJoin: true
    });
    expect(add2.statusCode).toBe(200);
    expect(add2.json().ok).toBe(true);
    const contact2Id = add2.json().contact.id;

    // 4. Try adding Contact 3 on free tier -> 402 plus_required
    const add3 = await userCall('POST', '/safety/contacts', {
      name: 'Alex Brother',
      phone: '+919820033333',
      relationship: 'sibling'
    });
    expect(add3.statusCode).toBe(402);
    expect(add3.json().error).toBe('plus_required');
    expect(add3.json().feature).toBe('trusted_contacts_limit');

    // 5. Create an activity and test SOS dispatch
    const actRes = await userCall('POST', '/activities', {
      title: 'Night Street Food Walk',
      emoji: '🍜',
      category: 'food',
      startsAt: new Date(Date.now() + 3600_000).toISOString(),
      placeName: 'Colaba Causeway',
      city: 'Mumbai',
      lat: 18.9220,
      lng: 72.8317
    });
    expect(actRes.statusCode).toBe(200);
    const activityId = actRes.json().id;

    // 6. Test /safety/sos/dispatch
    const sosRes = await userCall('POST', '/safety/sos/dispatch', {
      activityId,
      lat: 18.9221,
      lng: 72.8318,
      note: 'Need assistance, taking a cab home'
    });
    expect(sosRes.statusCode).toBe(200);
    const sosData = sosRes.json();
    expect(sosData.ok).toBe(true);
    expect(sosData.emergencyNumbers).toBeDefined();
    expect(sosData.mapUrl).toContain('18.9221,72.8318');
    expect(sosData.dispatches.length).toBe(2);

    const momDispatch = sosData.dispatches.find((d: any) => d.name === 'Mom');
    expect(momDispatch).toBeDefined();
    expect(momDispatch.whatsappUrl).toContain('api.whatsapp.com/send');
    expect(momDispatch.whatsappUrl).toContain('919820011111');
    expect(momDispatch.smsUrl).toContain('sms:+919820011111');
    expect(momDispatch.message).toContain('EMERGENCY ALERT');
    expect(momDispatch.message).toContain('Colaba Causeway');

    // 7. Delete Contact 1
    const delRes = await userCall('DELETE', `/safety/contacts/${contact1Id}`);
    expect(delRes.statusCode).toBe(200);

    // 8. Verify list has 1 contact and 1 remaining slot
    const list2 = await userCall('GET', '/safety/contacts');
    expect(list2.statusCode).toBe(200);
    expect(list2.json().contacts.length).toBe(1);
    expect(list2.json().remaining).toBe(1);
  });
});
