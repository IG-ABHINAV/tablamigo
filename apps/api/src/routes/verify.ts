import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/db.js';
import { config } from '../lib/config.js';
import { requireUser } from '../lib/auth.js';
import { presignImage, fileUrl } from '../lib/storage.js';
import { bad, notFound, HttpError } from '../lib/errors.js';
import { requireAdmin } from '../lib/admin.js';
import { addNotice } from '../lib/inbox.js';
import { POSES, LEGACY_POSES, REASON_TEXT, DAILY_TRIES, triesUsed, enqueue, notify, type Reason } from '../lib/verification.js';

// Selfies go under avatar/<uid>/ so deleteUserFiles removes them with the account.
const ownKey = (uid: string, key: string) => {
  const k = key.startsWith(config.r2.prefix) ? key.slice(config.r2.prefix.length) : key;
  return new RegExp(`^avatar/${uid}/[0-9a-f]{16}\\.(jpg|png|webp)$`).test(k);
};

const ownDocKey = (uid: string, key: string) => {
  const k = key.startsWith(config.r2.prefix) ? key.slice(config.r2.prefix.length) : key;
  return new RegExp(`^(id_doc|avatar)/${uid}/[0-9a-f]{16}\\.(jpg|png|webp)$`).test(k);
};

const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];

// Tier 2 (government ID) is switched off: the document images would sit on the public, CDN-cached media domain while
// the app called it private storage, Aadhaar was accepted unmasked, and there is no admin screen to review them.
const idVerificationOff = () => {
  if (!config.features.idVerification) throw new HttpError(404, 'id_verification_unavailable', 'Government ID verification is not available.');
};

export default async function verify(app: FastifyInstance) {
  // Two-tier verification status: Tier 1 (Selfie match) + Tier 2 (Government ID verification)
  app.get('/verify', async req => {
    const uid = await requireUser(req);
    const { v } = z.object({ v: z.coerce.number().optional() }).parse(req.query);
    const [u] = await sql`
      select u.verified, u.id_verified as "idVerified", u.id_verification_status as "idVerificationStatus",
        r.status as selfie_status, r.reason as selfie_reason,
        ir.status as id_status, ir.rejection_reason as id_reason, ir.document_type as id_type,
        ir.document_country as id_country, ir.created_at as id_created_at
      from users u
      left join lateral (select status, reason from verification_requests where user_id = u.id order by created_at desc limit 1) r on true
      left join lateral (select status, rejection_reason, document_type, document_country, created_at from id_verification_requests where user_id = u.id order by created_at desc limit 1) ir on true
      where u.id = ${uid}`;
    const used = await triesUsed(uid);
    return {
      verified: !!u?.verified,
      status: u?.selfieStatus ?? null,
      reason: u?.selfieStatus === 'rejected' ? u?.selfieReason ?? null : null,
      reasonText: u?.selfieStatus === 'rejected' && u?.selfieReason ? REASON_TEXT[u?.selfieReason as Reason] ?? null : null,
      triesLeft: Math.max(0, DAILY_TRIES - used),
      pose: (v ?? 1) >= 2 ? pick(POSES) : pick(LEGACY_POSES),

      // Tier 2: Government ID Verification (Backlog 29). Off unless config.features.idVerification.
      idAvailable: config.features.idVerification,
      idVerified: !!u?.idVerified,
      idStatus: u?.idStatus ?? u?.idVerificationStatus ?? 'none',
      idType: u?.idType ?? null,
      idCountry: u?.idCountry ?? null,
      idRejectionReason: u?.idStatus === 'rejected' ? u?.idReason ?? null : null,
      idSubmittedAt: u?.idCreatedAt ?? null,
      verificationTier: u?.idVerified ? 'id_verified' : u?.verified ? 'selfie' : 'unverified',
    };
  });

  app.post('/verify/upload', async req => {
    const uid = await requireUser(req);
    const { contentType } = z.object({ contentType: z.enum(['image/jpeg','image/png','image/webp']) }).parse(req.body);
    const { uploadUrl, key } = await presignImage(uid, 'avatar', contentType);
    return { uploadUrl, key };
  });

  // Presign upload URL for Government ID document
  app.post('/verify/id/upload', async req => {
    const uid = await requireUser(req);
    idVerificationOff();
    const { contentType } = z.object({ contentType: z.enum(['image/jpeg','image/png','image/webp']) }).parse(req.body);
    const { uploadUrl, key } = await presignImage(uid, 'id_doc', contentType);
    return { uploadUrl, key };
  });

  // Stores the selfie request and starts the automatic check; the app polls GET /verify until it is decided (a few seconds).
  app.post('/verify', { config: { rateLimit: { max: 20, timeWindow: '1 day' } } }, async req => {
    const uid = await requireUser(req);
    const b = z.object({ key: z.string().max(200), pose: z.enum([...POSES, ...LEGACY_POSES]) }).parse(req.body);
    if (!ownKey(uid, b.key)) throw bad('bad_photo');
    const [u] = await sql`select verified, photo_url, exists(select 1 from verification_requests where user_id = ${uid} and status = 'pending') as pending from users where id = ${uid}`;
    if (u.verified) throw bad('already_verified');
    // The selfie is compared with the profile photo, so there has to be one.
    if (!u.photoUrl) throw bad('photo_needed');
    if (u.pending) throw bad('verification_pending');
    if (await triesUsed(uid) >= DAILY_TRIES) throw new HttpError(429, 'too_many_tries', `You've used your ${DAILY_TRIES} tries for today. Try again tomorrow.`);
    const [r] = await sql`insert into verification_requests (user_id, photo_key, pose) values (${uid}, ${b.key}, ${b.pose}) returning id`;
    void enqueue(r.id);
    return { status: 'pending', id: r.id };
  });

  // Tier 2: Submit Government ID document for verification (Backlog 29)
  app.post('/verify/id', { config: { rateLimit: { max: 10, timeWindow: '1 day' } } }, async req => {
    const uid = await requireUser(req);
    idVerificationOff();
    const b = z.object({
      key: z.string().max(200),
      documentType: z.enum(['passport', 'national_id', 'drivers_license', 'aadhaar']),
      documentCountry: z.string().trim().length(2).toUpperCase(),
    }).parse(req.body);

    if (!ownDocKey(uid, b.key)) throw bad('bad_document_photo', 'Invalid document upload key.');

    const [u] = await sql`
      select verified, id_verified as "idVerified", id_verification_status as "idVerificationStatus",
        exists(select 1 from id_verification_requests where user_id = ${uid} and status = 'pending') as pending
      from users where id = ${uid}`;

    if (!u) throw notFound('user_not_found');
    if (!u.verified) {
      throw bad('selfie_required', 'Please complete selfie verification first before verifying your government ID.');
    }
    if (u.idVerified) {
      throw bad('already_id_verified', 'Your government ID has already been verified.');
    }
    if (u.pending || u.idVerificationStatus === 'pending') {
      throw bad('id_verification_pending', 'Your government ID is currently under review.');
    }

    const [reqRow] = await sql`
      insert into id_verification_requests (user_id, document_type, document_country, document_photo_key, status)
      values (${uid}, ${b.documentType}, ${b.documentCountry}, ${b.key}, 'pending')
      returning id, status, document_type as "documentType", document_country as "documentCountry", created_at as "createdAt"`;

    await sql`update users set id_verification_status = 'pending' where id = ${uid}`;
    await sql`insert into analytics_events (user_id, event_name, properties)
      values (${uid}, 'id_verification_submitted', ${sql.json({ documentType: b.documentType, country: b.documentCountry } as any)})`.catch(() => {});

    return { ok: true, status: 'pending', id: reqRow.id };
  });

  // Admin list of government ID verification submissions
  app.get('/admin/id-verifications', async req => {
    await requireAdmin(req);
    const { status } = z.object({ status: z.enum(['all', 'pending', 'approved', 'rejected']).default('all') }).parse(req.query);
    const rows = await sql`
      select r.id, r.user_id, r.document_type as "documentType", r.document_country as "documentCountry",
        r.document_photo_key as "documentPhotoKey", r.status, r.rejection_reason as "rejectionReason",
        r.created_at as "createdAt", r.reviewed_at as "reviewedAt",
        u.name, u.email, u.photo_url as "photoUrl", u.verified, u.id_verified as "idVerified",
        reviewer.email as "reviewedByEmail"
      from id_verification_requests r
      join users u on u.id = r.user_id
      left join users reviewer on reviewer.id = r.reviewed_by
      where u.deleted_at is null ${status === 'all' ? sql`` : sql`and r.status = ${status}`}
      order by r.created_at desc limit 200`;

    const [stats] = await sql`
      select count(*) filter (where status = 'approved')::int as approved,
        count(*) filter (where status = 'rejected')::int as rejected,
        count(*) filter (where status = 'pending')::int as pending
      from id_verification_requests`;

    return {
      requests: rows.map(r => ({ ...r, documentUrl: fileUrl(r.documentPhotoKey) })),
      stats: stats ?? { approved: 0, rejected: 0, pending: 0 }
    };
  });

  // Admin decision: approve government ID verification
  app.post('/admin/id-verifications/:id/approve', async req => {
    const admin = await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [r] = await sql`update id_verification_requests
      set status = 'approved', rejection_reason = null, reviewed_by = ${admin}, reviewed_at = now(), updated_at = now()
      where id = ${id} returning user_id, document_type`;
    if (!r) throw notFound('request_not_found');

    await sql`update users set id_verified = true, id_verification_status = 'approved' where id = ${r.userId}`;
    await addNotice([r.userId], {
      kind: 'id_verification_approved',
      actorId: admin,
      body: () => 'Your Government ID has been verified! 🛡️ You now display the Gold ID Verified Badge.'
    });

    return { ok: true, status: 'approved' };
  });

  // Admin decision: reject government ID verification
  app.post('/admin/id-verifications/:id/reject', async req => {
    const admin = await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().min(1).max(200) }).parse(req.body);
    const [r] = await sql`update id_verification_requests
      set status = 'rejected', rejection_reason = ${reason}, reviewed_by = ${admin}, reviewed_at = now(), updated_at = now()
      where id = ${id} returning user_id`;
    if (!r) throw notFound('request_not_found');

    await sql`update users set id_verified = false, id_verification_status = 'rejected' where id = ${r.userId}`;
    await addNotice([r.userId], {
      kind: 'id_verification_rejected',
      actorId: admin,
      body: () => `Your Government ID verification was not approved: ${reason}`
    });

    return { ok: true, status: 'rejected' };
  });

  // Read-only log of automatic outcomes with their scores. Nothing here needs an admin; the buttons only override.
  app.get('/admin/verifications', async req => {
    await requireAdmin(req);
    const { status } = z.object({ status: z.enum(['all', 'pending', 'approved', 'rejected']).default('all') }).parse(req.query);
    const rows = await sql`select r.id, r.user_id, r.photo_key, r.pose, r.status, r.reason, r.scores, r.created_at, r.checked_at, r.reviewed_at,
        reviewer.email as reviewed_by_email, u.name, u.email, u.photo_url, u.verified, u.created_at as joined_at
      from verification_requests r join users u on u.id = r.user_id left join users reviewer on reviewer.id = r.reviewed_by
      where u.deleted_at is null ${status === 'all' ? sql`` : sql`and r.status = ${status}`}
      order by r.created_at desc limit 200`;
    const [c] = await sql`select count(*) filter (where status = 'approved')::int as approved, count(*) filter (where status = 'rejected')::int as rejected,
        count(*) filter (where status = 'pending')::int as pending, count(*)::int as submitted
      from verification_requests where created_at > now() - interval '7 days'`;
    // The "verify your profile" nudges sent in the same week, so a 0 here reads as "nobody sent a selfie", not as a broken count.
    const [n] = await sql`select count(*)::int as nudges from email_log
      where kind like 'activation_verify%' and status = 'sent' and sent_at > now() - interval '7 days'`;
    c.nudges = n.nudges;
    return { requests: rows.map(({ photoKey, ...r }) => ({ ...r, selfieUrl: fileUrl(photoKey) })), last7Days: c };
  });

  // Override: approve a rejected (or still pending) selfie, or reject one, which also takes the tick away.
  for (const [action, status] of [['approve', 'approved'], ['reject', 'rejected']] as const) {
    app.post(`/admin/verifications/:id/${action}`, async req => {
      const admin = await requireAdmin(req);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const userId = await sql.begin(async tx => {
        const [r] = await tx`update verification_requests set status = ${status}, reason = ${status === 'approved' ? null : 'admin'},
            reviewed_by = ${admin}, reviewed_at = now()
          where id = ${id} and status <> ${status} returning user_id`;
        if (!r) throw notFound();
        // Only the latest request decides the tick, so overriding an old one can't undo a newer outcome.
        const [latest] = await tx`select id from verification_requests where user_id = ${r.userId} order by created_at desc limit 1`;
        if (latest.id === id) await tx`update users set verified = ${status === 'approved'} where id = ${r.userId}`;
        return r.userId as string;
      });
      await notify(userId, id, status === 'approved', null);
      return { ok: true, status };
    });
  }
}

