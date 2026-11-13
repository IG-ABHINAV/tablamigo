import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/db.js';
import { requireUser } from '../lib/auth.js';
import { isPlus } from '../lib/plus.js';

// Hide rows whose actor has since been deleted, banned or blocked (either way), so the badge matches the list.
const visible = (uid: string) => sql`n.user_id = ${uid} and (u.id is null or (u.deleted_at is null and u.banned_at is null))
  and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = n.actor_id) or (b.blocker_id = n.actor_id and b.blocked_id = ${uid}))`;

export default async function inbox(app: FastifyInstance) {
  // Latest 100. Profile views stay anonymous for free accounts, same rule as /me/viewers.
  app.get('/inbox', async req => {
    const uid = await requireUser(req);
    const rows = await sql`select n.id, n.kind, n.body, n.created_at, n.read_at, n.activity_id, n.chat_id,
        n.actor_id, u.name as actor_name, u.photo_url as actor_photo_url, a.title as activity_title
      from notifications n left join users u on u.id = n.actor_id left join activities a on a.id = n.activity_id
      where ${visible(uid)}
      order by n.created_at desc limit 100`;
    const plus = await isPlus(uid);
    return { notifications: rows.map(r => r.kind === 'profile_view' && !plus
      ? { ...r, actorId: null, actorName: null, actorPhotoUrl: null, body: 'Someone viewed your profile', locked: true }
      : { ...r, locked: false }) };
  });

  app.get('/inbox/unread', async req => {
    const uid = await requireUser(req);
    const [{ count }] = await sql`select count(*)::int as count from notifications n left join users u on u.id = n.actor_id
      where ${visible(uid)} and n.read_at is null`;
    return { count };
  });

  // Everything, or just `ids` when given.
  app.post('/inbox/read', async req => {
    const uid = await requireUser(req);
    const { ids } = z.object({ ids: z.array(z.string().uuid()).max(200).optional() }).parse(req.body ?? {});
    await sql`update notifications set read_at = now() where user_id = ${uid} and read_at is null
      and (${!ids} or id = any(${ids ?? []}::uuid[]))`;
    return { ok: true };
  });
}
