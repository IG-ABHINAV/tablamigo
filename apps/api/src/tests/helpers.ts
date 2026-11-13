// Shared by src/tests/integration: sign in through the real routes with the review code and call the app as that person.
// Each file still sets REVIEW_EMAILS / REVIEW_CODE itself before importing server.ts (config.ts reads them once, at import).
import { expect } from 'vitest';
import type { Response } from 'light-my-request';

type App = { inject: (o: any) => Promise<Response> };
export type Api = (method: string, url: string, payload?: unknown) => Promise<Response>;
export type Person = { call: Api; id: string; token: string; refreshToken: string; email: string; ip: string };

let n = 0;
/** A fresh client address per sign-in: /auth/email/start allows 5 per IP per 10 minutes. */
export const freshIp = (block: number) => `10.${block}.${Math.floor(++n / 250) % 250}.${(n % 250) + 1}`;

export async function signIn(app: App, email: string, code: string, ipBlock: number): Promise<Person> {
  const remoteAddress = freshIp(ipBlock);
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code }, remoteAddress });
  expect(r.statusCode, `sign in ${email}: ${r.body}`).toBe(200);
  const { accessToken: token, refreshToken } = r.json();
  const call: Api = (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` }, remoteAddress });
  const me = await call('GET', '/me');
  return { call, id: me.json().id, token, refreshToken, email, ip: remoteAddress };
}

export type Profile = { name: string; gender: 'woman' | 'man' | 'nonbinary'; birthdate?: string; homeCountry?: string; interests?: string[] };
export async function onboard(p: Person, profile: Profile, at?: { lat: number; lng: number }) {
  const r = await p.call('PATCH', '/me', { birthdate: '1993-04-05', homeCountry: 'IN', interests: ['food'], ...profile });
  expect(r.statusCode, `onboard ${p.email}: ${r.body}`).toBe(200);
  if (at) expect((await p.call('POST', '/me/location', at)).statusCode).toBe(200);
  return p;
}

export const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
export const BKK = { lat: 13.7466, lng: 100.5346 };

export async function createPlan(host: Person, over: Record<string, unknown> = {}) {
  const r = await host.call('POST', '/activities', { title: 'Test plan', emoji: '🍜', category: 'food', placeName: 'Yaowarat Road', lat: BKK.lat, lng: BKK.lng, startsAt: inHours(4), ...over });
  expect(r.statusCode, `create plan: ${r.body}`).toBe(200);
  return r.json() as { id: string; chatId: string; [k: string]: any };
}
