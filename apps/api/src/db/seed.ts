// Enhanced Demo data for Tablamigo: populated across Phuket/Karon (Thailand),
// India (Mumbai, Delhi, Goa), South Africa (Cape Town, Tshwane), Bangkok, Lisbon, and Bali.
// Every seeded account uses an @demo.tablamigo address so it can be wiped cleanly if ever needed:
//   delete from users where email like '%@demo.tablamigo';
import { sql } from '../lib/db.js';
import { cityKey } from '../lib/geo.js';

const avatar = (seed: string) => `https://api.dicebear.com/9.x/notionists/png?seed=${encodeURIComponent(seed)}&backgroundColor=ffd5dc,c0aede,d1d4f9,b6e3f4,ffdfbf&size=256`;

const TRAVELERS = [
  // Phuket / Karon / Patong (matching Vladi's area)
  { name: 'Liam', cc: 'GB', gender: 'man', city: 'Karon', lat: 7.8430, lng: 98.2950, interests: ['beaches', 'scuba diving', 'nightlife', 'food'], bio: 'Backpacking Southeast Asia for 3 months. Always down for sunset drinks or beach volleyball!' },
  { name: 'Maya', cc: 'FR', gender: 'woman', city: 'Patong', lat: 7.8960, lng: 98.2980, interests: ['sunset spots', 'yoga', 'seafood', 'hiking'], bio: 'Remote designer working from Phuket. Looking for dinner buddies and day trip companions.' },
  { name: 'Daniel', cc: 'DE', gender: 'man', city: 'Patong', lat: 7.8900, lng: 98.3020, interests: ['surfing', 'muay thai', 'street food', 'scooters'], bio: 'Training Muay Thai in Rawai, spending evenings exploring Patong and local food markets.' },

  // Bangkok (Thailand)
  { name: 'Elena', cc: 'BG', gender: 'woman', city: 'Bangkok', lat: 13.7466, lng: 100.5346, interests: ['food', 'museums', 'wine', 'street food'], bio: 'Foodie nomad based in Sukhumvit. On a quest to try every noodle soup in Bangkok.' },
  { name: 'Sofia', cc: 'IT', gender: 'woman', city: 'Bangkok', lat: 13.7398, lng: 100.5100, interests: ['photography', 'markets', 'coffee', 'temples'], bio: 'Freelance photographer capturing city vibes. Up for morning temple walks and night markets!' },
  { name: 'Jag', cc: 'US', gender: 'man', city: 'Bangkok', lat: 13.7236, lng: 100.5810, interests: ['nightlife', 'startups', 'gym', 'rooftops'], bio: 'Tech founder spending October in BKK. Let\'s grab drinks with a view.' },

  // India (Mumbai, Goa, Delhi, Bangalore - matching Indian community & Sakshi/Varunraj)
  { name: 'Aarav', cc: 'IN', gender: 'man', city: 'Mumbai', lat: 18.9220, lng: 72.8347, interests: ['photography', 'cafes', 'live music', 'heritage walks'], bio: 'Exploring Mumbai\'s vintage cafes and coastal sunsets. Happy to show visitors around Bandra!' },
  { name: 'Rohan', cc: 'IN', gender: 'man', city: 'Goa', lat: 15.5800, lng: 73.7400, interests: ['beach shacks', 'sunset', 'electronic music', 'biking'], bio: 'Workcationing in Anjuna. Evening beer, beach swims, and seafood thalis.' },
  { name: 'Ananya', cc: 'IN', gender: 'woman', city: 'Delhi', lat: 28.5535, lng: 77.1945, interests: ['art galleries', 'street food', 'books', 'architecture'], bio: 'Architect & travel enthusiast. Love weekend monument walks and Old Delhi food trails.' },

  // South Africa (Cape Town & Tshwane - matching Blessing's region)
  { name: 'Thabo', cc: 'ZA', gender: 'man', city: 'Cape Town', lat: -33.9249, lng: 18.4241, interests: ['hiking', 'braai', 'road trips', 'music'], bio: 'Cape Town local loving Table Mountain hikes and Camps Bay sunsets.' },
  { name: 'Nandi', cc: 'ZA', gender: 'woman', city: 'City of Tshwane Metropolitan Municipality', lat: -25.7479, lng: 28.2293, interests: ['markets', 'nature', 'coffee', 'photography'], bio: 'Exploring South Africa one weekend at a time. Always up for a good coffee and farm market.' },

  // Lisbon (Portugal)
  { name: 'Lucas', cc: 'BR', gender: 'man', city: 'Lisbon', lat: 38.7110, lng: -9.1400, interests: ['surfing', 'beach', 'music', 'wine'], bio: 'Brazilian nomad enjoying pastel de nata and surfing in Costa da Caparica.' },
  { name: 'Mia', cc: 'DE', gender: 'woman', city: 'Lisbon', lat: 38.7190, lng: -9.1325, interests: ['yoga', 'coffee', 'coworking', 'viewpoints'], bio: 'Working remotely from Chiado. Let\'s watch the golden hour from Senhora do Monte!' },

  // Bali (Indonesia)
  { name: 'Noah', cc: 'AU', gender: 'man', city: 'Bali', lat: -8.6500, lng: 115.1300, interests: ['diving', 'beach', 'gym', 'scooters'], bio: 'Surfing Canggu and diving around Nusa Penida. Looking for road trip buddies.' },
  { name: 'Priya', cc: 'CA', gender: 'woman', city: 'Bali', lat: -8.5069, lng: 115.2625, interests: ['vegan', 'yoga', 'language exchange', 'waterfalls'], bio: 'Yoga retreat in Ubud and working from cozy cafes. Let\'s explore hidden waterfalls!' },
];

const SEED_ACTIVITIES = [
  // Phuket / Patong / Karon plans (immediate companions for Vladi!)
  {
    city: 'Patong',
    hostName: 'Maya',
    emoji: '🍸',
    title: 'Sunset cocktails & Bangla Road walk',
    category: 'drinks',
    placeName: 'Patong Beach & Bangla Road',
    lat: 7.8960,
    lng: 98.2980,
    hoursAhead: 4,
    description: 'Catching golden hour on the sand then grabbing dinner and drinks near Bangla Road. Super chill vibe!',
  },
  {
    city: 'Karon',
    hostName: 'Liam',
    emoji: '🏐',
    title: 'Karon Beach volleyball & afternoon coconuts',
    category: 'outdoors',
    placeName: 'Karon Beach Center',
    lat: 7.8430,
    lng: 98.2950,
    hoursAhead: 18,
    description: 'Casual beach volleyball match and fresh coconuts afterwards. Any skill level welcome!',
  },
  {
    city: 'Patong',
    hostName: 'Daniel',
    emoji: '🍜',
    title: 'Banzaan Night Market seafood feast',
    category: 'food',
    placeName: 'Banzaan Fresh Market, Patong',
    lat: 7.8910,
    lng: 98.3015,
    hoursAhead: 26,
    description: 'Pick fresh seafood downstairs and get it cooked fresh upstairs! Great prices and awesome flavors.',
  },

  // Bangkok plans
  {
    city: 'Bangkok',
    hostName: 'Elena',
    emoji: '🍜',
    title: 'Chinatown street food crawl',
    category: 'food',
    placeName: 'Yaowarat Road, Chinatown',
    lat: 13.7398,
    lng: 100.5100,
    hoursAhead: 6,
    description: 'Tasting Michelin-guide street food: rolled noodles, toasted buns, and seafood. Come hungry!',
  },
  {
    city: 'Bangkok',
    hostName: 'Jag',
    emoji: '🍸',
    title: 'Sunset drinks at Octave Rooftop',
    category: 'drinks',
    placeName: 'Octave Rooftop, Sukhumvit 57',
    lat: 13.7236,
    lng: 100.5810,
    hoursAhead: 22,
    description: '360-degree sunset panorama over Bangkok skyline. Smart casual dress code.',
  },

  // Mumbai & Goa plans
  {
    city: 'Mumbai',
    hostName: 'Aarav',
    emoji: '☕',
    title: 'Marine Drive sunset & Kala Ghoda cafes',
    category: 'explore',
    placeName: 'Marine Drive Promenade',
    lat: 18.9300,
    lng: 72.8230,
    hoursAhead: 8,
    description: 'Catching the sea breeze at Queens Necklace and heading to a historic art cafe for chai & snacks.',
  },
  {
    city: 'Goa',
    hostName: 'Rohan',
    emoji: '🌅',
    title: 'Sunset beer & music at Anjuna beach shack',
    category: 'drinks',
    placeName: 'Curlies Beach Shack, Anjuna',
    lat: 15.5800,
    lng: 73.7400,
    hoursAhead: 12,
    description: 'Watching the sunset over the Arabian Sea with chilled drinks and good tunes. Free entry!',
  },

  // Lisbon plans
  {
    city: 'Lisbon',
    hostName: 'Mia',
    emoji: '🍷',
    title: 'Sunset wine & petiscos in Alfama',
    category: 'drinks',
    placeName: 'Miradouro das Portas do Sol',
    lat: 38.7125,
    lng: -9.1305,
    hoursAhead: 14,
    description: 'Enjoying Portuguese wine, cheese, and panoramic views of the Tejo river. Relaxed evening.',
  },

  // Bali plans
  {
    city: 'Bali',
    hostName: 'Noah',
    emoji: '🏄',
    title: 'Echo Beach surf session & smoothie bowls',
    category: 'outdoors',
    placeName: 'Echo Beach, Canggu',
    lat: -8.6540,
    lng: 115.1270,
    hoursAhead: 16,
    description: 'Catching the morning swell and refueling at a nearby organic cafe. Board rentals available on site.',
  },

  // Cape Town plan
  {
    city: 'Cape Town',
    hostName: 'Thabo',
    emoji: '⛰️',
    title: 'Lion\'s Head sunrise hike & coffee',
    category: 'outdoors',
    placeName: 'Lion\'s Head Trailhead',
    lat: -33.9350,
    lng: 18.3900,
    hoursAhead: 30,
    description: 'Moderate 2-hour loop with incredible 360 views over Camps Bay and the city bowl. Bring sneakers and water!',
  },
];

console.log('Seeding Tablamigo personas and activities...');

// Clean up existing demo records cleanly
await sql`delete from users where email like '%@demo.tablamigo'`;

const userMap = new Map<string, string>();
const jitter = () => (Math.random() - 0.5) * 0.04;

for (let i = 0; i < TRAVELERS.length; i++) {
  const t = TRAVELERS[i];
  const email = `${t.name.toLowerCase()}@demo.tablamigo`;
  const birthYear = 1995 + (i % 6);
  const birthMonth = String(1 + (i % 12)).padStart(2, '0');
  const birthdate = `${birthYear}-${birthMonth}-15`;

  const [u] = await sql`
    insert into users (
      email, name, birthdate, gender, home_country, bio, photo_url,
      languages, interests, location, location_at, city, onboarded, verified,
      attribution
    ) values (
      ${email}, ${t.name}, ${birthdate}, ${t.gender}, ${t.cc}, ${t.bio}, ${avatar(t.name + t.cc)},
      ${['English']}, ${t.interests},
      ST_SetSRID(ST_MakePoint(${t.lng + jitter()}, ${t.lat + jitter()}), 4326)::geography,
      now() - ${(i * 12) + ' minutes'}::interval, ${t.city}, true, ${i % 3 === 0},
      ${sql.json({ source: 'Demo Persona', medium: 'seed', device: 'Mobile' })}
    ) returning id
  `;
  userMap.set(t.name, u.id);
}

const allDemoIds = Array.from(userMap.values());

// Create seed activities
for (const act of SEED_ACTIVITIES) {
  const hostId = userMap.get(act.hostName) || allDemoIds[0];
  const startsAt = new Date(Date.now() + act.hoursAhead * 3600_000);

  const [a] = await sql`
    insert into activities (
      host_id, title, emoji, category, place_name, location, city, starts_at, max_people, description
    ) values (
      ${hostId}, ${act.title}, ${act.emoji}, ${act.category}, ${act.placeName},
      ST_SetSRID(ST_MakePoint(${act.lng}, ${act.lat}), 4326)::geography, ${act.city},
      ${startsAt}, 8, ${act.description}
    ) returning id
  `;

  const [chat] = await sql`
    insert into chats (kind, activity_id, title, last_message_at)
    values ('activity', ${a.id}, ${act.title}, now())
    returning id
  `;

  // Add host + 1-2 other travelers
  const otherTravelers = allDemoIds.filter(id => id !== hostId).sort(() => Math.random() - 0.5).slice(0, 2);
  const members = [hostId, ...otherTravelers];

  for (const m of members) {
    await sql`insert into activity_members (activity_id, user_id) values (${a.id}, ${m}) on conflict do nothing`;
    await sql`insert into chat_members (chat_id, user_id) values (${chat.id}, ${m}) on conflict do nothing`;
  }

  // Seed initial greeting in chat
  await sql`
    insert into messages (chat_id, sender_id, body)
    values (${chat.id}, ${hostId}, ${'Hey everyone! Looking forward to meeting up. Let me know if you have any questions! 🙌'})
  `;
  if (otherTravelers.length > 0) {
    await sql`
      insert into messages (chat_id, sender_id, body)
      values (${chat.id}, ${otherTravelers[0]}, ${'Sounds awesome, see you there!'})
    `;
  }
}

// Seed upcoming trips for travelers
const DESTINATIONS = [
  ['Phuket', 'TH'],
  ['Bangkok', 'TH'],
  ['Bali', 'ID'],
  ['Lisbon', 'PT'],
  ['Goa', 'IN'],
  ['Tokyo', 'JP'],
  ['Cape Town', 'ZA'],
];

for (let k = 0; k < allDemoIds.length; k++) {
  const id = allDemoIds[k];
  const dest = DESTINATIONS[k % DESTINATIONS.length];
  await sql`
    insert into trips (user_id, city, country_code, city_key, start_date, end_date)
    values (
      ${id}, ${dest[0]}, ${dest[1]}, ${cityKey(dest[0], dest[1])},
      current_date + ${3 + (k % 8)}::int,
      current_date + ${10 + (k % 8)}::int
    )
  `;
}

console.log(`Seeded ${allDemoIds.length} travelers and ${SEED_ACTIVITIES.length} active plans across Phuket, Bangkok, Mumbai, Goa, Cape Town, Lisbon, and Bali.`);
await sql.end();
