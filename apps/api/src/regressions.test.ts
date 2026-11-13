// Bugs found by the end-to-end run (src/scripts/e2e-scenarios.ts), one test each.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
process.env.REVIEW_EMAILS = ['ann', 'bo', 'cy', 'di', 'boss'].map(n => `${n}@reg.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';
process.env.ADMIN_EMAILS = 'boss@reg.tablamigo';
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
const BKK = { lat: 13.7466, lng: 100.5346 };
const iso = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
const ids: string[] = [];

let ip = 0;
async function client(name: string, gender = 'woman') {
  const email = `${name}@reg.tablamigo`, remoteAddress = `10.55.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const tok = (await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress })).json().accessToken;
  const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` } });
  await call('PATCH', '/me', { name: name[0].toUpperCase() + name.slice(1), birthdate: '1992-02-02', gender, homeCountry: 'nz' });
  await sql`insert into geo_cache (cell, city, country) values ('13.75,100.55', 'Bangkok', 'TH') on conflict (cell) do nothing`;
  await call('POST', '/me/location', BKK);
  const [u] = await sql`select id from users where email = ${email}`;
  ids.push(u.id);
  return Object.assign(call, { id: u.id as string });
}
const plan = (host: Awaited<ReturnType<typeof client>>, title: string) =>
  host('POST', '/activities', { title, category: 'food', placeName: 'Soi 38', ...BKK, startsAt: new Date(Date.now() + 5 * 3600_000).toISOString() }).then(r => r.json());
const cancelNotices = async (u: Awaited<ReturnType<typeof client>>, activityId: string) =>
  (await u('GET', '/inbox')).json().notifications.filter((n: any) => n.kind === 'cancelled' && n.activityId === activityId);

const clean = async () => {
  const old = (await sql`select id from users where email like '%@reg.tablamigo'`).map(r => r.id);
  await sql`delete from messages where sender_id = any(${[...old, ...ids]}::uuid[])`;
  await sql`delete from users where id = any(${[...old, ...ids]}::uuid[])`;
  await sql`delete from otp_codes where email like '%@reg.tablamigo'`;
};
beforeAll(async () => { app = await build(); await clean(); });
afterAll(async () => { await clean(); await app.close(); await sql.end(); });

describe('regressions', () => {
  it('cancelling a plan twice does not repeat the notice or the chat message', async () => {
    const ann = await client('ann'), bo = await client('bo');
    const p = await plan(ann, 'Reg double cancel');
    await bo('POST', `/activities/${p.id}/join`);
    expect((await ann('POST', `/activities/${p.id}/cancel`)).statusCode).toBe(200);
    expect((await ann('POST', `/activities/${p.id}/cancel`)).statusCode).toBe(200);
    expect(await cancelNotices(bo, p.id)).toHaveLength(1);
    const sys = (await bo('GET', `/chats/${p.chatId}/messages`)).json().messages.filter((m: any) => m.body === 'The host cancelled this plan.');
    expect(sys).toHaveLength(1);
    expect((await bo('POST', `/activities/${p.id}/cancel`)).statusCode).toBe(403);   // still host-only
  });

  it('a block hides messages both ways in a shared chat', async () => {
    const ann = await client('ann'), bo = await client('bo');
    const p = await plan(ann, 'Reg block chat');
    await bo('POST', `/activities/${p.id}/join`);
    await bo('POST', `/blocks/${ann.id}`);                       // Bo blocks Ann; Ann did nothing
    await ann('POST', `/chats/${p.chatId}/messages`, { body: 'from ann' });
    await bo('POST', `/chats/${p.chatId}/messages`, { body: 'from bo' });
    const bodies = async (u: typeof ann) => (await u('GET', `/chats/${p.chatId}/messages`)).json().messages.map((m: any) => m.body);
    expect(await bodies(bo)).not.toContain('from ann');
    expect(await bodies(ann)).not.toContain('from bo');        // was visible: the filter only looked at the viewer's own blocks
    await bo('DELETE', `/blocks/${ann.id}`);
  });

  it("a banned user's profile is not found, like a deleted one", async () => {
    const ann = await client('ann'), cy = await client('cy', 'man');
    expect((await ann('GET', `/users/${cy.id}`)).statusCode).toBe(200);
    await sql`update users set banned_at = now() where id = ${cy.id}`;
    const r = await ann('GET', `/users/${cy.id}`);
    expect(r.json().error).toBe('not_found');
    await sql`update users set banned_at = null where id = ${cy.id}`;
  });

  it('the trip list count and faces leave out banned and blocked travelers', async () => {
    const ann = await client('ann'), bo = await client('bo'), cy = await client('cy', 'man');
    const trip = { city: 'Regtown', countryCode: 'NZ', startDate: iso(3), endDate: iso(9) };
    const mine = (await ann('POST', '/trips', trip)).json();
    await bo('POST', '/trips', trip); await cy('POST', '/trips', trip);
    const row = async () => (await ann('GET', '/trips')).json().trips.find((t: any) => t.id === mine.id);
    expect((await row()).overlapCount).toBe(2);
    await sql`update users set banned_at = now() where id = ${cy.id}`;
    await ann('POST', `/blocks/${bo.id}`);
    const r = await row();
    expect(r.overlapCount).toBe(0);
    expect(r.overlapFaces).toEqual([]);
    await sql`update users set banned_at = null where id = ${cy.id}`;
    await ann('DELETE', `/blocks/${bo.id}`);
  });

  it('members are told when a plan ends because its host deleted the account or was banned', async () => {
    const ann = await client('ann'), di = await client('di'), bo = await client('bo');
    const byDi = await plan(di, 'Reg deleted host');
    const byBo = await plan(bo, 'Reg banned host');
    await ann('POST', `/activities/${byDi.id}/join`); await ann('POST', `/activities/${byBo.id}/join`);
    expect((await di('DELETE', '/me')).statusCode).toBe(200);
    expect((await cancelNotices(ann, byDi.id)).map((n: any) => n.body)).toEqual(['Reg deleted host was cancelled: the host left Tablamigo']);
    const boss = await client('boss');
    expect((await boss('POST', `/admin/users/${bo.id}/ban`)).statusCode).toBe(200);
    expect((await cancelNotices(ann, byBo.id)).map((n: any) => n.body)).toEqual(['Reg banned host was removed by the Tablamigo team']);
    const msgs = (await ann('GET', `/chats/${byBo.chatId}/messages`)).json().messages.map((m: any) => m.body);
    expect(msgs).toContain('This plan was removed by the Tablamigo team.');
  });
});
