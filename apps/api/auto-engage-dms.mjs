import { sql } from "./dist/lib/db.js";
import { post } from "./dist/lib/chat-post.js";

async function run() {
  console.log("=== Tablamigo Auto-Engagement Runner ===");

  // Find all real users created in the last 7 days who have not received a DM from a demo persona
  const candidates = await sql`
    select u.id, u.name, u.city, u.home_country, u.created_at, u.gender
    from users u
    where u.email not like '%@demo.tablamigo'
      and u.email not like 'deleted-%'
      and u.role != 'admin'
      and u.account_kind != 'team'
      and u.deleted_at is null
      and u.banned_at is null
      and u.created_at > now() - interval '7 days'
      and not exists (
        select 1 from chat_members cm
        join chats c on c.id = cm.chat_id
        join messages m on m.chat_id = c.id
        join users sender on sender.id = m.sender_id
        where cm.user_id = u.id
          and c.kind = 'dm'
          and sender.email like '%@demo.tablamigo'
      )
    order by u.created_at desc
  `;

  console.log(`Found ${candidates.length} uncontacted real traveler(s).`);

  const personas = await sql`
    select id, name, city, email from users
    where email like '%@demo.tablamigo'
  `;

  const getPersona = (city, country) => {
    const c = (city || '').toLowerCase();
    const co = (country || '').toLowerCase();
    if (c.includes('goa') || c.includes('calangute') || c.includes('anjuna') || c.includes('panaji')) {
      return personas.find(p => p.name === 'Rohan') || personas[0];
    }
    if (c.includes('delhi') || c.includes('noida') || c.includes('gurgaon')) {
      return personas.find(p => p.name === 'Ananya') || personas[0];
    }
    if (c.includes('mumbai') || c.includes('bengaluru') || c.includes('bangalore') || co === 'in' || co === 'india') {
      return personas.find(p => p.name === 'Aarav') || personas[0];
    }
    if (co === 'pl' || co === 'poland' || c.includes('gdańsk') || c.includes('gdansk') || c.includes('warsaw') || c.includes('krakow') ||
        co === 'fr' || co === 'france' || c.includes('paris') || c.includes('versailles') ||
        co === 'nl' || co === 'netherlands' || co === 'de' || co === 'germany' || co === 'gb' || co === 'uk') {
      return personas.find(p => p.name === 'Mia') || personas.find(p => p.name === 'Lucas') || personas.find(p => p.name === 'Liam') || personas[0];
    }
    if (co === 'pe' || co === 'peru' || co === 'es' || co === 'spain' || co === 'br' || co === 'brazil') {
      return personas.find(p => p.name === 'Lucas') || personas[0];
    }
    return personas.find(p => p.name === 'Aarav') || personas[0];
  };

  const getGreeting = (name, city, country, personaName) => {
    const c = (city || '').toLowerCase();
    const co = (country || '').toLowerCase();
    const firstName = (name || 'there').trim().split(' ')[0];

    // Peer-to-peer / traveler opener (Never corporate or "Welcome to Tablamigo")
    if (c.includes('calangute') || c.includes('goa')) {
      return `Hey ${firstName}! Are you around North Goa right now? Let me know if you're up for grabbing a beer or catching a sunset!`;
    }
    if (c.includes('delhi')) {
      return `Hey ${firstName}! Are you based in Delhi or traveling around? Let me know if you're ever up for exploring some good cafes or monuments!`;
    }
    if (co === 'fr' || co === 'france' || c.includes('paris') || c.includes('versailles')) {
      return `Salut ${firstName}! Are you traveling somewhere right now or planning a trip soon?`;
    }
    if (co === 'pe' || co === 'peru' || co === 'es' || co === 'spain') {
      return `¡Hola ${firstName}! ¿Estás planeando algún viaje pronto o explorando por allá?`;
    }
    if (co === 'nl' || co === 'netherlands') {
      return `Hey ${firstName}! Planning any backpacking or weekend trips soon?`;
    }
    if (city) {
      return `Hey ${firstName}! Are you around ${city} right now or planning a trip soon?`;
    }
    return `Hey ${firstName}! What brings you here — planning any trips soon?`;
  };

  for (const user of candidates) {
    const persona = getPersona(user.city, user.home_country);
    const text = getGreeting(user.name, user.city, user.home_country, persona.name);
    const key = [persona.id, user.id].sort().join(':');

    console.log(`\n[ENGAGE] User: ${user.name} (${user.city || user.home_country || 'Unknown location'}) <- Persona: ${persona.name}`);
    console.log(`Message: "${text}"`);

    // 1. Create or get DM chat
    const [chat] = await sql`
      insert into chats (kind, dm_key, last_message_at)
      values ('dm', ${key}, now())
      on conflict (dm_key) do update set last_message_at = now()
      returning id, kind, title
    `;

    // 2. Add members
    await sql`
      insert into chat_members (chat_id, user_id, request_status)
      values (${chat.id}, ${persona.id}, 'accepted')
      on conflict (chat_id, user_id) do update set request_status = 'accepted'
    `;
    await sql`
      insert into chat_members (chat_id, user_id, request_status)
      values (${chat.id}, ${user.id}, 'pending')
      on conflict (chat_id, user_id) do nothing
    `;

    // 3. Post message with push notification and sockets
    const preview = text.slice(0, 140);
    const msg = await post(chat, persona.id, 'text', text, preview);
    console.log(`✓ Message sent (id: ${msg.id}) & push delivered to user.`);
  }

  console.log("\n=== Tablamigo Auto-Engagement Completed ===");
  await sql.end();
}

run().catch(err => {
  console.error("Runner failed:", err);
  process.exit(1);
});
