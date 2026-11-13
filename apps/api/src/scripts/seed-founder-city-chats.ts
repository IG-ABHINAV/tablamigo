/**
 * Puts the founder's real account in the city chats of the popular travel cities, with one true welcome message each, so the
 * first person to open a city chat there doesn't find an empty room. No other accounts, no plans, no counts: just him, saying
 * who he is and what the chat is for.
 *
 * Every city has one canonical chat key, written out below: the plain-name key a trip and the guide pages use (cityKey(name, cc):
 * 'jaipur-in', 'tokyo-jp'), or the guide's own chat_key for the four guide cities whose name differs ('goa-in', 'bali-id',
 * 'delhi-in', 'bangalore-in'). People also arrive under other keys: "the chat where you are" carries what Nominatim calls the GPS
 * point ('suginami-jp' for central Tokyo, 'shibuya-jp' for Shibuya). So each city lists a few points; each is resolved the way
 * POST /chats/city-here does it (lib/geo.ts cityFor, the same geo_cache, then cityKey), and a key that differs from the canonical
 * one is written to city_chat_aliases (migration 056), which cityChatId follows. A chat that already sits under such a key is
 * folded into the canonical one (lib/city-chats.ts foldCityChat, the way migrations 055 and 056 do). A point that resolves to no
 * city and country is reported and gives no alias; the city is still seeded, its key doesn't depend on the lookup.
 *
 * Then, in the canonical general chat only (never a ':women' one, which stays as it is) it makes sure the founder is a member
 * (muted) and, when he hasn't already posted this welcome there (the exact text, from him; a deleted one counts, so it isn't brought
 * back), inserts the message the way POST /chats/:id/messages stores it and pins it the way POST /chats/:id/pin/:messageId does,
 * in one transaction. It sends nothing: no push, no socket event, no email, no analytics event. A pin somebody else already set
 * is left alone. An alias that already points somewhere else, or is another city's canonical key, is reported and left as it is.
 *
 * Safe by default: it only reports (a lookup that misses the cache still fills geo_cache, as it would for any user). Nothing about
 * a chat or an alias is written without --commit. Safe to run again: the second run finds every alias and welcome in place.
 *
 *   DATABASE_URL=postgres://... npx tsx src/scripts/seed-founder-city-chats.ts
 *   DATABASE_URL=postgres://... npx tsx src/scripts/seed-founder-city-chats.ts --commit
 *   ... --email=founder@example.com   the founder account to use (required; or set FOUNDER_EMAIL)
 *
 * Run from apps/api. It prints the database host it is connected to first, so check that line. Nominatim allows about one
 * request a second, so a first run over the whole list takes a few minutes; points already in geo_cache cost nothing.
 */
import { pathToFileURL } from 'node:url';
import { config } from '../lib/config.js';
import { sql } from '../lib/db.js';
import { cityFor, cityKey } from '../lib/geo.js';
import { cityChatId, foldCityChat } from '../lib/city-chats.js';

export type Entry = {
  /** Shown in the chat title ("<city> travelers") and the welcome. */
  city: string;
  /** The canonical chat key. Written out, not derived, so a typo shows up in the test that compares it with cityKey(). */
  key: string;
  /** Where to look the city up from: the centre, and the neighbourhoods whose GPS key differs from the city's. */
  points: { label: string; lat: number; lng: number }[];
  /** Other names people type for the city in a trip ('bombay-in'), which have no GPS point to find them by. */
  aliases: string[];
};
const at = (city: string, key: string, points: [string, number, number][], aliases: string[] = []): Entry =>
  ({ city, key, points: points.map(([label, lat, lng]) => ({ label, lat, lng })), aliases });

export const CITIES: Entry[] = [
  // India. Goa, Delhi and Bangalore are named as their guides name them, so the guide page, a trip and GPS all open one chat.
  at('Goa', 'goa-in', [['Panaji', 15.4989, 73.8278], ['Calangute', 15.5440, 73.7550], ['Anjuna', 15.5736, 73.7413], ['Palolem', 15.0100, 74.0232]], ['panaji-in', 'calangute-in', 'anjuna-in', 'palolem-in']),
  at('Mumbai', 'mumbai-in', [['centre', 19.0760, 72.8777], ['Colaba Causeway', 18.9220, 72.8330], ['Bandra', 19.0596, 72.8295]], ['bombay-in']),
  at('Delhi', 'delhi-in', [['New Delhi', 28.6139, 77.2090], ['Connaught Place', 28.6315, 77.2167], ['Hauz Khas', 28.5494, 77.2001], ['Paharganj', 28.6448, 77.2167]], ['new-delhi-in']),
  at('Bangalore', 'bangalore-in', [['centre', 12.9716, 77.5946]], ['bengaluru-in']),
  at('Jaipur', 'jaipur-in', [['centre', 26.9124, 75.7873], ['old city', 26.9239, 75.8267]]),
  at('Udaipur', 'udaipur-in', [['centre', 24.5854, 73.7125]]),
  at('Jodhpur', 'jodhpur-in', [['centre', 26.2389, 73.0243]]),
  at('Varanasi', 'varanasi-in', [['centre', 25.3176, 82.9739]], ['benares-in']),
  at('Rishikesh', 'rishikesh-in', [['centre', 30.0869, 78.2676]]),
  at('Manali', 'manali-in', [['centre', 32.2396, 77.1887]]),
  at('Kasol', 'kasol-in', [['centre', 32.0100, 77.3150]]),
  at('Leh', 'leh-in', [['centre', 34.1526, 77.5771]]),
  at('Dharamshala', 'dharamshala-in', [['McLeod Ganj', 32.2426, 76.3213]]),
  at('Hampi', 'hampi-in', [['centre', 15.3350, 76.4600]]),
  at('Gokarna', 'gokarna-in', [['centre', 14.5479, 74.3188]]),
  at('Pondicherry', 'pondicherry-in', [['centre', 11.9416, 79.8083], ['White Town', 11.9340, 79.8306]], ['puducherry-in']),
  at('Kochi', 'kochi-in', [['centre', 9.9312, 76.2673]], ['cochin-in']),
  at('Munnar', 'munnar-in', [['centre', 10.0889, 77.0595]]),
  at('Varkala', 'varkala-in', [['centre', 8.7379, 76.7163]]),
  at('Darjeeling', 'darjeeling-in', [['centre', 27.0410, 88.2663]]),
  at('Agra', 'agra-in', [['centre', 27.1767, 78.0081]]),
  at('Amritsar', 'amritsar-in', [['centre', 31.6340, 74.8723]]),
  at('Shimla', 'shimla-in', [['centre', 31.1048, 77.1734]]),
  at('Mysuru', 'mysuru-in', [['centre', 12.2958, 76.6394]], ['mysore-in']),
  at('Kolkata', 'kolkata-in', [['centre', 22.5726, 88.3639]], ['calcutta-in']),
  at('Chennai', 'chennai-in', [['centre', 13.0827, 80.2707]], ['madras-in']),
  at('Hyderabad', 'hyderabad-in', [['centre', 17.3850, 78.4867]]),
  at('Pune', 'pune-in', [['centre', 18.5204, 73.8567]]),
  // The world
  at('Bangkok', 'bangkok-th', [['centre', 13.7563, 100.5018], ['Khao San', 13.7589, 100.4975], ['Sukhumvit', 13.7367, 100.5601]]),
  at('Chiang Mai', 'chiang-mai-th', [['old city', 18.7883, 98.9853], ['Nimman', 18.7993, 98.9680]]),
  at('Phuket', 'phuket-th', [['centre', 7.8804, 98.3923]]),
  at('Bali', 'bali-id', [['Canggu', -8.6478, 115.1385], ['Ubud', -8.5069, 115.2625], ['Seminyak', -8.6913, 115.1683]], ['canggu-id', 'ubud-id', 'seminyak-id']),
  at('Singapore', 'singapore-sg', [['centre', 1.3521, 103.8198]]),
  at('Kuala Lumpur', 'kuala-lumpur-my', [['centre', 3.1390, 101.6869]]),
  at('Hanoi', 'hanoi-vn', [['centre', 21.0285, 105.8542]]),
  at('Ho Chi Minh City', 'ho-chi-minh-city-vn', [['centre', 10.8231, 106.6297]], ['saigon-vn']),
  at('Da Nang', 'da-nang-vn', [['centre', 16.0544, 108.2022]]),
  at('Tokyo', 'tokyo-jp', [['centre', 35.6762, 139.6503], ['Shibuya', 35.6580, 139.7016], ['Shinjuku', 35.6938, 139.7034], ['Asakusa', 35.7148, 139.7967]]),
  at('Kyoto', 'kyoto-jp', [['centre', 35.0116, 135.7681]]),
  at('Seoul', 'seoul-kr', [['centre', 37.5665, 126.9780]]),
  at('Kathmandu', 'kathmandu-np', [['centre', 27.7172, 85.3240]]),
  at('Pokhara', 'pokhara-np', [['centre', 28.2096, 83.9856]]),
  at('Colombo', 'colombo-lk', [['centre', 6.9271, 79.8612]]),
  at('Dubai', 'dubai-ae', [['centre', 25.2048, 55.2708]]),
  at('Istanbul', 'istanbul-tr', [['centre', 41.0082, 28.9784]]),
  at('Lisbon', 'lisbon-pt', [['centre', 38.7223, -9.1393]]),
  at('Porto', 'porto-pt', [['centre', 41.1579, -8.6291]]),
  at('Barcelona', 'barcelona-es', [['centre', 41.3874, 2.1686]]),
  at('Madrid', 'madrid-es', [['centre', 40.4168, -3.7038]]),
  at('Paris', 'paris-fr', [['centre', 48.8566, 2.3522]]),
  at('London', 'london-gb', [['centre', 51.5074, -0.1278], ['Soho', 51.5136, -0.1365], ['Camden', 51.5390, -0.1426], ['Shoreditch', 51.5265, -0.0780]]),
  at('Amsterdam', 'amsterdam-nl', [['centre', 52.3676, 4.9041]]),
  at('Berlin', 'berlin-de', [['centre', 52.5200, 13.4050]]),
  at('Prague', 'prague-cz', [['centre', 50.0755, 14.4378]]),
  at('Budapest', 'budapest-hu', [['centre', 47.4979, 19.0402]]),
  at('Rome', 'rome-it', [['centre', 41.9028, 12.4964]]),
  at('Florence', 'florence-it', [['centre', 43.7696, 11.2558]]),
  at('Athens', 'athens-gr', [['centre', 37.9838, 23.7275]]),
  at('New York', 'new-york-us', [['centre', 40.7128, -74.0060]]),
  at('Mexico City', 'mexico-city-mx', [['centre', 19.4326, -99.1332]]),
  at('Medellín', 'medellin-co', [['centre', 6.2442, -75.5812]]),
  at('Buenos Aires', 'buenos-aires-ar', [['centre', -34.6037, -58.3816]]),
  at('Cape Town', 'cape-town-za', [['centre', -33.9249, 18.4241]]),
  at('Sydney', 'sydney-au', [['centre', -33.8688, 151.2093]]),
  at('Melbourne', 'melbourne-au', [['centre', -37.8136, 144.9631]]),
];

/** The one true message. Every line of it is something the founder can stand behind: who he is, what the chat is for, how to start. */
export const welcomeFor = (city: string) =>
  `Hi, I'm Jatinder, I built Tablamigo 👋 This is the chat for travellers in ${city}. Say hi: where you're from and how long you're here. ` +
  `Want company? Post a plan from the map (dinner, a walk, a day trip) and people nearby can join. Always meet in public places. Have a great trip!`;

export type PointResult = { label: string; lat: number; lng: number; gpsKey?: string; skipped?: string };
export type AliasResult = {
  key: string; from: 'gps' | 'typed';
  /** conflict: it already points at another chat, or is the canonical key of another city; nothing is written for it. */
  status: 'added' | 'would-add' | 'exists' | 'conflict'; note?: string;
};
export type EntryResult = {
  city: string; key: string; points: PointResult[]; aliases: AliasResult[];
  /** Chats found under an alias key (the general and the women's one count separately), folded in or, in a dry run, to fold in. */
  folded: number;
  chat: 'created' | 'existing' | 'would-create' | 'would-use';
  welcome: 'posted' | 'already-there' | 'would-post' | 'pinned-elsewhere';
};

type Options = {
  /** The founder's account email. */
  email: string; commit?: boolean; cities?: Entry[];
  /** Wait between lookups that reached Nominatim (its usage policy is about one request a second). 0 in tests. */
  delayMs?: number;
  log?: (line: string) => void;
};

/** Seeds (or, without `commit`, reports on) the founder's welcome in every city's canonical general chat. One result per city. */
export async function seedFounderCityChats(o: Options): Promise<{ founderId: string | null; results: EntryResult[] }> {
  const { email, commit = false, cities = CITIES, delayMs = 0, log = () => {} } = o;
  const [founder] = await sql`select id, name from users where lower(email) = lower(${email}) and deleted_at is null and banned_at is null`;
  if (!founder && commit) throw new Error(`No active account with the email ${email}: nothing was written.`);
  if (!founder) log(`warning: no active account with the email ${email} in this database, so chats and messages can't be checked, only the keys.`);
  const founderId = (founder?.id as string | undefined) ?? null;

  const canonical = new Set(cities.map(c => c.key));
  if (canonical.size !== cities.length) throw new Error('Two cities share a canonical key.');
  const [chained] = await sql`select alias_key from city_chat_aliases where alias_key in ${sql([...canonical])} limit 1`;
  if (chained) throw new Error(`${chained.aliasKey} is a canonical key here but an alias in city_chat_aliases: nothing was written.`);

  const results: EntryResult[] = [];
  const claimed = new Map<string, string>();   // alias key -> the city that wants it
  for (const c of cities) {
    const points: PointResult[] = [];
    const wanted = new Map<string, 'gps' | 'typed'>();
    for (const p of c.points) {
      const t0 = Date.now();
      const { city, country } = await cityFor(p.lat, p.lng);
      // A lookup served from geo_cache is one local query; one that asked Nominatim takes far longer.
      if (delayMs && Date.now() - t0 > 100) await new Promise(r => setTimeout(r, delayMs));
      if (!city || !country) { points.push({ ...p, skipped: 'Nominatim found no city and country for this point' }); continue; }
      const gpsKey = cityKey(city, country);
      points.push({ ...p, gpsKey });
      if (gpsKey !== c.key) wanted.set(gpsKey, 'gps');
    }
    for (const k of c.aliases) if (k !== c.key && !wanted.has(k)) wanted.set(k, 'typed');

    const aliases: AliasResult[] = [];
    for (const [k, from] of wanted) {
      const [row] = await sql`select canonical_key from city_chat_aliases where alias_key = ${k}`;
      const other = claimed.get(k);
      if (canonical.has(k)) aliases.push({ key: k, from, status: 'conflict', note: 'is the canonical key of another city' });
      else if (other && other !== c.key) aliases.push({ key: k, from, status: 'conflict', note: `also wanted by ${other}` });
      else if (row && row.canonicalKey !== c.key) aliases.push({ key: k, from, status: 'conflict', note: `already an alias of ${row.canonicalKey}` });
      else if (row) { claimed.set(k, c.key); aliases.push({ key: k, from, status: 'exists' }); }
      else {
        claimed.set(k, c.key);
        if (commit) await sql`insert into city_chat_aliases (alias_key, canonical_key) values (${k}, ${c.key}) on conflict (alias_key) do nothing`;
        aliases.push({ key: k, from, status: commit ? 'added' : 'would-add' });
      }
    }
    // Chats that already sit under an alias key (people got there before the alias did) move into the canonical one.
    const live = aliases.filter(a => a.status !== 'conflict').map(a => a.key);
    let folded = 0;
    for (const k of live) {
      if (commit) folded += await foldCityChat(k, c.key);
      else folded += (await sql`select 1 from chats where kind = 'city' and city_key in (${k}, ${k + ':women'})`).length;
    }

    const [existing] = await sql`select id from chats where kind = 'city' and city_key = ${c.key}`;
    const body = welcomeFor(c.city);
    const chat: EntryResult['chat'] = existing || (!commit && folded) ? (commit ? 'existing' : 'would-use') : (commit ? 'created' : 'would-create');
    const [posted] = existing && founderId
      ? await sql`select 1 from messages where chat_id = ${existing.id} and sender_id = ${founderId} and body = ${body} limit 1` : [];
    let welcome: EntryResult['welcome'] = posted ? 'already-there' : 'would-post';

    if (commit && founderId) {
      const chatId = await cityChatId(c.key, `${c.city} travelers`, false);
      // Muted: the founder is in every city, he shouldn't be buzzed by each of them. Nobody else is touched.
      await sql`insert into chat_members (chat_id, user_id, muted) values (${chatId}, ${founderId}, true)
        on conflict (chat_id, user_id) do update set muted = true`;
      const [there] = await sql`select 1 from messages where chat_id = ${chatId} and sender_id = ${founderId} and body = ${body} limit 1`;
      if (there) welcome = 'already-there';
      else {
        welcome = await sql.begin(async tx => {
          const [m] = await tx`insert into messages (chat_id, sender_id, kind, body) values (${chatId}, ${founderId}, 'text', ${body}) returning id`;
          await tx`update chats set last_message_at = now() where id = ${chatId}`;
          // His own message is read the moment he sends it (post() calls markRead for the sender).
          await tx`update chat_members set last_read_at = now(), last_read_message_id = ${m.id} where chat_id = ${chatId} and user_id = ${founderId}`;
          const [cur] = await tx`select pinned_message_id from chats where id = ${chatId} for update`;
          if (cur.pinnedMessageId) return 'pinned-elsewhere' as const;
          await tx`update chats set pinned_message_id = ${m.id} where id = ${chatId}`;
          return 'posted' as const;
        });
      }
    }
    const r: EntryResult = { city: c.city, key: c.key, points, aliases, folded, chat, welcome };
    results.push(r);
    const unresolved = points.filter(p => p.skipped).map(p => p.label);
    log(`${r.chat.padEnd(12)} ${r.welcome.padEnd(16)} ${c.city.padEnd(18)} ${c.key.padEnd(22)} ${aliases.length ? '<- ' + aliases.map(a => a.key + (a.status === 'conflict' ? ` (CONFLICT: ${a.note})` : '')).join(', ') : ''}${unresolved.length ? `   [no lookup: ${unresolved.join(', ')}]` : ''}`);
  }
  return { founderId, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const emails = args.filter(a => a.startsWith('--email=')).map(a => a.slice('--email='.length));
  const unknown = args.filter(a => a !== '--commit' && a !== '--dry-run' && !a.startsWith('--email='));
  if (unknown.length || emails.length > 1 || (commit && args.includes('--dry-run')) || emails.some(e => !/^[^@\s]+@[^@\s]+$/.test(e))) {
    console.error(`Unknown, malformed or conflicting argument: ${[...unknown, ...(emails.length > 1 ? ['--email twice'] : []), ...emails.filter(e => !/^[^@\s]+@[^@\s]+$/.test(e)), ...(commit && args.includes('--dry-run') ? ['--commit with --dry-run'] : [])].join(' ')}\nUsage: seed-founder-city-chats.ts [--dry-run | --commit] --email=<address>`);
    process.exit(2);
  }
  const email = emails[0] ?? process.env.FOUNDER_EMAIL ?? '';
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
    console.error('Pass the founder account with --email=<address> (or set FOUNDER_EMAIL).\nUsage: seed-founder-city-chats.ts [--dry-run | --commit] --email=<address>');
    process.exit(2);
  }
  const db = new URL(config.databaseUrl);
  console.log(`database: ${db.hostname}:${db.port || 5432}${db.pathname}   (${commit ? 'COMMITTING changes' : 'report only, no chat or message is written; pass --commit to write'})`);
  console.log(`founder:  ${email}`);
  const { results } = await seedFounderCityChats({ email, commit, delayMs: 1100, log: console.log });
  const aliases = results.flatMap(r => r.aliases);
  const count = (f: (r: EntryResult) => boolean) => results.filter(f).length;
  const unresolved = results.flatMap(r => r.points.filter(p => p.skipped).map(p => `${r.city} (${p.label})`));
  console.log(`\ncities listed:         ${results.length}   (${results.reduce((n, r) => n + r.points.length, 0)} points looked up)`);
  console.log(`chats ${commit ? 'created' : 'to create'}:       ${count(r => r.chat === 'created' || r.chat === 'would-create')}`);
  console.log(`chats already there:   ${count(r => r.chat === 'existing' || r.chat === 'would-use')}`);
  console.log(`welcomes ${commit ? 'posted' : 'to post'}:      ${count(r => r.welcome === 'posted' || r.welcome === 'would-post')}`);
  console.log(`welcomes in place:     ${count(r => r.welcome === 'already-there')}`);
  console.log(`posted, pin not set:   ${count(r => r.welcome === 'pinned-elsewhere')}  (another message was already pinned)`);
  console.log(`aliases ${commit ? 'added' : 'to add'}:        ${aliases.filter(a => a.status === 'added' || a.status === 'would-add').length}   (already there: ${aliases.filter(a => a.status === 'exists').length})`);
  console.log(`alias conflicts:       ${aliases.filter(a => a.status === 'conflict').length}${aliases.some(a => a.status === 'conflict') ? '  (see CONFLICT above; not written)' : ''}`);
  console.log(`chats ${commit ? 'folded in' : 'to fold in'}:       ${results.reduce((n, r) => n + r.folded, 0)}  (existing chats under an alias key)`);
  console.log(`points with no lookup: ${unresolved.length}${unresolved.length ? '  (' + unresolved.join(', ') + ')' : ''}`);
  if (!commit) console.log('Nothing was written. Re-run with --commit to make these changes.');
  await sql.end();
}
