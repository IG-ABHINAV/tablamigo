import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['sv_alice', 'sv_brenda', 'sv_charlie'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@safety.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 1200;
async function login(name: string, gender: 'woman' | 'man'): Promise<{ api: Api; id: string; email: string }> {
  const email = `${name}@safety.tablamigo`;
  const remoteAddress = `10.98.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const api: Api = (method, url, payload) =>
    app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` }, remoteAddress });
  // Set profile
  await api('PATCH', '/me', {
    name,
    gender,
    birthdate: '1995-05-15',
    homeCountry: 'IN',
    emergencyContactName: 'Aunt May',
    emergencyContactPhone: '+1-555-0199'
  });
  const me = (await api('GET', '/me')).json();
  return { api, id: me.id, email };
}

describe('Safety & Verification Features (Plan Share, SOS, Women-only filters & chats)', () => {
  let alice: { api: Api; id: string; email: string };
  let brenda: { api: Api; id: string; email: string };
  let charlie: { api: Api; id: string; email: string };
  let activityId: string;

  beforeAll(async () => {
    app = await build();
    await sql`insert into geo_cache (cell, city, country) values ('18.9,72.85', 'Mumbai', 'IN') on conflict (cell) do update set city = excluded.city, country = excluded.country, cached_at = now()`;
    alice = await login('sv_alice', 'woman');
    brenda = await login('sv_brenda', 'woman');
    charlie = await login('sv_charlie', 'man');

    // Create an activity hosted by alice
    const actRes = await alice.api('POST', '/activities', {
      title: 'Sunset Meetup at Colaba',
      category: 'explore',
      placeName: 'Colaba Causeway',
      placeAddress: 'Colaba, Mumbai, Maharashtra 400005',
      lat: 18.9218,
      lng: 72.8347,
      startsAt: new Date(Date.now() + 86400_000).toISOString(),
      maxPeople: 6,
      womenOnly: false
    });
    activityId = actRes.json().id;

    // Brenda joins activity
    await brenda.api('POST', `/activities/${activityId}/join`);
  });

  afterAll(async () => {
    if (activityId) {
      await sql`delete from activities where id = ${activityId}`;
    }
    const emails = PEOPLE.map(p => `${p}@safety.tablamigo`);
    await sql`delete from users where email = any(${emails})`;
    await app.close();
  });

  it('updates emergency contact details on profile', async () => {
    const patchRes = await alice.api('PATCH', '/me', {
      emergencyContactName: 'Aunt May Updated',
      emergencyContactPhone: '+1-555-9999'
    });
    expect(patchRes.statusCode).toBe(200);

    const meRes = await alice.api('GET', '/me');
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().emergencyContactName).toBe('Aunt May Updated');
    expect(meRes.json().emergencyContactPhone).toBe('+1-555-9999');
  });

  it('shares plan with trusted contact via public token', async () => {
    // Non-member cannot generate share link
    const nonMemberRes = await charlie.api('POST', `/activities/${activityId}/share`, { note: 'Going to dinner' });
    expect(nonMemberRes.statusCode).toBe(403);

    // Member can generate share link
    const shareRes = await brenda.api('POST', `/activities/${activityId}/share`, { note: 'Hey Mom, here is my plan for tonight' });
    expect(shareRes.statusCode).toBe(200);
    const { token, shareUrl } = shareRes.json();
    expect(token).toBeTruthy();
    expect(shareUrl).toContain(`/safe/${token}`);

    // Public visitor (unauthenticated) can view safe link
    const publicRes = await app.inject({
      method: 'GET',
      url: `/safe/${token}`
    });
    expect(publicRes.statusCode).toBe(200);
    const data = publicRes.json();
    expect(data.plan.title).toBe('Sunset Meetup at Colaba');
    expect(data.plan.placeName).toBe('Colaba Causeway');
    expect(data.sharer.name).toBe('sv_brenda');
    expect(data.sharer.note).toBe('Hey Mom, here is my plan for tonight');
    expect(data.host.name).toBe('sv_alice');
    expect(data.attendeeCount).toBeGreaterThanOrEqual(1);
    // India's numbers because the plan is in Mumbai, whatever the host's home country says.
    await alice.api('PATCH', '/me', { homeCountry: 'GB' });
    const again = (await app.inject({ method: 'GET', url: `/safe/${token}` })).json();
    expect(again.emergencyNumbers).toEqual({ police: '112', ambulance: '108', general: '112' });
    await alice.api('PATCH', '/me', { homeCountry: 'IN' });
  });

  it('broadcasts SOS alert during an activity with emergency numbers and contact info', async () => {
    const sosRes = await brenda.api('POST', `/activities/${activityId}/sos`, {
      lat: 18.9220,
      lng: 72.8350,
      note: 'Feeling unsafe near the entrance, please call me'
    });
    expect(sosRes.statusCode).toBe(200);
    const data = sosRes.json();
    expect(data.ok).toBe(true);
    expect(data.alertLogged).toBe(true);
    expect(data.emergencyContact.name).toBeTruthy();
    expect(data.emergencyNumbers.police).toBeTruthy();
    expect(data.venue.name).toBe('Colaba Causeway');
  });

  it('exploit: SOS never claims a contact was alerted, and its numbers come from where the plan is', async () => {
    // Brenda has a profile emergency contact and a trusted contact, and lives in the US: before, the API said
    // emergencyContactNotified: true (nobody was sent anything) and gave her 911 in Mumbai.
    await brenda.api('PATCH', '/me', { homeCountry: 'US' });
    await brenda.api('POST', '/safety/contacts', { name: 'Mum', phone: '+1 555 0100', relationship: 'parent' });
    const data = (await brenda.api('POST', `/activities/${activityId}/sos`, { lat: 18.922, lng: 72.835 })).json();
    expect(data.alertDispatched).toBeUndefined();
    expect(data.emergencyContactNotified).toBe(false);
    expect(data.contactsNotified).toBe(0);
    expect(data.dispatches).toHaveLength(1);   // ready-made messages she sends herself
    expect(data.emergencyNumbers).toEqual({ police: '112', ambulance: '108', general: '112' });
    const d = (await brenda.api('POST', '/safety/sos/dispatch', { activityId, lat: 18.922, lng: 72.835 })).json();
    expect(d.emergencyNumbers).toEqual({ police: '112', ambulance: '108', general: '112' });
    await brenda.api('PATCH', '/me', { homeCountry: 'IN' });
  });

  it('exploit: SOS dispatch for a plan needs the caller to be in it', async () => {
    const before = (await sql`select count(*)::int as n from safety_alerts where activity_id = ${activityId}`)[0].n;
    await charlie.api('POST', '/safety/contacts', { name: 'Pal', phone: '+91 90000 00001', relationship: 'friend' });
    const res = await charlie.api('POST', '/safety/sos/dispatch', { activityId });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('not_in_plan');
    // Nothing logged and nothing about the plan (title, place, coordinates) handed back.
    expect((await sql`select count(*)::int as n from safety_alerts where activity_id = ${activityId}`)[0].n).toBe(before);
    expect(JSON.stringify(res.json())).not.toContain('Colaba');
    // The host and members can.
    expect((await alice.api('POST', '/safety/sos/dispatch', { activityId })).statusCode).toBe(200);
    expect((await brenda.api('POST', '/safety/sos/dispatch', { activityId })).statusCode).toBe(200);
  });

  it('filters travelers by women_only exclusively for women travelers', async () => {
    await sql`update users set location = ST_SetSRID(ST_MakePoint(72.8347, 18.9218), 4326)::geography, location_at = now() where id in (${alice.id}, ${brenda.id}, ${charlie.id})`;

    // Man attempting women_only traveler filter gets 403
    const manFilterRes = await charlie.api('GET', '/travelers?lat=18.9218&lng=72.8347&women_only=true');
    expect(manFilterRes.statusCode).toBe(403);

    // Woman requesting women_only filter succeeds and only receives women
    const womanFilterRes = await brenda.api('GET', '/travelers?lat=18.9218&lng=72.8347&women_only=true');
    expect(womanFilterRes.statusCode).toBe(200);
    const travelers = womanFilterRes.json().travelers;
    expect(travelers.length).toBeGreaterThan(0);
    expect(travelers.some((t: any) => t.id === charlie.id)).toBe(false);
  });

  it('restricts women-only city chats to women travelers', async () => {
    // Man cannot join women-only city chat
    const manChatRes = await charlie.api('POST', '/chats/city-here', {
      lat: 18.9218,
      lng: 72.8347,
      womenOnly: true
    });
    expect(manChatRes.statusCode).toBe(403);

    // Woman can join women-only city chat
    const womanChatRes = await brenda.api('POST', '/chats/city-here', {
      lat: 18.9218,
      lng: 72.8347,
      womenOnly: true
    });
    expect(womanChatRes.statusCode).toBe(200);
    const { chatId } = womanChatRes.json();
    expect(chatId).toBeTruthy();

    // Man attempting to fetch messages in women-only chat gets forbidden
    const manMsgRes = await charlie.api('GET', `/chats/${chatId}/messages`);
    expect(manMsgRes.statusCode).toBe(403);

    // Woman can fetch messages
    const womanMsgRes = await brenda.api('GET', `/chats/${chatId}/messages`);
    expect(womanMsgRes.statusCode).toBe(200);
  });
});
