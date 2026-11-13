/**
 * City chats. A city chat's key is the city's cityKey ('bangkok-th', lib/geo.ts), the same key a trip carries, and the
 * women's chat adds ':women' ('bangkok-th:women'). City guide pages used to open the chat under the guide slug
 * ('bangkok'), so one city had two chats; migration 055 folded those into the canonical row and gave each guide a
 * generated chat_key. Every way into a city chat (the guide page, a trip, "where you are") goes through cityChatId.
 *
 * One city can still be reached under several keys: a trip carries the name its owner typed ('bengaluru-in'), "where you are"
 * carries what Nominatim calls the point ('suginami-jp' for Shibuya, 'city-of-westminster-gb' for Soho), a guide carries its
 * chat_key ('bangalore-in'). city_chat_aliases (migration 056) says which of those keys is the same chat as which, and
 * cityChatId follows it, so all of them open one room.
 */
import { sql } from './db.js';

/**
 * The id of the city chat for `key` (a cityKey, without ':women'), created if it doesn't exist. A chat is women-only
 * when `womenOnly`, and one that already existed under that key becomes women-only too. A key that is an alias of another
 * (city_chat_aliases) opens the canonical city's chat, and then keeps that chat's title: the caller's title is built from
 * the name it knows the city by ("Panaji travelers" for Goa), the canonical chat already has the right one. A stray row under
 * the old guide slug key (an API process from before migration 055 can still make one) is adopted instead of getting a second chat.
 */
export async function cityChatId(key: string, title: string, womenOnly: boolean, legacyKey?: string): Promise<string> {
  // legacyKey: the key the same name gave before accents were dropped instead of dashed (lib/geo.ts legacyCityKey). An alias
  // made for it ('medelli-n-co') still counts, and a chat that sits under it is adopted, members and messages included.
  const old = legacyKey && legacyKey !== key ? legacyKey : null;
  const [alias] = await sql`select canonical_key from city_chat_aliases where alias_key = any(${old ? [key, old] : [key]}::text[])
    order by alias_key = ${key} desc limit 1`;
  const canon = (alias?.canonicalKey as string | undefined) ?? key;
  const chatKey = womenOnly ? `${canon}:women` : canon;
  if (old && !alias) {
    await sql`update chats set city_key = ${chatKey} where kind = 'city' and city_key = ${womenOnly ? `${old}:women` : old}
      and not exists (select 1 from chats where city_key = ${chatKey})`;
  }
  const [guide] = await sql`select slug, city from city_guides where chat_key = ${canon}`;
  if (guide) {
    await sql`update chats set city_key = ${chatKey}
      where kind = 'city' and city_key = ${womenOnly ? `${guide.slug}:women` : guide.slug}
        and not exists (select 1 from chats where city_key = ${chatKey})`;
  }
  // A new chat reached through an alias is named after the guide when there is one, else after the caller's name for it.
  const newTitle = alias && guide ? (womenOnly ? `${guide.city} Women Nomads 🌸` : `${guide.city} travelers`) : title;
  const [c] = await sql`insert into chats (kind, city_key, title, women_only, last_message_at)
    values ('city', ${chatKey}, ${newTitle}, ${womenOnly}, now())
    on conflict (city_key) do update set title = ${alias ? sql`chats.title` : sql`excluded.title`}, women_only = chats.women_only or excluded.women_only
    returning id`;
  return c.id as string;
}

/**
 * Folds the chats that sit under `aliasKey` (the general one and the ':women' one) into the chats under `canonicalKey`, the way
 * migration 055 and 056 do: renamed when the canonical chat doesn't exist yet, otherwise its members, messages and inbox rows
 * move across and the empty shell is dropped. Returns how many chats were folded. Sockets still in a dropped chat's room hear
 * nothing more; the next app launch joins them to the canonical one.
 */
export async function foldCityChat(aliasKey: string, canonicalKey: string): Promise<number> {
  let folded = 0;
  for (const suffix of ['', ':women']) {
    const [legacy] = await sql`select id from chats where kind = 'city' and city_key = ${aliasKey + suffix}`;
    if (!legacy) continue;
    folded++;
    const [canon] = await sql`select id from chats where kind = 'city' and city_key = ${canonicalKey + suffix}`;
    if (!canon) { await sql`update chats set city_key = ${canonicalKey + suffix} where id = ${legacy.id}`; continue; }
    await sql.begin(async tx => {
      await tx`insert into chat_members (chat_id, user_id, last_read_at, muted, joined_at, last_read_message_id, request_status, request_decided_at)
        select ${canon.id}, user_id, last_read_at, muted, joined_at, last_read_message_id, request_status, request_decided_at
        from chat_members where chat_id = ${legacy.id} on conflict (chat_id, user_id) do nothing`;
      await tx`update messages set chat_id = ${canon.id} where chat_id = ${legacy.id}`;
      await tx`update notifications set chat_id = ${canon.id} where chat_id = ${legacy.id}`;
      await tx`update chats set last_message_at = greatest(last_message_at, (select last_message_at from chats where id = ${legacy.id})),
          pinned_message_id = coalesce(pinned_message_id, (select pinned_message_id from chats where id = ${legacy.id})) where id = ${canon.id}`;
      await tx`delete from chats where id = ${legacy.id}`;   // its member rows go with it
    });
  }
  return folded;
}
