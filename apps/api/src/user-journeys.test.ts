// Bugs real people hit in their first sessions (user-journey review, 22 Oct 2026), one describe per bug.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const PEOPLE = ['uj_ada', 'uj_bea', 'uj_cal', 'uj_dev', 'uj_eli', 'uj_fay', 'uj_gus', 'uj_hal', 'uj_ivy', 'uj_boss', 'uj_jan', 'uj_kim', 'uj_r1', 'uj_r2', 'uj_r3', 'uj_r4'];
const DOMAIN = 'uj.tablamigo';
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@${DOMAIN}`).join(',');
process.env.REVIEW_CODE = '424242';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { setMailTransport } = await import('./lib/mail.js');
const { cityFor, placeName, cleanPlaceName } = await import('./lib/geo.js');
const { config } = await import('./lib/config.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = ((method: string, url: string, payload?: unknown) => Promise<Awaited<ReturnType<typeof app.inject>>>) & { id: string; token: string };

let ip = 0;
async function login(name: string, profile: Record<string, unknown> = {}): Promise<Api> {
  const email = `${name}@${DOMAIN}`, remoteAddress = `10.122.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const token = r.json().accessToken as string;
  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` }, remoteAddress });
  await call('PATCH', '/me', { name: name.slice(3), birthdate: '1994-04-04', gender: 'woman', homeCountry: 'TR', ...profile });
  const [u] = await sql`select id from users where email = ${email}`;
  return Object.assign(call, { id: u.id as string, token });
}

const cell = (city: string, country: string, at: string) =>
  sql`insert into geo_cache (cell, city, country) values (${at}, ${city}, ${country}) on conflict (cell) do update set city = excluded.city, country = excluded.country, cached_at = now()`;
const clean = async () => {
  const ids = (await sql`select id from users where email like ${'%@' + DOMAIN}`).map(r => r.id);
  await sql`delete from users where id = any(${ids}::uuid[])`;
  await sql`delete from otp_codes where email like ${'%@' + DOMAIN}`;
  await sql`delete from email_log where to_email like ${'%@' + DOMAIN}`;
  await sql`delete from chats where kind = 'city' and city_key in ('ujville-tf', 'ujville-tf:women')`;
};

beforeAll(async () => {
  app = await build();
  await clean();
  await cell('Istanbul', 'TR', '41,28.95'); await cell('Istanbul', 'TR', '41,29');
  await cell('Bangkok', 'TH', '13.75,100.55');
});
afterAll(async () => { await clean(); await app.close(); await sql.end(); });

describe('no location never means Bangkok', () => {
  it('"the chat where I am" without a point uses the place the server last saw me', async () => {
    const ada = await login('uj_ada');
    await ada('POST', '/me/location', { lat: 41.0082, lng: 28.9784 });
    const r = await ada('POST', '/chats/city-here', {});
    expect(r.statusCode).toBe(200);
    expect(r.json().city).toBe('Istanbul');
    expect((await sql`select city_key from chats where id = ${r.json().chatId}`)[0].cityKey).toBe('istanbul-tr');
  });

  it("the old app's Bangkok stand-in point is not taken as where someone is", async () => {
    const bea = await login('uj_bea');
    // Never shared a location: refused, not dropped into the Bangkok chat.
    const none = await bea('POST', '/chats/city-here', { lat: 13.7466, lng: 100.5346 });
    expect(none.statusCode).toBe(400);
    expect(none.json().error).toBe('city_unknown');
    expect((await sql`select count(*)::int as n from chat_members m join chats c on c.id = m.chat_id where m.user_id = ${bea.id} and c.kind = 'city'`)[0].n).toBe(0);
    // With a saved place, that place's chat.
    await bea('POST', '/me/location', { lat: 41.01, lng: 28.97 });
    const saved = await bea('POST', '/chats/city-here', { lat: 13.7466, lng: 100.5346 });
    expect(saved.json().city).toBe('Istanbul');
  });

  it('a real point near the stand-in point is still taken as it is', async () => {
    // Its own made-up place, so this test never touches the real Bangkok chat other test files count members of.
    await cell('Ujville', 'TF', '13.75,100.5');
    const cal = await login('uj_cal');
    const r = await cal('POST', '/chats/city-here', { lat: 13.7468, lng: 100.5101 });
    expect(r.statusCode).toBe(200);
    expect(r.json().city).toBe('Ujville');
  });
});

describe('the trip city chat says when it opens, before anyone taps', () => {
  const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
  it('a free trip a week out shows the opening day, and the tap agrees with it', async () => {
    const dev = await login('uj_dev');
    const far = (await dev('POST', '/trips', { city: 'Istanbul', countryCode: 'TR', startDate: day(7), endDate: day(12) })).json();
    const near = (await dev('POST', '/trips', { city: 'Istanbul', countryCode: 'TR', startDate: day(2), endDate: day(4) })).json();
    const list = (await dev('GET', '/trips')).json().trips as any[];
    const opens = (id: string) => list.find(t => t.id === id).cityChatOpensOn;
    // 3 days before arrival for a free account (lib/plus.ts LIMITS.free.cityChatDaysAhead).
    expect(opens(far.id)).toBe(day(4));
    expect(opens(near.id)).toBeNull();
    expect((await dev('POST', `/trips/${far.id}/city-chat`, {})).statusCode).toBe(402);
    expect((await dev('POST', `/trips/${near.id}/city-chat`, {})).statusCode).toBe(200);
  });

  it('Plus sees every trip city chat as open', async () => {
    const eli = await login('uj_eli');
    await sql`update users set plus_until = now() + interval '30 days' where id = ${eli.id}`;
    const t = (await eli('POST', '/trips', { city: 'Istanbul', countryCode: 'TR', startDate: day(30), endDate: day(35) })).json();
    expect((await eli('GET', '/trips')).json().trips.find((x: any) => x.id === t.id).cityChatOpensOn).toBeNull();
    expect((await eli('POST', `/trips/${t.id}/city-chat`, {})).statusCode).toBe(200);
  });
});

describe('an empty area shows the nearest plans and travelers further out', () => {
  // A remote spot nobody else's tests use: Kerguelen. The plan is ~165 km east, the traveler ~78 km east.
  const ME = { lat: -49.35, lng: 70.22 }, PLAN = { lat: -49.35, lng: 72.5 }, OTHER = { lat: -49.35, lng: 71.3 };
  beforeAll(async () => { for (const c of ['-49.35,70.2', '-49.35,72.5', '-49.35,71.3']) await cell('Port-aux-Français', 'TF', c); });

  it('plans: nothing within 25 km gives the nearest ones within the next radius that has any', async () => {
    const gus = await login('uj_gus'), hal = await login('uj_hal');
    await gus('POST', '/me/location', ME);
    const p = await hal('POST', '/activities', { title: 'Kerguelen walk', category: 'outdoors', placeName: 'Baie', ...PLAN, startsAt: new Date(Date.now() + 26 * 3600_000).toISOString() });
    expect(p.statusCode).toBe(200);
    const r = (await gus('GET', `/activities?lat=${ME.lat}&lng=${ME.lng}`)).json();
    expect(r.activities).toEqual([]);
    expect(r.wider.radiusKm).toBe(500);
    expect(r.wider.activities.map((a: any) => a.id)).toEqual([p.json().id]);
    expect(r.wider.activities[0].distanceM).toBeGreaterThan(150_000);
    // A filter that matched nothing is the person's own choice: no wider list then.
    expect((await gus('GET', `/activities?lat=${ME.lat}&lng=${ME.lng}&category=food`)).json().wider).toBeUndefined();
    expect((await gus('GET', `/activities?lat=${ME.lat}&lng=${ME.lng}&when=today`)).json().wider).toBeUndefined();
  });

  it('travelers: nobody within 30 km gives the nearest ones, with coarse distances', async () => {
    const gus = await login('uj_gus'), ivy = await login('uj_ivy');
    await gus('POST', '/me/location', ME);
    await ivy('POST', '/me/location', OTHER);
    const r = (await gus('GET', `/travelers?lat=${ME.lat}&lng=${ME.lng}`)).json();
    expect(r.count).toBe(0);
    expect(r.travelers).toEqual([]);
    expect(r.wider.radiusKm).toBe(100);
    const t = r.wider.travelers.find((x: any) => x.id === ivy.id);
    expect(t.distanceM % 5000).toBe(0);
    expect(t.distanceM).toBeGreaterThan(50_000);
    expect((await gus('GET', `/travelers?lat=${ME.lat}&lng=${ME.lng}&min_age=18&max_age=99`)).json().wider).toBeUndefined();
  });
});

describe('admin "Login as user" is read-only and short-lived', () => {
  it('gives a 15-minute token with no refresh token, and nothing the app does with it changes the account', async () => {
    const boss = await login('uj_boss'), jan = await login('uj_jan'), kim = await login('uj_kim');
    await sql`update users set role = 'admin' where id = ${boss.id}`;
    await jan('POST', '/me/location', { lat: 41.0082, lng: 28.9784 });
    await sql`update users set last_seen_at = now() - interval '2 days' where id = ${jan.id}`;
    const before = (await sql`select ST_AsText(location) as loc, city, last_seen_at from users where id = ${jan.id}`)[0];

    const r = await boss('POST', `/admin/users/${jan.id}/impersonate`, {});
    expect(r.statusCode).toBe(200);
    const imp = r.json();
    expect(imp.refreshToken).toBeUndefined();
    expect(imp.readOnly).toBe(true);
    expect(imp.expiresIn).toBe(15 * 60);
    const as = (method: string, url: string, payload?: unknown) =>
      app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${imp.accessToken}` } });

    // Reads work.
    expect((await as('GET', '/me')).json().id).toBe(jan.id);
    // What the app does by itself on open answers ok and writes nothing.
    expect((await as('POST', '/me/location', { lat: 32.27, lng: 75.65 })).json()).toEqual({ city: 'Istanbul' });
    const sub = JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/uj-admin-browser', keys: { p256dh: 'x'.repeat(40), auth: 'y'.repeat(16) } });
    expect((await as('POST', '/me/push-token', { token: sub, platform: 'web' })).statusCode).toBe(200);
    expect((await as('POST', '/analytics/events', { event: 'paywall_viewed', properties: { surface: 'web' } })).statusCode).toBe(200);
    expect((await as('POST', '/inbox/read', {})).statusCode).toBe(200);
    expect((await as('GET', `/users/${kim.id}`)).statusCode).toBe(200);
    // The map asks for AI ideas on its own when few plans are near: under impersonation that spends none of Jan's.
    const savedKey = config.openaiKey; config.openaiKey = 'sk-test';
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ideas: [{ emoji: '☕', title: 'Coffee', category: 'food', placeName: 'Old Town', why: 'x' }] }) } }] })));
    try {
      const ideas = await as('GET', '/ai/suggest?city=Istanbul&lat=41.0&lng=29.0');
      expect(ideas.statusCode).toBe(200);
      expect(ideas.json()).toMatchObject({ ideas: [], impersonating: true });
      expect((await as('GET', '/ai/suggest?city=Istanbul&vibe=chill')).json().ideas).toEqual([]);
      // Ideas Jan already got today for this city are shown as they are.
      await sql`insert into ai_idea_cache (user_id, day, city, ideas) values (${jan.id}, ${new Date().toISOString().slice(0, 10)}::date, 'ankara', ${sql.json([{ emoji: '🍵', title: 'Tea', category: 'food', placeName: 'Ulus', why: 'x' }] as any)})`;
      const cached = (await as('GET', '/ai/suggest?city=Ankara&lat=39.9&lng=32.8')).json();
      expect(cached).toMatchObject({ cached: true });
      expect(cached.ideas[0].title).toBe('Tea');
      expect(f.mock.calls.filter(([u]) => String(typeof u === 'string' ? u : (u as any).url).includes('api.openai.com'))).toHaveLength(0);
    } finally { f.mockRestore(); config.openaiKey = savedKey; }
    expect((await sql`select count(*)::int as n from ai_usage where user_id = ${jan.id}`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from ai_idea_cache where user_id = ${jan.id}`)[0].n).toBe(1);   // only the one put there above
    // The invite screen: Jan has no code yet, and an admin's look doesn't make one (it used to write referral_code).
    const ref = await as('GET', '/me/referral');
    expect(ref.statusCode).toBe(200);
    expect(ref.json()).toMatchObject({ referralCode: null, referralLink: null });
    expect((await sql`select referral_code from users where id = ${jan.id}`)[0].referralCode).toBeNull();
    // Anything else that writes is refused.
    const patch = await as('PATCH', '/me', { bio: 'written by an admin' });
    expect(patch.statusCode).toBe(403);
    expect(patch.json().error).toBe('impersonation_read_only');
    expect((await as('POST', '/trips', { city: 'Istanbul', countryCode: 'TR', startDate: '2027-01-01', endDate: '2027-01-02' })).statusCode).toBe(403);

    const after = (await sql`select ST_AsText(location) as loc, city, last_seen_at, bio from users where id = ${jan.id}`)[0];
    expect(after.loc).toBe(before.loc);
    expect(after.city).toBe(before.city);
    expect(after.lastSeenAt.getTime()).toBe(before.lastSeenAt.getTime());
    expect(after.bio).toBeNull();
    expect((await sql`select count(*)::int as n from push_tokens where user_id = ${jan.id}`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from analytics_events where user_id = ${jan.id} and event_name = 'paywall_viewed'`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from profile_views where viewer_id = ${jan.id}`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from notifications where user_id = ${kim.id} and kind = 'profile_view'`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from refresh_tokens where user_id = ${jan.id}`)[0].n).toBe(1);   // only Jan's own sign-in

    // Jan's own session is untouched and still writes.
    expect((await jan('PATCH', '/me', { bio: 'mine' })).statusCode).toBe(200);
    const own = (await jan('GET', '/me/referral')).json();
    expect(own.referralCode).toMatch(/^[A-Z0-9]{4,10}$/);
    expect((await sql`select referral_code from users where id = ${jan.id}`)[0].referralCode).toBe(own.referralCode);
    expect((await as('GET', '/me/referral')).json().referralCode).toBe(own.referralCode);   // once made, the admin sees it
    expect((await jan('GET', `/users/${kim.id}`)).statusCode).toBe(200);
    expect((await sql`select count(*)::int as n from profile_views where viewer_id = ${jan.id}`)[0].n).toBe(1);
  });
});

describe('sign-in codes: a new one does not kill the earlier one, and a double tap sends one', () => {
  it('a second request within 30 s sends nothing; a later new code leaves the earlier email\'s code working; sends are logged without the code', async () => {
    const sent: { to: string; subject: string }[] = [];
    setMailTransport(async m => { sent.push(m); return { id: `uj-${sent.length}` }; });
    try {
      const email = 'otp_lia@uj.tablamigo', remoteAddress = '10.122.9.1';
      const start = () => app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
      expect((await start()).json()).toEqual({ ok: true, resent: true, resendIn: 30 });
      const again = (await start()).json();
      expect(again.resent).toBe(false);
      expect(again.resendIn).toBeGreaterThan(0);
      expect(sent).toHaveLength(1);
      expect((await sql`select sent_count from otp_codes where email = ${email}`)[0].sentCount).toBe(1);

      await sql`update otp_codes set last_sent_at = now() - interval '31 seconds' where email = ${email}`;
      expect((await start()).json().resent).toBe(true);
      expect(sent).toHaveLength(2);
      const [first, second] = sent.map(m => /^(\d{6}) /.exec(m.subject)![1]);
      const verify = (code: string) => app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code }, remoteAddress });
      expect((await verify(first === '000000' ? '111111' : '000000')).json().error).toBe('wrong_code');
      // The code from the first email still signs in, although a newer one was sent.
      expect((await verify(first)).statusCode).toBe(200);
      expect(second).toMatch(/^\d{6}$/);

      const logs = await sql`select status, provider_id, subject from email_log where kind = 'login_code' and to_email = ${email} order by id`;
      expect(logs.map(l => [l.status, l.providerId])).toEqual([['sent', 'uj-1'], ['sent', 'uj-2']]);
      for (const l of logs) { expect(l.subject).not.toContain(first); expect(l.subject).not.toContain(second); }
    } finally { setMailTransport(null); }
  });

  it('an expired earlier code is refused; the latest one works', async () => {
    const sent: { subject: string }[] = [];
    setMailTransport(async m => { sent.push(m); return { id: 'x' }; });
    try {
      const email = 'otp_max@uj.tablamigo', remoteAddress = '10.122.9.2';
      const start = () => app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
      await start();
      await sql`update otp_codes set last_sent_at = now() - interval '1 minute' where email = ${email}`;
      await start();
      await sql`update otp_codes set prev_expires_at = now() - interval '1 second' where email = ${email}`;
      const [first, second] = sent.map(m => /^(\d{6}) /.exec(m.subject)![1]);
      const verify = (code: string) => app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code }, remoteAddress });
      if (first !== second) expect((await verify(first)).json().error).toBe('wrong_code');
      expect((await verify(second)).statusCode).toBe(200);
    } finally { setMailTransport(null); }
  });

  it('requests in the same instant (keyboard Go and the button) send one code, and that code signs in', async () => {
    const sent: { subject: string }[] = [];
    setMailTransport(async m => { sent.push(m); return { id: 'x' }; });
    try {
      const email = 'otp_ned@uj.tablamigo', remoteAddress = '10.122.9.3';
      const start = () => app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
      const answers = (await Promise.all([start(), start(), start()])).map(r => r.json());
      expect(answers.every(a => a.ok)).toBe(true);
      expect(answers.filter(a => a.resent === true)).toHaveLength(1);
      expect(sent).toHaveLength(1);
      expect((await sql`select sent_count from otp_codes where email = ${email}`)[0].sentCount).toBe(1);
      const code = /^(\d{6}) /.exec(sent[0].subject)![1];
      expect((await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code }, remoteAddress })).statusCode).toBe(200);
    } finally { setMailTransport(null); }
  });

  it('the write itself refuses a second code within the cooldown (two requests that both got past the first check)', async () => {
    const { writeLoginCode, sha256 } = await import('./lib/auth.js');
    const email = 'otp_pia@uj.tablamigo';
    expect(await writeLoginCode(email, '111111')).toBe(true);
    expect(await writeLoginCode(email, '222222')).toBe(false);
    const [row] = await sql`select code_hash, prev_code_hash, sent_count from otp_codes where email = ${email}`;
    expect(row.codeHash).toBe(sha256('111111'));
    expect(row.prevCodeHash).toBeNull();
    expect(row.sentCount).toBe(1);
    // After the cooldown a new code is stored and the first one is kept as the previous code.
    await sql`update otp_codes set last_sent_at = now() - interval '31 seconds' where email = ${email}`;
    expect(await writeLoginCode(email, '222222')).toBe(true);
    expect((await sql`select prev_code_hash from otp_codes where email = ${email}`)[0].prevCodeHash).toBe(sha256('111111'));
  });

  it('a logged sign-in code does not hold back the activation emails', async () => {
    const { activationCandidates } = await import('./lib/emails/activation.js');
    const sent: { subject: string }[] = [];
    setMailTransport(async m => { sent.push(m); return { id: 'x' }; });
    try {
      const email = 'otp_ora@uj.tablamigo', remoteAddress = '10.122.9.4';
      const start = () => app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
      await start();
      const code = /^(\d{6}) /.exec(sent[0].subject)![1];
      const { accessToken } = (await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code }, remoteAddress })).json();
      await app.inject({ method: 'PATCH', url: '/me', payload: { name: 'Ora', birthdate: '1990-01-01', gender: 'woman', homeCountry: 'TR' }, headers: { authorization: `Bearer ${accessToken}` }, remoteAddress });
      const [u] = await sql`select id from users where email = ${email}`;
      // Only the sign-in code is recent: the welcome email that onboarding sends (in the background) is moved out of the 24 hours.
      await vi.waitFor(async () => expect((await sql`select count(*)::int as n from email_log where user_id = ${u.id} and kind <> 'login_code'`)[0].n).toBeGreaterThan(0));
      await sql`update email_log set created_at = now() - interval '2 days' where user_id = ${u.id} and kind <> 'login_code'`;
      await start();   // signing in again: this send is logged with the account's id
      expect((await sql`select count(*)::int as n from email_log where kind = 'login_code' and user_id = ${u.id}`)[0].n).toBe(1);
      expect((await activationCandidates(new Date(), email))[0].recentEmail).toBe(false);
      // Any other email in the last 24 hours still holds the next one back.
      await sql`update email_log set created_at = now() where user_id = ${u.id} and kind <> 'login_code'`;
      expect((await activationCandidates(new Date(), email))[0].recentEmail).toBe(true);
    } finally { setMailTransport(null); }
  });
});

describe('place names are towns and cities, not taluks, tehsils or corporations', () => {
  it('cleans the 10 admin-area names real profiles carry', () => {
    const seen: Record<string, string> = {
      'Challakere taluku': 'Challakere', 'Kumata taluk': 'Kumata', 'Ganganagar Tehsil': 'Ganganagar', 'Jagraon Tahsil': 'Jagraon',
      'Macharla Mandal': 'Macharla', 'Jaipur Municipal Corporation': 'Jaipur', 'City of Edinburgh': 'Edinburgh',
      'City of Tshwane Metropolitan Municipality': 'Tshwane', 'Ubud District': 'Ubud',
      // A US county is a name people use; 'Clark' alone would name nothing.
      'Clark County': 'Clark County', 'Bangkok': 'Bangkok', 'Mandal': 'Mandal',
    };
    for (const [raw, want] of Object.entries(seen)) expect(cleanPlaceName(raw), raw).toBe(want);
  });

  it("picks the town from Nominatim's town-level answer (real answers, 22 Oct 2026)", () => {
    expect(placeName({ town: 'Challakere', county: 'Challakere taluku', state_district: 'Chitradurga' })).toBe('Challakere');
    expect(placeName({ town: 'Jagraon', county: 'Jagraon Tahsil' })).toBe('Jagraon');
    expect(placeName({ municipality: 'Málaga', county: 'Málaga-Costa del Sol' })).toBe('Málaga');
    expect(placeName({ village: 'Eaunes', municipality: 'Muret', county: 'Haute-Garonne' })).toBe('Eaunes');
    expect(placeName({ city: 'Jaipur Municipal Corporation', county: 'Jaipur Tehsil' })).toBe('Jaipur');
    expect(placeName({ county: 'Challakere taluku' })).toBe('Challakere');   // nothing better: the county, cleaned
    expect(placeName({})).toBeNull();
  });

  it('asks Nominatim at town level (zoom 12)', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ address: { town: 'Challakere', county: 'Challakere taluku', country_code: 'in' } })));
    vi.stubGlobal('fetch', f);
    try {
      await sql`delete from geo_cache where cell = '-48.35,77.35'`;
      expect(await cityFor(-48.35, 77.35)).toEqual({ city: 'Challakere', country: 'IN' });
      expect(String((f.mock.calls[0] as any[])[0])).toContain('zoom=12');
    } finally { vi.unstubAllGlobals(); await sql`delete from geo_cache where cell = '-48.35,77.35'`; }
  });

  it('a cached name from before the fix is looked up again', async () => {
    await sql`insert into geo_cache (cell, city, country, cached_at) values ('-48.4,77.4', 'Kumata taluk', 'IN', '2026-10-20T00:00:00Z')
      on conflict (cell) do update set city = excluded.city, country = excluded.country, cached_at = excluded.cached_at`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ address: { town: 'Kumta', county: 'Kumata taluk', country_code: 'in' } }))));
    try { expect((await cityFor(-48.4, 77.4)).city).toBe('Kumta'); }
    finally { vi.unstubAllGlobals(); await sql`delete from geo_cache where cell = '-48.4,77.4'`; }
  });

  it('"the chat where I am" in an Istanbul district is the Istanbul chat, not a district chat', async () => {
    await cell('Üsküdar', 'TR', '41.05,29.05');   // what Nominatim calls this point
    const fay = await login('uj_fay');
    const r = (await fay('POST', '/chats/city-here', { lat: 41.04, lng: 29.04 })).json();
    expect(r.city).toBe('Istanbul');
    expect((await sql`select city_key from chats where id = ${r.chatId}`)[0].cityKey).toBe('istanbul-tr');
  });

  it("the Host's welcome near a popular city keys it by that city, not by the cleaned district name the old alias no longer matches", async () => {
    // Prod: seed-founder-city-chats wrote 'city-of-westminster-gb' -> london-gb; the cleaned name is now 'Westminster'.
    await cell('City of Westminster', 'GB', '51.5,-0.15');
    const { buildWelcome } = await import('./lib/host.js');
    const { meta } = await buildWelcome({ id: '00000000-0000-0000-0000-000000000000', name: 'Ada', gender: 'woman', homeCountry: 'TR', city: null, lat: 51.5074, lng: -0.1278 });
    expect(meta.cityKey).toBe('london-gb');
    expect(meta.city).toBe('London');
  });
});

describe('no email to addresses that exist only inside Tablamigo', () => {
  it('isSendable refuses the demo, deleted and team domains only', async () => {
    const { isSendable } = await import('./lib/emails/send.js');
    for (const e of ['maya@demo.tablamigo', 'deleted-1@deleted.tablamigo', 'host@team.tablamigo', 'X@Demo.Tablamigo', '', null, 'nodomain'])
      expect(isSendable(e as any), String(e)).toBe(false);
    for (const e of ['a@gmail.com', 'b@uj.tablamigo', 'c@tablamigo.app']) expect(isSendable(e), e).toBe(true);
  });

  it('deliver() sends nothing and logs nothing for a demo account, and still sends to a real one', async () => {
    const { deliver } = await import('./lib/emails/send.js');
    const sent: string[] = [];
    setMailTransport(async m => { sent.push(m.to); return { id: 'x' }; });
    const [demo] = await sql`insert into users (email, name) values ('uj-persona@demo.tablamigo', 'Persona') returning id`;
    const real = await login('uj_ada');
    try {
      const build = () => ({ subject: 'Your week', preheader: '', category: 'transactional' as const, blocks: [{ t: 'p' as const, text: 'hi' }] });
      expect(await deliver({ kind: 'weekly_digest', userId: demo.id, periodKey: 'uj-week', build })).toBe('no_recipient');
      expect(await deliver({ kind: 'weekly_digest', userId: real.id, periodKey: 'uj-week', build })).toBe('sent');
      expect(sent).toEqual(['uj_ada@uj.tablamigo']);
      expect(await sql`select 1 from email_log where user_id = ${demo.id}`).toHaveLength(0);
    } finally {
      setMailTransport(null);
      await sql`delete from email_log where user_id in (${demo.id}, ${real.id})`;
      await sql`delete from users where id = ${demo.id}`;
    }
  });
});

describe('city keys drop accents instead of turning them into dashes', () => {
  const NAMES: [string, string, string][] = [
    ['Üsküdar', 'TR', 'uskudar-tr'], ['Medellín', 'CO', 'medellin-co'], ['Málaga', 'ES', 'malaga-es'], ['São Paulo', 'BR', 'sao-paulo-br'],
    ['Zürich', 'CH', 'zurich-ch'], ['Hà Nội', 'VN', 'ha-noi-vn'], ['Đà Nẵng', 'VN', 'da-nang-vn'], ['İstanbul', 'TR', 'istanbul-tr'],
    ['Kraków', 'PL', 'krakow-pl'], ['Łódź', 'PL', 'lodz-pl'], ['Tromsø', 'NO', 'tromso-no'], ['Straße', 'DE', 'strasse-de'],
    ['Bangkok', 'TH', 'bangkok-th'], ['New York', 'US', 'new-york-us'], ['Ho Chi Minh City', 'VN', 'ho-chi-minh-city-vn'],
  ];

  it('cityKey() and the SQL city_key_of() (migration 061) give the same plain key', async () => {
    const { cityKey, legacyCityKey } = await import('./lib/geo.js');
    for (const [city, cc, want] of NAMES) {
      expect(cityKey(city, cc), city).toBe(want);
      expect((await sql`select city_key_of(${city}, ${cc}) as k`)[0].k, `SQL ${city}`).toBe(want);
    }
    expect(legacyCityKey('Medellín', 'CO')).toBe('medelli-n-co');
    expect(legacyCityKey('Üsküdar', 'TR')).toBe('u-sku-dar-tr');
  });

  it('a city chat made under the old key is adopted, members and all; an alias made for the old key still counts', async () => {
    const { legacyCityKey } = await import('./lib/geo.js');
    const oldKey = legacyCityKey('Ujtówn', 'TF'), alias = legacyCityKey('Ujvíllé', 'TF');
    expect([oldKey, alias]).toEqual(['ujto-wn-tf', 'ujvi-lle-tf']);
    await sql`delete from chats where city_key in ('ujtown-tf', 'ujto-wn-tf', 'ujcanon-tf')`;
    await sql`delete from city_chat_aliases where alias_key = ${alias}`;
    const [old] = await sql`insert into chats (kind, city_key, title) values ('city', ${oldKey}, 'Ujtówn travelers') returning id`;
    await sql`insert into city_chat_aliases (alias_key, canonical_key) values (${alias}, 'ujcanon-tf')`;
    await cell('Ujtówn', 'TF', '-47,60'); await cell('Ujvíllé', 'TF', '-47,61');
    try {
      const hal = await login('uj_hal');
      const a = (await hal('POST', '/chats/city-here', { lat: -47, lng: 60 })).json();
      expect(a.chatId).toBe(old.id);
      expect((await sql`select city_key from chats where id = ${old.id}`)[0].cityKey).toBe('ujtown-tf');
      const b = (await hal('POST', '/chats/city-here', { lat: -47, lng: 61 })).json();
      expect((await sql`select city_key from chats where id = ${b.chatId}`)[0].cityKey).toBe('ujcanon-tf');
    } finally {
      await sql`delete from chats where city_key in ('ujtown-tf', 'ujto-wn-tf', 'ujcanon-tf')`;
      await sql`delete from city_chat_aliases where alias_key = ${alias}`;
    }
  });

  it('migration 061 re-keys trips and their circle chat, and leaves plain names alone', async () => {
    const ivy = await login('uj_ivy');
    const t1 = (await ivy('POST', '/trips', { city: 'Ujmedellín', countryCode: 'CO', startDate: '2026-12-01', endDate: '2026-12-05' })).json();
    const t2 = (await ivy('POST', '/trips', { city: 'Ujplain', countryCode: 'CO', startDate: '2026-12-01', endDate: '2026-12-05' })).json();
    expect(t1.cityKey).toBe('ujmedellin-co');
    // As the old code stored them.
    await sql`update trips set city_key = 'ujmedelli-n-co' where id = ${t1.id}`;
    const [circle] = await sql`insert into chats (kind, trip_key, title) values ('trip', 'ujmedelli-n-co:2026-12', 'Ujmedellín · Dec 2026 Circle ✈️') returning id`;
    try {
      const fs = await import('node:fs');
      await sql.unsafe(fs.readFileSync(new URL('./db/migrations/061_city_keys_without_accent_dashes.sql', import.meta.url), 'utf8'));
      expect((await sql`select city_key from trips where id = ${t1.id}`)[0].cityKey).toBe('ujmedellin-co');
      expect((await sql`select city_key from trips where id = ${t2.id}`)[0].cityKey).toBe('ujplain-co');
      expect((await sql`select trip_key from chats where id = ${circle.id}`)[0].tripKey).toBe('ujmedellin-co:2026-12');
    } finally { await sql`delete from chats where id = ${circle.id}`; }
  });
});

describe('"running late" only around the start of a plan', () => {
  it('a host right after posting a plan days out is refused; 20 minutes before it works; 2 hours after it is over', async () => {
    const jan = await login('uj_jan');
    const p = (await jan('POST', '/activities', { title: 'Uj coffee', category: 'food', placeName: 'Somewhere', lat: -48.9, lng: 69.9,
      startsAt: new Date(Date.now() + 5 * 86400_000).toISOString() })).json();
    const late = () => jan('POST', `/activities/${p.id}/running-late`, { mins: 15 });
    expect((await late()).json().error).toBe('running_late_too_early');
    await sql`update activities set starts_at = now() + interval '20 minutes' where id = ${p.id}`;
    expect((await late()).statusCode).toBe(200);
    await sql`update activities set starts_at = now() - interval '2 hours' where id = ${p.id}`;
    expect((await late()).json().error).toBe('running_late_over');
  });
});

describe('AI ideas: the free allowance holds under parallel calls, and the map does not spend it on every open', () => {
  const IDEA = { emoji: '☕', title: 'Coffee walk', category: 'food', placeName: 'Old Town', why: 'Nice' };
  // OpenAI answers after a moment, so parallel calls really overlap; Photon finds nothing.
  const fake = (ok = true) => vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (u.hostname === 'api.openai.com') {
      await new Promise(r => setTimeout(r, 150));
      return ok ? new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ideas: [IDEA] }) } }] })) : new Response('{}', { status: 500 });
    }
    return new Response(JSON.stringify({ features: [] }));
  });

  it('five parallel asks on a free account: three answered, two refused, and the count is 3', async () => {
    const kim = await login('uj_kim');
    const saved = config.openaiKey; config.openaiKey = 'sk-test';
    const f = fake();
    try {
      const rs = await Promise.all([1, 2, 3, 4, 5].map(i => kim('GET', `/ai/suggest?city=Town${i}`)));
      expect(rs.map(r => r.statusCode).sort()).toEqual([200, 200, 200, 402, 402]);
      expect((await kim('GET', '/ai/quota')).json()).toMatchObject({ used: 3, remaining: 0 });
    } finally { f.mockRestore(); config.openaiKey = saved; }
  });

  it("the map's ask for the same city again today is answered from today's ideas without spending; a failed call gives its use back", async () => {
    const bea = await login('uj_bea');
    const saved = config.openaiKey; config.openaiKey = 'sk-test';
    let f = fake();
    try {
      const first = (await bea('GET', '/ai/suggest?city=Istanbul&lat=41.0&lng=29.0')).json();
      expect(first.ideas[0].title).toBe('Coffee walk');
      const calls = f.mock.calls.length;
      const again = (await bea('GET', '/ai/suggest?city=istanbul&lat=41.01&lng=29.01')).json();
      expect(again).toMatchObject({ cached: true, remaining: 2 });
      expect(again.ideas[0].title).toBe('Coffee walk');
      expect(f.mock.calls.length).toBe(calls);   // no OpenAI call
      f.mockRestore(); f = fake(false);
      expect((await bea('GET', '/ai/suggest?city=Ankara')).statusCode).toBe(400);
      expect((await bea('GET', '/ai/quota')).json()).toMatchObject({ used: 1, remaining: 2 });
    } finally { f.mockRestore(); config.openaiKey = saved; }
  });
});

describe('analytics properties are stored as JSON objects, not JSON strings', () => {
  it('trip, plan, join, message and client events can be read with properties->>', async () => {
    const eli = await login('uj_eli'), fay = await login('uj_fay');
    const trip = (await eli('POST', '/trips', { city: 'Istanbul', countryCode: 'TR', startDate: '2026-12-10', endDate: '2026-12-12' })).json();
    const plan = (await eli('POST', '/activities', { title: 'Uj tea', category: 'food', placeName: 'Somewhere', lat: -48.8, lng: 69.8,
      startsAt: new Date(Date.now() + 3 * 3600_000).toISOString() })).json();
    await fay('POST', `/activities/${plan.id}/join`, {});
    await eli('POST', `/chats/${plan.chatId}/messages`, { body: 'see you there' });
    await eli('POST', '/analytics/events', { event: 'paywall_viewed', properties: { reason: 'city_chat' } });
    const rows = await sql`select event_name, jsonb_typeof(properties) as t, properties->>'tripId' as trip, properties->>'activityId' as plan,
        properties->>'chatId' as chat, properties->>'reason' as reason
      from analytics_events where user_id in (${eli.id}, ${fay.id}) and event_name in ('trip_created', 'plan_created', 'plan_joined', 'message_sent', 'paywall_viewed')
      order by id`;  // eli made a trip in an earlier test too: the newest of each kind is this test's
    const by = Object.fromEntries(rows.map(r => [r.eventName, r]));
    for (const r of rows) expect(r.t, r.eventName).toBe('object');
    expect(by.trip_created.trip).toBe(trip.id);
    expect(by.plan_created.plan).toBe(plan.id);
    expect(by.plan_joined.plan).toBe(plan.id);
    expect(by.message_sent.chat).toBe(plan.chatId);
    expect(by.paywall_viewed.reason).toBe('city_chat');
  });

  it('migration 064 turns the rows already stored as strings back into objects, and leaves everything else alone', async () => {
    const fs = await import('node:fs');
    const gus = await login('uj_gus');
    // Exactly what the old inserts stored: JSON.stringify(...) bound to the jsonb column.
    await sql`insert into analytics_events (user_id, event_name, properties) values (${gus.id}, 'uj_string_row', ${JSON.stringify({ reason: 'city_chat' })})`;
    await sql`insert into analytics_events (user_id, event_name, properties) values (${gus.id}, 'uj_object_row', ${sql.json({ reason: 'paywall' })})`;
    await sql`insert into analytics_events (user_id, event_name, properties) values (${gus.id}, 'uj_plain_string', ${sql.json('just text' as any)})`;
    const read = async () => Object.fromEntries((await sql`select event_name, jsonb_typeof(properties) as t, properties->>'reason' as reason
      from analytics_events where user_id = ${gus.id} and event_name like 'uj_%'`).map(r => [r.eventName, [r.t, r.reason]]));
    expect((await read()).uj_string_row).toEqual(['string', null]);
    await sql.unsafe(fs.readFileSync(new URL('./db/migrations/064_analytics_string_rows_again.sql', import.meta.url), 'utf8'));
    expect(await read()).toEqual({ uj_string_row: ['object', 'city_chat'], uj_object_row: ['object', 'paywall'], uj_plain_string: ['string', null] });
  });

  it('no route or library binds JSON.stringify(...) into SQL any more (it double-encodes into jsonb)', async () => {
    const fs = await import('node:fs'), path = await import('node:path');
    const root = new URL('./', import.meta.url).pathname;
    const files = ['routes', 'lib'].flatMap(d => fs.readdirSync(path.join(root, d), { recursive: true }).map(f => path.join(root, d, String(f)))).filter(f => f.endsWith('.ts'));
    const hits = files.flatMap(f => fs.readFileSync(f, 'utf8').split('\n').map((l, i) => [f, i + 1, l] as const))
      .filter(([, , l]) => /\$\{JSON\.stringify\(/.test(l) && !/throw new Error|console\./.test(l));
    expect(hits.map(([f, n]) => `${path.relative(root, f)}:${n}`)).toEqual([]);
  });
});

describe('Android sign-ups carry the Play install referrer', () => {
  const verify = async (email: string, extra: Record<string, unknown>) => {
    const remoteAddress = '10.122.8.' + Math.floor(Math.random() * 200 + 20);
    await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
    const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242', ...extra }, remoteAddress, headers: { 'user-agent': 'okhttp/4.12.0' } });
    expect(r.statusCode).toBe(200);
    return (await sql`select attribution from users where email = ${email}`)[0].attribution;
  };

  it("an invite install's referrer becomes the source, medium and campaign; the raw referrer is kept", async () => {
    const a = await verify('uj_r1@uj.tablamigo', { install_referrer: 'utm_source=invite&utm_medium=app&utm_campaign=oct-meta&gclid=x' });
    expect(a).toMatchObject({ source: 'invite', medium: 'app', campaign: 'oct-meta', device: 'Android', installReferrer: 'utm_source=invite&utm_medium=app&utm_campaign=oct-meta&gclid=x' });
  });

  it("Play's organic referrer still reads 'Google Play', and no referrer at all is unchanged", async () => {
    expect(await verify('uj_r2@uj.tablamigo', { install_referrer: 'utm_source=google-play&utm_medium=organic' })).toMatchObject({ source: 'Google Play', medium: 'organic' });
    expect(await verify('uj_r3@uj.tablamigo', {})).toMatchObject({ source: 'Google Play', medium: 'app', campaign: null, installReferrer: null });
  });
});

describe('a plan keeps a city when the reverse-geocode lookup fails', () => {
  const timeout = () => vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError'); }));
  it("falls back to the cell's cached name of any age, then to the host's own city nearby", async () => {
    const { cityForPlan } = await import('./lib/geo.js');
    const hal = await login('uj_hal');
    await hal('POST', '/me/location', { lat: -47.5, lng: 62 });
    await sql`update users set city = 'Ujport' where id = ${hal.id}`;
    await sql`insert into geo_cache (cell, city, country, cached_at) values ('-47.5,62.5', 'Ujbay', 'TF', '2026-09-01T00:00:00Z')
      on conflict (cell) do update set city = excluded.city, country = excluded.country, cached_at = excluded.cached_at`;
    await sql`delete from geo_cache where cell in ('-47.55,62.05', '-48.5,75')`;
    timeout();
    try {
      expect(await cityForPlan(-47.5, 62.5, hal.id)).toBe('Ujbay');      // stale cache beats nothing
      expect(await cityForPlan(-47.55, 62.05, hal.id)).toBe('Ujport');   // no cache: the host is 6 km away
      expect(await cityForPlan(-48.5, 75, hal.id)).toBeNull();           // host 1,000 km away: no guess
    } finally { vi.unstubAllGlobals(); await sql`delete from geo_cache where cell = '-47.5,62.5'`; }
  });

  it('a plan saved without a city gets it from one more lookup later', async () => {
    const { fillPlanCityLater } = await import('./lib/geo.js');
    const ivy = await login('uj_ivy');
    await sql`delete from geo_cache where cell = '-46,64'`;
    timeout();
    let p: any;
    try {
      p = (await ivy('POST', '/activities', { title: 'Uj beach', category: 'outdoors', placeName: 'La Pepica', lat: -46, lng: 64,
        startsAt: new Date(Date.now() + 26 * 3600_000).toISOString() })).json();
      expect((await sql`select city from activities where id = ${p.id}`)[0].city).toBeNull();
    } finally { vi.unstubAllGlobals(); }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ address: { city: 'Valencia', country_code: 'es' } }))));
    try { await fillPlanCityLater(p.id, -46, 64, 0); } finally { vi.unstubAllGlobals(); await sql`delete from geo_cache where cell = '-46,64'`; }
    expect((await sql`select city from activities where id = ${p.id}`)[0].city).toBe('Valencia');
  });
});

describe('deleting an account can say why, and the reason names nobody', () => {
  it('stores the one-tap reason (or none) with the account age; an unknown reason deletes anyway and is stored as other', async () => {
    const r2 = await login('uj_r2'), r3 = await login('uj_r3'), r4 = await login('uj_r4');
    await sql`update users set created_at = now() - interval '3 days' where id = ${r2.id}`;
    const before = (await sql`select coalesce(max(id), 0) as id from account_deletion_reasons`)[0].id;
    expect((await r2('DELETE', '/me', { reason: 'no_one_near' })).statusCode).toBe(200);
    expect((await r3('DELETE', '/me')).statusCode).toBe(200);
    // A newer app's code or free text: the account is deleted all the same (it used to be a 400), and the text is not kept.
    expect((await r4('DELETE', '/me', { reason: 'my email is r4@example.com' })).statusCode).toBe(200);
    expect((await sql`select deleted_at from users where id = ${r4.id}`)[0].deletedAt).not.toBeNull();
    const rows = await sql`select * from account_deletion_reasons where id > ${before} order by id`;
    expect(rows.map(r => [r.reason, r.daysSinceSignup])).toEqual([['no_one_near', 3], ['none', 0], ['other', 0]]);
    expect(Object.keys(rows[0]).sort()).toEqual(['createdAt', 'daysSinceSignup', 'id', 'reason']);
  });
});
