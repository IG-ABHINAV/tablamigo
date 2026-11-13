// Automatic selfie verification: the face checks on fixture photos, then the whole flow through the API
// (upload, async check, poll, outcome, email, retry limit, admin override). Fixtures are public-domain
// photos from Wikimedia Commons; see src/test-fixtures/faces/sources.json.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
process.env.REVIEW_EMAILS = 'vera@verify.tablamigo,walt@verify.tablamigo,xena@verify.tablamigo,yuri@verify.tablamigo';
process.env.REVIEW_CODE = '424242';
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { checkSelfie, THRESHOLDS } = await import('./lib/verification.js');
const { modelsPresent } = await import('./lib/face.js');
const { stopFaceWorker } = await import('./lib/verification.js');
const { config } = await import('./lib/config.js');
const eventually = async <T>(fn: () => Promise<T>, ok: (v: T) => boolean) => {
  let v = await fn();
  for (let i = 0; i < 50 && !ok(v); i++) { await new Promise(r => setTimeout(r, 100)); v = await fn(); }
  return v;
};

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-fixtures/faces');
const img = (f: string) => fs.readFileSync(path.join(DIR, f));
const profile = img('profile.jpg');
const noFace = await sharp({ create: { width: 480, height: 360, channels: 3, background: '#87a96b' }, })
  .composite([{ input: Buffer.from('<svg width="480" height="360"><rect y="220" width="480" height="140" fill="#6b4f2a"/><circle cx="380" cy="70" r="40" fill="#f5d76e"/></svg>'), top: 0, left: 0 }])
  .jpeg().toBuffer();

let app: Awaited<ReturnType<typeof build>>;
beforeAll(async () => {
  if (!modelsPresent()) throw new Error('face models missing: run `npm run models` in apps/api');
  app = await build();
  await sql`delete from users where email like '%@verify.tablamigo'`;
});
afterAll(async () => {
  await sql`delete from users where email like '%@verify.tablamigo'`;
  await app.close(); await sql.end(); stopFaceWorker();
});

describe('face checks', () => {
  it('same person in the asked pose passes', async () => {
    const r = await checkSelfie(profile, img('same-person-turned.jpg'), 'turn_head');
    expect(r.reason).toBeNull();
    expect(r.pass).toBe(true);
    expect(r.scores.similarity).toBeGreaterThanOrEqual(THRESHOLDS.match);
    expect(r.scores.similarity).toBeLessThan(THRESHOLDS.nearCopy);
    expect(Math.abs(r.scores.yaw!)).toBeGreaterThanOrEqual(THRESHOLDS.turn);
  });

  it('a different person fails', async () => {
    const r = await checkSelfie(profile, img('other-person-turned.jpg'), 'turn_head');
    expect([r.pass, r.reason]).toEqual([false, 'no_match']);
    expect(r.scores.similarity).toBeLessThan(THRESHOLDS.match);
  });

  it('no face fails', async () => {
    const r = await checkSelfie(profile, noFace, 'turn_head');
    expect([r.pass, r.reason, r.scores.selfieFaces]).toEqual([false, 'no_face', 0]);
  });

  it('two faces fail', async () => {
    const r = await checkSelfie(profile, img('two-faces.jpg'), 'turn_head');
    expect([r.pass, r.reason]).toEqual([false, 'several_faces']);
    expect(r.scores.selfieFaces).toBe(2);
  });

  it('the profile photo resubmitted fails, as is or re-saved smaller', async () => {
    const same = await checkSelfie(profile, profile, 'turn_head');
    expect([same.pass, same.reason]).toEqual([false, 'same_photo']);
    const resaved = await sharp(profile).resize(360).jpeg({ quality: 60 }).toBuffer();
    const r = await checkSelfie(profile, resaved, 'look_up');
    expect([r.pass, r.reason]).toEqual([false, 'same_photo']);
  });

  it('the same person without the asked pose fails; an old-app hand pose is face-matched only', async () => {
    const frontal = img('same-person-frontal.jpg');
    expect((await checkSelfie(profile, frontal, 'turn_head')).reason).toBe('wrong_pose');
    expect((await checkSelfie(profile, frontal, 'look_up')).reason).toBe('wrong_pose');
    const legacy = await checkSelfie(profile, frontal, 'thumbs_up');
    expect([legacy.pass, legacy.scores.poseChecked]).toEqual([true, false]);
  });

  it('a profile photo with no usable face fails with its own reason', async () => {
    expect((await checkSelfie(noFace, img('same-person-turned.jpg'), 'turn_head')).reason).toBe('profile_photo');
    expect((await checkSelfie(img('two-faces.jpg'), img('same-person-turned.jpg'), 'turn_head')).reason).toBe('profile_photo');
  });
});

describe('verification flow', () => {
  async function login(email: string) {
    await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress: '10.9.0.1' });
    const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress: '10.9.0.1' });
    const tok = r.json().accessToken as string;
    const id = (await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${tok}` } })).json().id as string;
    const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` } });
    return { id, call };
  }
  type U = Awaited<ReturnType<typeof login>>;
  const upload = async (u: U, body: Buffer) => {
    const p = (await u.call('POST', '/verify/upload', { contentType: 'image/jpeg' })).json();
    await app.inject({ method: 'PUT', url: new URL(p.uploadUrl).pathname, payload: body, headers: { 'content-type': 'image/jpeg' } });
    return p.key as string;
  };
  const setProfile = async (u: U, body: Buffer) => {
    const key = await upload(u, body);
    await u.call('PATCH', '/me', { photoUrl: `${config.publicUrl}/dev-files/${key}` });
  };
  const decided = async (u: U) => {
    for (let i = 0; i < 100; i++) {
      const v = (await u.call('GET', '/verify?v=2')).json();
      if (v.status !== 'pending') return v;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('verification still pending after 10 s');
  };

  it('approves a matching selfie on its own, with the email, and shows scores to admins', async () => {
    const vera = await login('vera@verify.tablamigo');
    const start = (await vera.call('GET', '/verify?v=2')).json();
    expect(['turn_head', 'look_up']).toContain(start.pose);
    expect(start.triesLeft).toBe(5);
    expect(['two_fingers', 'touch_ear', 'thumbs_up']).toContain((await vera.call('GET', '/verify')).json().pose);
    await setProfile(vera, profile);

    const t0 = Date.now();
    const r = (await vera.call('POST', '/verify', { key: await upload(vera, img('same-person-turned.jpg')), pose: 'turn_head' })).json();
    expect(r.status).toBe('pending');
    const v = await decided(vera);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(v).toMatchObject({ verified: true, status: 'approved', reason: null });
    expect((await vera.call('GET', '/me')).json()).toMatchObject({ verified: true, verification: 'approved' });
    expect((await sql`select kind from notifications where user_id = ${vera.id}`).map(n => n.kind)).toContain('verified');
    const mail = () => sql`select 1 from email_log where user_id = ${vera.id} and kind = 'verification_approved' and ref = ${r.id}`;
    expect(await eventually(mail, rows => rows.length > 0)).toHaveLength(1);
    expect(await sql`select reviewed_by from verification_requests where id = ${r.id}`).toEqual([{ reviewedBy: null }]);

    await sql`update users set role = 'admin' where id = ${vera.id}`;
    const log = (await vera.call('GET', '/admin/verifications')).json();
    const row = log.requests.find((x: any) => x.id === r.id);
    expect(row).toMatchObject({ status: 'approved', reason: null, pose: 'turn_head' });
    expect(row.scores.similarity).toBeGreaterThanOrEqual(THRESHOLDS.match);
    expect(row.scores.ms).toBeGreaterThan(0);
    expect(log.last7Days.approved).toBeGreaterThanOrEqual(1);
  });

  it('rejects a stranger with a reason, allows 5 tries a day, and an admin can override', async () => {
    const walt = await login('walt@verify.tablamigo');
    await setProfile(walt, profile);
    const r = (await walt.call('POST', '/verify', { key: await upload(walt, img('other-person-turned.jpg')), pose: 'turn_head' })).json();
    const v = await decided(walt);
    expect(v).toMatchObject({ verified: false, status: 'rejected', reason: 'no_match', triesLeft: 4 });
    const [notice] = await eventually(
      () => sql`select body from notifications where user_id = ${walt.id} and kind = 'verify_rejected'`,
      rows => rows.length > 0
    );
    expect(notice.body).toMatch(/didn't match your profile photo/);
    const mail = () => sql`select meta from email_log where user_id = ${walt.id} and kind = 'verification_rejected' and ref = ${r.id}`;
    expect(await eventually(mail, rows => rows.length > 0)).toEqual([{ meta: { reason: 'no_match' } }]);

    // four more tries (rejected for no face), then the sixth of the day is refused
    for (let i = 0; i < 4; i++) {
      expect((await walt.call('POST', '/verify', { key: await upload(walt, noFace), pose: 'look_up' })).json().status).toBe('pending');
      expect((await decided(walt)).reason).toBe('no_face');
    }
    const sixth = await walt.call('POST', '/verify', { key: await upload(walt, img('same-person-turned.jpg')), pose: 'turn_head' });
    expect([sixth.statusCode, sixth.json().error]).toEqual([429, 'too_many_tries']);
    expect((await walt.call('GET', '/verify?v=2')).json().triesLeft).toBe(0);
    // a check that failed on our side gives the try back
    await sql`update verification_requests set reason = 'check_failed' where id = (select id from verification_requests where user_id = ${walt.id} order by created_at desc limit 1)`;
    expect((await walt.call('GET', '/verify?v=2')).json().triesLeft).toBe(1);

    // override: an admin approves the stranger rejection by hand (not needed normally, but available)
    const xena = await login('xena@verify.tablamigo');
    expect((await xena.call('POST', `/admin/verifications/${r.id}/approve`)).statusCode).toBe(403);
    await sql`update users set role = 'admin' where id = ${xena.id}`;
    // an old request doesn't set the tick while a newer one says otherwise
    expect((await xena.call('POST', `/admin/verifications/${r.id}/approve`)).json().status).toBe('approved');
    expect((await walt.call('GET', '/me')).json().verified).toBe(false);
    const [latest] = await sql`select id from verification_requests where user_id = ${walt.id} order by created_at desc limit 1`;
    expect((await xena.call('POST', `/admin/verifications/${latest.id}/approve`)).json().status).toBe('approved');
    expect((await walt.call('GET', '/me')).json().verified).toBe(true);
    expect((await xena.call('POST', `/admin/verifications/${latest.id}/approve`)).statusCode).toBe(404);
    expect((await xena.call('POST', `/admin/verifications/${latest.id}/reject`)).json().status).toBe('rejected');
    expect((await walt.call('GET', '/me')).json().verified).toBe(false);
    expect(await sql`select reason from verification_requests where id = ${latest.id}`).toEqual([{ reason: 'admin' }]);
  });

  it('resubmitting the profile photo is rejected as the same photo', async () => {
    const yuri = await login('yuri@verify.tablamigo');
    await setProfile(yuri, profile);
    await yuri.call('POST', '/verify', { key: await upload(yuri, profile), pose: 'turn_head' });
    expect(await decided(yuri)).toMatchObject({ verified: false, status: 'rejected', reason: 'same_photo' });
  });
});
