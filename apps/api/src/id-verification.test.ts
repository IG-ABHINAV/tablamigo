import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['id_user', 'id_admin'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@idtier.tablamigo`).join(',');
process.env.REVIEW_CODE = '777777';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { config } = await import('./lib/config.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 2300;
const tokens: Record<string, string> = {};
const tokenOf = async (name: string) => tokens[name];
async function login(name: string): Promise<Api> {
  const email = `${name}@idtier.tablamigo`;
  const remoteAddress = `10.99.13.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '777777' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  tokens[name] = `Bearer ${tok}`;
  const call: Api = (method, url, payload) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}` },
    remoteAddress
  });
  await call('PATCH', '/me', { name, birthdate: '1997-07-07', gender: 'woman', homeCountry: 'IN' });
  return call;
}

const u: Record<string, Api> = {};
let userId: string;

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@idtier.tablamigo'`;
  u.id_user = await login('id_user');
  u.id_admin = await login('id_admin');

  // Promote id_admin to role = 'admin'
  await sql`update users set role = 'admin' where email = 'id_admin@idtier.tablamigo'`;
  const me = (await u.id_user('GET', '/me')).json();
  userId = me.id;
});

afterAll(async () => {
  await sql`delete from users where email like '%@idtier.tablamigo'`;
  await app.close();
});

describe('Tier 2 government ID is switched off by default (FEATURE_ID_VERIFICATION)', () => {
  it('exploit: no ID document can be uploaded or submitted, by any route', async () => {
    expect(config.features.idVerification).toBe(false);
    await sql`update users set verified = true where id = ${userId}`;
    const off = (r: Awaited<ReturnType<Api>>) => { expect(r.statusCode).toBe(404); expect(r.json().error).toBe('id_verification_unavailable'); };
    off(await u.id_user('POST', '/verify/id/upload', { contentType: 'image/jpeg' }));
    off(await u.id_user('POST', '/uploads/image', { kind: 'id_doc', contentType: 'image/jpeg' }));
    off(await app.inject({ method: 'POST', url: '/uploads/image/direct?kind=id_doc', payload: Buffer.from('fake-id'),
      headers: { 'content-type': 'image/jpeg', authorization: (await tokenOf('id_user')) } }));
    off(await u.id_user('POST', '/verify/id', { key: `id_doc/${userId}/1122334455667788.jpg`, documentType: 'aadhaar', documentCountry: 'IN' }));
    expect((await sql`select count(*)::int as n from id_verification_requests where user_id = ${userId}`)[0].n).toBe(0);
    const v = (await u.id_user('GET', '/verify')).json();
    expect(v.idAvailable).toBe(false);
    expect(v.idStatus).toBe('none');
    // Avatars and chat photos still upload.
    expect((await u.id_user('POST', '/uploads/image', { kind: 'avatar', contentType: 'image/jpeg' })).statusCode).toBe(200);
    await sql`update users set verified = false where id = ${userId}`;
  });
});

// The code behind the flag still works, for when it's turned back on (after the storage and review fixes it needs).
describe('Backlog 29: Two-Tier Identity Verification System (Selfie + Government ID), switched on', () => {
  beforeAll(() => { config.features.idVerification = true; });
  afterAll(() => { config.features.idVerification = false; });
  it('GET /verify returns initial tier state as unverified', async () => {
    const res = await u.id_user('GET', '/verify');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verified).toBe(false);
    expect(body.idVerified).toBe(false);
    expect(body.idStatus).toBe('none');
    expect(body.verificationTier).toBe('unverified');
  });

  it('rejects government ID submission if selfie verification is not yet completed', async () => {
    const res = await u.id_user('POST', '/verify/id', {
      key: `id_doc/${userId}/1122334455667788.jpg`,
      documentType: 'passport',
      documentCountry: 'IN',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('selfie_required');
  });

  it('completes Tier 1 selfie verification and updates verificationTier to selfie', async () => {
    // Simulate approved selfie verification
    await sql`update users set verified = true where id = ${userId}`;
    const res = await u.id_user('GET', '/verify');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verified).toBe(true);
    expect(body.idVerified).toBe(false);
    expect(body.verificationTier).toBe('selfie');
  });

  it('generates a presigned upload URL for government ID documents', async () => {
    const res = await u.id_user('POST', '/verify/id/upload', {
      contentType: 'image/jpeg',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.uploadUrl).toBeTruthy();
    expect(body.key).toMatch(new RegExp(`^id_doc/${userId}/`));
  });

  let submittedReqId: string;

  it('submits a passport document for government ID verification', async () => {
    const docKey = `id_doc/${userId}/aabbccddeeff0011.jpg`;
    const res = await u.id_user('POST', '/verify/id', {
      key: docKey,
      documentType: 'passport',
      documentCountry: 'IN',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('pending');
    expect(body.id).toBeTruthy();
    submittedReqId = body.id;

    // Verify GET /verify now reflects pending ID status
    const statusRes = await u.id_user('GET', '/verify');
    expect(statusRes.json().idStatus).toBe('pending');
    expect(statusRes.json().idType).toBe('passport');
  });

  it('blocks duplicate submission while an ID verification is pending', async () => {
    const res = await u.id_user('POST', '/verify/id', {
      key: `id_doc/${userId}/aabbccddeeff0022.jpg`,
      documentType: 'drivers_license',
      documentCountry: 'IN',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('id_verification_pending');
  });

  it('admin views pending ID verification requests and rejects with reason', async () => {
    const listRes = await u.id_admin('GET', '/admin/id-verifications?status=pending');
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json();
    expect(list.requests.length).toBeGreaterThan(0);
    const target = list.requests.find((r: any) => r.id === submittedReqId);
    expect(target).toBeTruthy();
    expect(target.documentType).toBe('passport');
    expect(target.documentCountry).toBe('IN');

    // Reject with a reason
    const rejectRes = await u.id_admin('POST', `/admin/id-verifications/${submittedReqId}/reject`, {
      reason: 'Passport photo details are blurry. Please upload a clear, glare-free picture.',
    });
    expect(rejectRes.statusCode).toBe(200);

    // Verify user status is now rejected with reason
    const verifyState = await u.id_user('GET', '/verify');
    expect(verifyState.json().idStatus).toBe('rejected');
    expect(verifyState.json().idRejectionReason).toContain('blurry');
    expect(verifyState.json().idVerified).toBe(false);
  });

  it('user resubmits a national ID document and admin approves it', async () => {
    const newDocKey = `id_doc/${userId}/aabbccddeeff0033.jpg`;
    const res = await u.id_user('POST', '/verify/id', {
      key: newDocKey,
      documentType: 'national_id',
      documentCountry: 'IN',
    });
    expect(res.statusCode).toBe(200);
    const newReqId = res.json().id;

    // Admin approves the resubmission
    const approveRes = await u.id_admin('POST', `/admin/id-verifications/${newReqId}/approve`, {});
    expect(approveRes.statusCode).toBe(200);

    // User is now Tier 2 ID Verified
    const verifyState = await u.id_user('GET', '/verify');
    expect(verifyState.json().idVerified).toBe(true);
    expect(verifyState.json().idStatus).toBe('approved');
    expect(verifyState.json().verificationTier).toBe('id_verified');

    // GET /users/:id exposes idVerified and verificationTier
    const userProfile = await u.id_user('GET', `/users/${userId}`);
    expect(userProfile.statusCode).toBe(200);
    expect(userProfile.json().idVerified).toBe(true);
    expect(userProfile.json().verificationTier).toBe('id_verified');

    // Attempting to submit another ID when already verified throws error
    const dupRes = await u.id_user('POST', '/verify/id', {
      key: `id_doc/${userId}/aabbccddeeff0044.jpg`,
      documentType: 'passport',
      documentCountry: 'IN',
    });
    expect(dupRes.statusCode).toBe(400);
    expect(dupRes.json().error).toBe('already_id_verified');
  });
});
