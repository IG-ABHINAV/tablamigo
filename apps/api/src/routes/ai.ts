import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser, impersonatorOf } from '../lib/auth.js';
import { config } from '../lib/config.js';
import { limitsFor } from '../lib/plus.js';
import { sql } from '../lib/db.js';
import { placeNear } from '../lib/geo.js';
import { needsPlus, bad } from '../lib/errors.js';

type Idea = { emoji: string; title: string; category: string; placeName: string; why: string; lat?: number; lng?: number };
const CATEGORIES = ['food', 'drinks', 'nightlife', 'explore', 'outdoors', 'culture', 'sports', 'work', 'other'];
const today = () => new Date().toISOString().slice(0, 10);
/** Today's uses (UTC day), from the database (migration 062): parallel calls and restarts used to get past an in-memory count. */
const usedToday = async (uid: string) =>
  ((await sql`select used from ai_usage where user_id = ${uid} and day = ${today()}::date`)[0]?.used as number | undefined) ?? 0;
/** Claims one use if the allowance has room, in one statement, so parallel calls can't all pass. Null when it's used up. */
async function claimUse(uid: string, limit: number): Promise<number | null> {
  const [r] = await sql`insert into ai_usage (user_id, day, used) values (${uid}, ${today()}::date, 1)
    on conflict (user_id, day) do update set used = ai_usage.used + 1 where ai_usage.used < ${limit}
    returning used`;
  return r ? (r.used as number) : null;
}
const giveBack = (uid: string) => sql`update ai_usage set used = greatest(used - 1, 0) where user_id = ${uid} and day = ${today()}::date`.catch(() => {});

export default async function ai(app: FastifyInstance) {
  // What's left of today's suggestions, so the app can skip fetching (and never show a paywall) once they're used up.
  app.get('/ai/quota', async req => {
    const uid = await requireUser(req);
    const limit = (await limitsFor(uid)).aiSuggestionsPerDay;
    const used = await usedToday(uid);
    return { limit, used, remaining: Math.max(0, limit - used) };
  });

  // "What should we do tonight?" — activity ideas for where the user is.
  app.get('/ai/suggest', async req => {
    const uid = await requireUser(req);
    const { city, vibe, lat, lng } = z.object({
      city: z.string().max(80), vibe: z.string().max(80).optional(),
      // Where the user is looking: each idea is then pinned where its place really is, if OpenStreetMap finds it nearby.
      lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional(),
    }).parse(req.query);
    const lim = await limitsFor(uid);
    const day = today();
    // The map asks with a position and no vibe each time it opens: today's ideas for that city come back as they were, free.
    const mapAsk = lat != null && lng != null && !vibe;
    const cityKey = city.trim().toLowerCase();
    if (mapAsk) {
      const [hit] = await sql`select ideas from ai_idea_cache where user_id = ${uid} and day = ${day}::date and city = ${cityKey}`;
      if (hit) return { ideas: hit.ideas, remaining: Math.max(0, lim.aiSuggestionsPerDay - (await usedToday(uid))), cached: true };
    }
    // An admin looking at the account (lib/auth.ts) never spends one of the person's ideas: today's cached ones above, or none.
    // The map asks on its own whenever few plans are near, so opening a quiet map used to cost the user 1 of their 3.
    if (impersonatorOf(req)) return { ideas: [], remaining: Math.max(0, lim.aiSuggestionsPerDay - (await usedToday(uid))), impersonating: true };
    if ((await usedToday(uid)) >= lim.aiSuggestionsPerDay) throw needsPlus('ai_suggestions');
    if (!config.openaiKey) throw bad('ai_not_configured');
    const n = await claimUse(uid, lim.aiSuggestionsPerDay);
    if (n == null) throw needsPlus('ai_suggestions');
    try {
      const out = await suggest(uid, city, vibe, lat, lng);
      if (mapAsk) {
        await sql`delete from ai_idea_cache where user_id = ${uid} and day < ${day}::date`.catch(() => {});
        await sql`insert into ai_idea_cache (user_id, day, city, ideas) values (${uid}, ${day}::date, ${cityKey}, ${sql.json(out as any)})
          on conflict (user_id, day, city) do nothing`.catch(() => {});
      }
      await sql`delete from ai_usage where user_id = ${uid} and day < ${day}::date`.catch(() => {});
      return { ideas: out, remaining: Math.max(0, lim.aiSuggestionsPerDay - n) };
    } catch (e) {
      await giveBack(uid);   // a failed call doesn't use up one of today's ideas
      throw e;
    }
  });
}

async function suggest(uid: string, city: string, vibe: string | undefined, lat: number | undefined, lng: number | undefined): Promise<Idea[]> {
  const [me] = await sql`select interests from users where id = ${uid}`;
  const prompt = `Suggest 5 specific group activities a solo traveler could host tonight or tomorrow in ${city}${vibe ? `, vibe: ${vibe}` : ''}. Interests: ${(me?.interests ?? []).join(', ') || 'anything'}.
Return JSON {"ideas":[{"emoji":"","title":"(max 60 chars, e.g. Sunset drinks at X)","category":"exactly one of: ${CATEGORIES.join(', ')}","placeName":"real, well-known venue or area","why":"one short line"}]}. Only real, well-known public places.`;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${config.openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }], temperature: 0.8 }),
  });
  if (!r.ok) throw bad('ai_failed');
  // A reply that isn't the JSON asked for (an apology in prose, a cut-off object) is ai_failed like an OpenAI error, and the
  // caller gives the idea back; it used to be a 500 "Something went wrong on our side".
  let raw: any[];
  try {
    const j: any = await r.json();
    const ideas = JSON.parse(j?.choices?.[0]?.message?.content ?? '')?.ideas;
    if (!Array.isArray(ideas)) throw new Error('no ideas array');
    raw = ideas;
  } catch {
    throw bad('ai_failed');
  }
  // The model sometimes returns "food|explore" or overlong titles; the app posts these straight to /activities.
  const ideas: Idea[] = raw.filter(i => i?.title && i?.placeName).slice(0, 5).map(i => ({
    emoji: String(i.emoji || '✨').slice(0, 4),
    title: String(i.title).slice(0, 80),
    category: CATEGORIES.find(c => String(i.category ?? '').toLowerCase().split(/[|,/ ]/).includes(c)) ?? 'other',
    placeName: String(i.placeName).slice(0, 120),
    why: String(i.why ?? '').slice(0, 140),
  }));
  // A list with no usable idea (each one missing its title or place) is no answer either: ai_failed, and the idea goes back.
  if (!ideas.length) throw bad('ai_failed');
  // Coordinates only from a real geocoder hit near the user; an idea it can't place stays off the map.
  if (lat != null && lng != null) await Promise.all(ideas.map(async i => { const p = await placeNear(i.placeName, lat, lng); if (p) Object.assign(i, p); }));
  return ideas;
}
