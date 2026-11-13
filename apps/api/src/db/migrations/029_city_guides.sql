-- 029_city_guides.sql: In-app city guides and destination hubs
create table if not exists city_guides (
  slug text primary key,
  city text not null,
  country text not null,
  country_code text not null,
  emoji text not null,
  intro text not null,
  location geography(Point, 4326),
  areas jsonb not null default '[]'::jsonb,
  plans jsonb not null default '[]'::jsonb,
  safety jsonb not null default '[]'::jsonb,
  best_season text,
  created_at timestamptz not null default now()
);

create index if not exists idx_city_guides_country_code on city_guides(country_code);
create index if not exists idx_city_guides_location on city_guides using gist(location);

-- Seed curated global & local hubs
insert into city_guides (slug, city, country, country_code, emoji, intro, location, areas, plans, safety, best_season)
values
(
  'mumbai', 'Mumbai', 'India', 'IN', '🌊',
  'Mumbai is vibrant, energetic, and one of the easiest places in India to meet interesting solo travelers, entrepreneurs, and artists. Evenings on the promenade or cafe crawls in Bandra are iconic.',
  ST_SetSRID(ST_MakePoint(72.8777, 19.0760), 4326)::geography,
  '[
    ["Bandra West", "Art cafes, specialty coffee, boutique shopping, and seaside Carter Road walks."],
    ["South Mumbai (Colaba & Fort)", "Colonial architecture, historic art galleries, Marine Drive, and legendary restaurants."],
    ["Juhu & Versova", "Beach vibe, creative cafes, and relaxed evening gatherings."]
  ]'::jsonb,
  '["Sunset coffee walk along Marine Drive", "Specialty coffee crawl in Bandra lanes", "Street food & architecture walking tour in Colaba", "Live indie gig at antiSOCIAL"]'::jsonb,
  '["Use metered black-and-yellow cabs or Uber/Ola for reliable transit.", "Marine Drive is safe and lively until late at night.", "Try street food from busy, high-turnover stalls with bottled water."]'::jsonb,
  'November to February offers pleasant weather and breezy sea evenings.'
),
(
  'goa', 'Goa', 'India', 'IN', '🏝️',
  'India''s premier beach & nomad hub. From quiet cafes and coworking in Assagao to lively sunset drums in Arambol, it is effortless to connect with other solo wanderers.',
  ST_SetSRID(ST_MakePoint(73.8278, 15.4909), 4326)::geography,
  '[
    ["Anjuna & Vagator", "Cliffside sunset bars, beach markets, and vibrant music events."],
    ["Arambol & Mandrem", "Yoga circles, relaxed beach shacks, and live music communities."],
    ["Assagao & Siolim", "Heritage Portuguese villas, boutique bakeries, and chic nomad cafes."],
    ["Panaji & Fontainhas", "Colorful Latin Quarter, historic taverns, and Goan seafood."]
  ]'::jsonb,
  '["Sunset drinks and acoustic music at Anjuna", "Scooter ride through scenic Siolim backwaters", "Authentic Goan seafood dinner in Fontainhas", "Beach bonfire and stargazing in Mandrem"]'::jsonb,
  '["Wear a helmet while riding rental scooters; local traffic checks are strict.", "Swim only in designated zones marked by lifeguards.", "Keep belongings attended when taking a dip at busy beaches."]'::jsonb,
  'October to March: clear skies, gentle seas, and lively markets.'
),
(
  'delhi', 'Delhi', 'India', 'IN', '🕌',
  'Rich in Mughal history, bustling food bazaars, and green urban parks. Solo travelers easily bond over legendary food trails and evening gatherings in Hauz Khas.',
  ST_SetSRID(ST_MakePoint(77.2090, 28.6139), 4326)::geography,
  '[
    ["Hauz Khas Village", "Overlooking 13th-century reservoir ruins with rooftop cafes and indie bars."],
    ["Connaught Place", "Georgian colonnades, underground markets, and central transit hub."],
    ["Old Delhi (Chandni Chowk)", "Legendary street food lanes, spice markets, and Jama Masjid."]
  ]'::jsonb,
  '["Sunset drinks overlooking Hauz Khas lake", "Heritage walking tour at Humayun''s Tomb", "Old Delhi food tasting trail", "Craft coffee and book browsing in Lodhi Colony"]'::jsonb,
  '["Delhi Metro is fast, modern, and has dedicated women''s coaches.", "Avoid unregulated street touts around New Delhi railway station.", "Drink sealed bottled water."]'::jsonb,
  'October to March: crisp autumn and cool winter days.'
),
(
  'bangalore', 'Bangalore', 'India', 'IN', '☕',
  'India''s tech and craft beer capital. Leafy boulevards, third-wave coffee roasters, and endless microbreweries make it exceptionally social for solo visitors.',
  ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326)::geography,
  '[
    ["Indiranagar", "100ft Road boutiques, specialty coffee roasters, and lively pubs."],
    ["Koramangala", "Startups, bustling food streets, and casual coworking spaces."],
    ["MG Road & Church Street", "Bookshops (Blossoms), street cafes, and classic rock pubs."]
  ]'::jsonb,
  '["Craft beer tasting crawl in Indiranagar", "Morning walk through Cubbon Park followed by filter coffee", "Bookstore browsing at Blossoms on Church Street", "Coworking day and startup networking in Koramangala"]'::jsonb,
  '["Bangalore Namma Metro is clean, safe, and convenient for navigating city traffic.", "Weather is pleasant year-round; carry a light umbrella for sudden showers."]'::jsonb,
  'September to March is peak pleasant weather.'
),
(
  'bangkok', 'Bangkok', 'Thailand', 'TH', '🛺',
  'Bangkok is one of the easiest cities in the world to meet other solo travelers: hostels, rooftop bars and street-food lanes are full of people exploring on their own.',
  ST_SetSRID(ST_MakePoint(100.5018, 13.7563), 4326)::geography,
  '[
    ["Sukhumvit (Asok, Nana, Thonglor)", "Rooftop bars, food courts and coworking cafes along the BTS line."],
    ["Banglamphu & Khao San Road", "The classic backpacker base. Loud, social, and close to river piers."],
    ["Ari", "Leafy, local and full of third-wave cafes for digital nomads."]
  ]'::jsonb,
  '["Street-food crawl through Chinatown (Yaowarat) after dark", "Sunset drinks at a Sukhumvit rooftop bar", "Weekend wander around Chatuchak market", "Beginner Muay Thai class, then dinner"]'::jsonb,
  '["Book rides in Grab or Bolt instead of haggling with tuk-tuks at night.", "Meet new people in busy places and keep an eye on your drink.", "Ignore anyone near temples claiming the attraction is closed today."]'::jsonb,
  'November to February: cool, dry season and the busiest for travelers.'
),
(
  'bali', 'Bali', 'Indonesia', 'ID', '🌴',
  'Bali attracts solo travelers for surf, yoga and remote work, with a tight-knit community of people traveling alone. Meeting people nearby makes exploring effortless.',
  ST_SetSRID(ST_MakePoint(115.1889, -8.4095), 4326)::geography,
  '[
    ["Canggu", "Surf breaks, cafes, coworking and sunset beach bars. The nomad hub."],
    ["Ubud", "Rice terraces, yoga, healthy food and cultural arts."],
    ["Uluwatu", "Cliffs, world-class surf and clifftop beach clubs."]
  ]'::jsonb,
  '["Sunset at Batu Bolong or Echo Beach", "Beginner surf lesson in Canggu", "Mount Batur sunrise hike", "Morning yoga class in Ubud"]'::jsonb,
  '["Scooter accidents are common; ride only if experienced and licensed.", "Drink filtered or bottled water to avoid Bali belly.", "Keep bags away from monkeys at temple sites."]'::jsonb,
  'April to October is dry season; June to August is peak social season.'
),
(
  'lisbon', 'Lisbon', 'Portugal', 'PT', '🚋',
  'Lisbon is Europe''s solo-travel and remote-work capital: sunny, walkable, and packed with scenic miradouros made for sharing drinks at golden hour.',
  ST_SetSRID(ST_MakePoint(-9.1393, 38.7223), 4326)::geography,
  '[
    ["Bairro Alto", "Cobbled alleys with bustling bars and spontaneous street conversations."],
    ["Alfama", "Historic Lisbon, winding lanes, viewpoints, and fado houses."],
    ["Cais do Sodre", "Riverside nightlife and the vibrant Time Out Market."]
  ]'::jsonb,
  '["Sunset gathering at Miradouro de Santa Catarina", "Pastel de nata tasting in Belem and Chiado", "Fado dinner in Alfama", "Day trip to Sintra''s fairy-tale palaces"]'::jsonb,
  '["Keep wallets and phones zipped on Tram 28 and crowded plazas.", "Cobbled streets can be slippery; wear comfortable shoes with traction."]'::jsonb,
  'April to June and September to October: sunny and warm without mid-summer crowds.'
),
(
  'barcelona', 'Barcelona', 'Spain', 'ES', '🏖️',
  'Barcelona mixes beach, Gaudí architecture, and late nights. The late dinner culture makes spontaneous evening meetups natural and fun.',
  ST_SetSRID(ST_MakePoint(2.1734, 41.3851), 4326)::geography,
  '[
    ["El Born", "Tapas bars, cocktail lounges, and charming medieval plazas."],
    ["Gracia", "Bohemian village vibe with plazas buzzing every evening."],
    ["Barceloneta & Poblenou", "Beach life, volleyball matches, and chiringuitos."]
  ]'::jsonb,
  '["Tapas and vermut hopping in El Born", "Sunset at the Bunkers del Carmel", "Beach volleyball at Barceloneta", "Sagrada Familia visit and neighborhood coffee"]'::jsonb,
  '["Pickpockets are active on Las Ramblas and the beach; keep bags in front of you.", "Dinner begins around 9-10 PM; plan evening plans accordingly."]'::jsonb,
  'May, June, and September: perfect beach weather and great atmosphere.'
)
on conflict (slug) do update set
  city = excluded.city,
  country = excluded.country,
  country_code = excluded.country_code,
  emoji = excluded.emoji,
  intro = excluded.intro,
  location = excluded.location,
  areas = excluded.areas,
  plans = excluded.plans,
  safety = excluded.safety,
  best_season = excluded.best_season;
