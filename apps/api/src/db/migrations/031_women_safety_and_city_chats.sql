-- 031_women_safety_and_city_chats.sql: Backlog 28 (Women-only city chats, traveler list, and safety advice)

ALTER TABLE city_guides ADD COLUMN IF NOT EXISTS women_safety jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE city_guides
SET women_safety = '[
  "Delhi Metro features an exclusive Ladies Coach (first coach of every train) with dedicated security.",
  "Use verified app-based cabs (Uber/Ola) for airport transfers and late arrivals.",
  "Join women-only plans and verified groups when exploring crowded historical bazaars."
]'::jsonb
WHERE slug = 'delhi';

UPDATE city_guides
SET women_safety = '[
  "Mumbai is widely considered India''s safest metro; Marine Drive, Bandra, and Carter Road are lively with women walking until past midnight.",
  "Local trains feature dedicated Ladies coaches marked with green and yellow stripes.",
  "Metered black-and-yellow taxis are safe, regulated, and do not refuse metered fares."
]'::jsonb
WHERE slug = 'mumbai';

UPDATE city_guides
SET women_safety = '[
  "Pre-book reliable local cabs or rent registered scooters for hassle-free transit between beaches.",
  "Assagao, Anjuna, and Mandrem have large, friendly communities of solo female nomads and creators.",
  "Save the 112 emergency and women helpline 181 in your phone."
]'::jsonb
WHERE slug = 'goa';

UPDATE city_guides
SET women_safety = '[
  "BTS Skytrain and MRT subway are clean, fast, and heavily guarded.",
  "Ari, Thong Lo, and Silom are wonderful, safe neighborhoods filled with solo female nomads and cafe workers.",
  "Keep your hotel card with Thai address handy for local taxi drivers."
]'::jsonb
WHERE slug = 'bangkok';

UPDATE city_guides
SET women_safety = '[
  "Lisbon is consistently rated one of the safest European capitals for solo female travelers.",
  "Well-lit main avenues in Baixa, Chiado, and Principe Real are comfortable to walk at night.",
  "Tram 28 can be crowded during peak hours; keep your cross-body bag secure against pickpockets."
]'::jsonb
WHERE slug = 'lisbon';
