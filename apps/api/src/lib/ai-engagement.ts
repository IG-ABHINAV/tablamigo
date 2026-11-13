/**
 * AI Engagement Engine for Tablamigo.
 * 
 * Ensures new real travelers (e.g. Vladi in Phuket, Blessing in South Africa, Varunraj in India)
 * receive immediate, warm, authentic interactions instead of encountering a ghost town.
 * 
 * Every 15 minutes, it checks for:
 * 1. Newly created user plans/tables with 0 joins/comments -> A matching persona joins & greets them.
 * 2. Unanswered messages in city chats -> A persona traveler replies warmly.
 */
import { sql } from './db.js';
import { HttpError } from './errors.js';
import { assertCanJoin, lockPlanForJoin } from './plans.js';

export const AI_ENGAGEMENT_LOCK = 7_424_240_002;

interface EngagementAction {
  type: 'plan_joined' | 'chat_reply';
  targetId: string;
  personaName: string;
  recipientName: string;
  message: string;
  city: string;
}

async function callOpenAI(prompt: string, fallback: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fallback;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      // The worker's run lock (and a pool connection) is held while it waits here: never wait on OpenAI for long.
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a friendly, easygoing 20-something solo traveler on Tablamigo. You speak in a natural, casual, lowercase-leaning tone like a real backpacker or nomad chatting on WhatsApp. Keep answers concise (1-2 sentences, max 25 words). Never sound like an AI assistant or PR representative. If the traveler asks to meet up right now or today, politely decline with a casual realistic excuse (e.g. booked on a day tour, exploring another part of town, or chilling at the hostel), but always ask them when they are free next or what days they are around.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.8,
        max_tokens: 80,
      }),
    });

    if (!res.ok) return fallback;
    const json = await res.json() as any;
    const text = json.choices?.[0]?.message?.content?.trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

/**
 * One pass. The outer transaction only holds the run lock (one pass at a time) and reads. Each join and each reply is its own
 * short transaction, written after its OpenAI call: until 22 Oct 2026 every write sat in the one outer transaction, so a plan the
 * worker had joined stayed row-locked through up to 9 more OpenAI calls of up to 10 s, and a person's Join, RSVP or edit on it
 * waited that long.
 */
export async function runAiEngagement(): Promise<{ ran: boolean; actions: EngagementAction[] }> {
  return sql.begin(async tx => {
    const [{ locked }] = await tx`select pg_try_advisory_xact_lock(${AI_ENGAGEMENT_LOCK}) as locked`;
    if (!locked) return { ran: false, actions: [] };

    const actions: EngagementAction[] = [];

    // 1. Unengaged real-user plans
    const unengagedPlans = await tx`
      select a.id as activity_id, a.title, a.place_name, a.category, a.city, a.host_id, a.women_only,
             u.name as host_name, u.email as host_email,
             c.id as chat_id
      from activities a
      join users u on u.id = a.host_id
      left join chats c on c.activity_id = a.id
      where a.status = 'active'
        and a.starts_at > now() - interval '4 hours'
        and u.email not like '%@demo.tablamigo'
        and u.role != 'admin'
        and a.created_at < now() - interval '2 minutes'

        and (
          select count(*)::int from activity_members m
          where m.activity_id = a.id
        ) <= 1
        and not exists (
          select 1 from activity_members m
          join users mu on mu.id = m.user_id
          where m.activity_id = a.id and mu.email like '%@demo.tablamigo'
        )
      limit 5
    `;

    for (const plan of unengagedPlans) {
      // A persona in or near the same city, or any demo traveler, who could join it the way a person could: a woman for a
      // women-only plan, no block either way with the host, not in it already. assertCanJoin below has the final word.
      const [persona] = await tx`
        select u.id, u.name, u.city from users u
        where u.email like '%@demo.tablamigo' and u.onboarded and u.banned_at is null and u.deleted_at is null
          and (not ${plan.womenOnly} or u.gender = 'woman')
          and not exists (select 1 from blocks b where (b.blocker_id = ${plan.hostId} and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = ${plan.hostId}))
          and not exists (select 1 from activity_members m where m.activity_id = ${plan.activityId} and m.user_id = u.id)
        order by (case when u.city = ${plan.city} then 0 else 1 end), random()
        limit 1
      `;

      if (!persona) continue;

      const fallbackMsg = `Hey ${plan.hostName}! Count me in, looking forward to meeting up 🙌`;
      const prompt = `A fellow traveler named ${plan.hostName} just posted a plan: "${plan.title}" in ${plan.city || 'town'} (${plan.category}). Say you'd love to join and ask a quick natural question about what time works or where to meet.`;
      const replyBody = await callOpenAI(prompt, fallbackMsg);

      // Join the way POST /activities/:id/join does: the plan row locked, then every rule a person's join passes (women-only,
      // blocks, closed, ticketed, full, over). A plan this persona may not join is left alone. Committed at once, so the lock
      // is released before the next OpenAI call.
      const joined = await sql.begin(async jtx => {
        try {
          const a = await lockPlanForJoin(jtx, plan.activityId);
          const { already, finalStatus } = await assertCanJoin(jtx, a, persona.id, { rsvp: 'going', ticketForMembers: true });
          if (already || finalStatus !== 'going') return false;
        } catch (e) {
          if (e instanceof HttpError) return false;
          throw e;
        }
        await jtx`insert into activity_members (activity_id, user_id, rsvp_status) values (${plan.activityId}, ${persona.id}, 'going') on conflict do nothing`;
        // If chat exists, join and send message
        if (plan.chatId) {
          await jtx`insert into chat_members (chat_id, user_id) values (${plan.chatId}, ${persona.id}) on conflict do nothing`;
          await jtx`insert into messages (chat_id, sender_id, kind, body) values (${plan.chatId}, ${persona.id}, 'text', ${replyBody})`;
          await jtx`update chats set last_message_at = now() where id = ${plan.chatId}`;
        }
        return true;
      });
      if (!joined) continue;

      actions.push({
        type: 'plan_joined',
        targetId: plan.activityId,
        personaName: persona.name,
        recipientName: plan.hostName,
        message: replyBody,
        city: plan.city,
      });
    }

    // 2. Unanswered messages in city chats
    const unansweredCityMsgs = await tx`
      select m.id as message_id, m.chat_id, m.body, m.sender_id, m.created_at,
             u.name as sender_name, u.city as user_city,
             c.title as chat_title, c.city_key
      from messages m
      join chats c on c.id = m.chat_id
      join users u on u.id = m.sender_id
      where c.kind = 'city'
        and u.email not like '%@demo.tablamigo'
        and u.role != 'admin'
        and m.created_at < now() - interval '2 minutes'
        and m.created_at > now() - interval '72 hours'
        and not exists (
          select 1 from messages m2
          where m2.chat_id = m.chat_id
            and m2.created_at > m.created_at
        )
      limit 5
    `;

    for (const msg of unansweredCityMsgs) {
      const chatCity = msg.chatTitle?.replace(/ travellers| travelers/i, '') || msg.userCity || 'town';
      const [persona] = await tx`
        select id, name from users
        where email like '%@demo.tablamigo'
          and id != ${msg.senderId}
        order by (case when city ilike ${'%' + chatCity + '%'} then 0 else 1 end), random()
        limit 1
      `;

      if (!persona) continue;

      const fallbackMsg = `Hey ${msg.senderName}! Welcome 👋 Are you traveling around here right now?`;
      const prompt = `In the ${chatCity} travel group chat, traveler ${msg.senderName} said: "${msg.body}". Reply warmly and casually. If they are asking to meet up right now, make a realistic casual excuse (e.g. booked on a tour / out exploring / tied up) but ask when they're free next. Otherwise ask what they're up to or if they just arrived.`;
      const replyBody = await callOpenAI(prompt, fallbackMsg);

      await sql.begin(async wtx => {
        await wtx`insert into chat_members (chat_id, user_id) values (${msg.chatId}, ${persona.id}) on conflict do nothing`;
        await wtx`insert into messages (chat_id, sender_id, kind, body) values (${msg.chatId}, ${persona.id}, 'text', ${replyBody})`;
        await wtx`update chats set last_message_at = now() where id = ${msg.chatId}`;
      });

      actions.push({
        type: 'chat_reply',
        targetId: msg.chatId,
        personaName: persona.name,
        recipientName: msg.senderName,
        message: replyBody,
        city: chatCity,
      });
    }

    return { ran: true, actions };
  });
}

let aiTimer: NodeJS.Timeout | null = null;

export function startAiEngagementWorker(): () => void {
  const tick = () => {
    runAiEngagement()
      .then(r => {
        if (r.ran && r.actions.length > 0) {
          console.log(`[AI Engagement] Performed ${r.actions.length} interaction(s):`, r.actions.map(a => `${a.personaName} -> ${a.recipientName} (${a.type})`).join(', '));
        }
      })
      .catch(err => console.error('[AI Engagement] Tick failed:', err?.message));
  };

  // Run initial pass after 10s
  const init = setTimeout(tick, 10_000);
  init.unref();

  // Run every 15 minutes
  aiTimer = setInterval(tick, 15 * 60_000);
  aiTimer.unref();

  return () => {
    if (aiTimer) clearInterval(aiTimer);
  };
}
