# Tablamigo keyword research

Researched 28 September 2026. Everything below was pulled live that day; nothing is from memory.

## How this was done

- **Google autocomplete**: `suggestqueries.google.com` (client=firefox, hl=en, gl=us) for ~100 seeds, plus a-z expansions on 9 core seeds (1,018 unique suggestions). Depth of a-z expansions per seed: `nomadtable` 199, `solo female travel` 225, `app to meet` 130, `solo travel app` 17, `travel buddy app` 14, `digital nomad meetup` 10.
- **Google Trends** (browser, worldwide, past 12 months): one comparison loaded. Average interest: nomadtable **58**, travello 42 (polluted by hotel names like "Grand Travello Hotel"), tripbff **13**, gaffl **7**, tourlina **0**. Nomadtable peaked at 100 in the week of 12 Jul 2026 and was 49 in the last week. Rising related queries: "tripbff" (breakout, on nomadtable), "nomadtable apk" +40%, "joinmytrip" +160% (on gaffl). Every later comparison stopped rendering (the explore call returned 200 but the widgets never loaded), so I stopped there rather than work around it. No captcha was shown or bypassed.
- **Google SERPs** (browser, hl=en, gl=us unless noted): top results and People Also Ask recorded for 17 queries below.
- **Competitor facts**: Apple's iTunes Search/Lookup API and App Store pages (US), Google Play listing pages, and competitors' own sites. Sources are named on each page that uses them.

Priority = autocomplete depth + Trends + whether a SERP is winnable by a small new site (forums and listicles in the top 5 = winnable; app stores only = hard).

## Competitor set (all verified live on 28 Sep 2026)

| App | Maker | Where verified | Notes for us |
|---|---|---|---|
| Nomadtable | Nomadtable Inc. | App Store id6736921913 (20,605 ratings, 4.7), Google Play `jayraavi.SoloMatch` (1M+ downloads), nomadtable.app | Main rival. Site is **nomadtable.app**; nomadtable.com does not resolve. Not listed on the Indian App Store; Google Play shows Indian prices. |
| TripBFF | TRIPBFF LLC / TripBFF Inc | App Store id6450123749 (3,902 ratings), Play `com.tripbffandroid` (100K+) | "tripbff alternatives", "tripbff android alternative" in autocomplete |
| Couchsurfing (Hangouts) | CouchSurfing International | App Store id525642917, Play (5M+) | Hangouts/Events need a paid membership (Couchsurfing blog, 24 Sep 2026) |
| Timeleft | Timeleft SAS | App Store id6466442949 (8,557 ratings), Play (1M+) | Dinner-with-strangers; strong "timeleft alternative" demand |
| Hostelworld (Social Pass) | Hostelworld.com Ltd | App Store id348890820, Play (5M+) | City/hostel chats, Social Pass |
| Meetup | Meetup LLC | App Store id375990038 | Interest groups; mostly locals |
| BFF (Bumble BFF) | Geneva Technologies (Bumble Inc. is parent) | App Store id1478573199, Play `com.genevachat.prod` | Listing says everything is free; no travel mode mentioned |
| Travello | Travello Pty Ltd | App Store id924774827 | Now leads with tour booking + cashback |
| Tourlina | Michael Klumpp | App Store id1017254933, Play (50K+) | Now open to all genders and includes dating |
| Travel Ladies | Damian Zbroek | App Store id1563814908 | Women only |
| NomadHer | NomadHer Inc | App Store id1473787837, Play (100K+) | Women only; ranks #1 for "solo female travel app" |
| GAFFL | GAFFL Inc | App Store id1470182395, Play (100K+) | Trip-based buddy finder, cost splitting |
| Fairytrail | LittleQuest | App Store id1442011999, Play (100K+) | Bucket-list matching, has paid tiers |
| Going Solo | Going Solo LLC | App Store id1671515758, Play (100K+) | Last Play update Jun 2025 |
| Backpackr | 1000543729 Ontario Ltd | App Store id6757887080 (3 ratings) | Small |
| Facebook groups, Nomads.com (Nomad List) | | web | Nomads.com ranks #2 for "digital nomad meetups" |

Not found: a "Hey! VINA" travel product (an App Store search for "hey vina" returned Meetup, Yubo and Gofrendly), and no app named "Solo Traveler" (the search returns Nomadtable, then Going Solo). Also seen in results but not researched further: Travel Buddy: AI Buddy Finder, Hopsiko, JoinMyTrip, Trippii, Noon Travel, Frienzy (a group trip planner, not a meetup app). Fairytrail brand searches are swamped by a hydrangea variety.

## Clusters, intent and page mapping

Priority: P1 = build now, P2 = build now if cheap, P3 = cover inside another page.

| # | Cluster (main queries) | Intent | Evidence | Priority | Page |
|---|---|---|---|---|---|
| 1 | **Nomadtable alternative**: nomadtable alternative, apps like nomadtable, app like nomadtable, similar app like nomadtable, nomadtable free alternative, nomadtable alternative reddit/ios, is nomadtable safe, nomadtable dating, nomadtable price/plus, is nomadtable free | Commercial | 199 a-z expansions on "nomadtable"; Trends 58 | P1 | `/nomadtable-alternative` (existing, re-audited) |
| 2 | **Nomadtable in India**: app like nomadtable in india, nomadtable alternative in india, nomadtable not available in india, nomadtable india, travel buddy app india, solo travel app india, travel partner app india (free) | Commercial, local | All in autocomplete; PAA "Is Nomadtable available in India?" | P1 | `/travel-buddy-app-india` (new) |
| 3 | **Best apps roundup**: best app to meet people while traveling, apps for solo travelers to meet, app to meet travelers, meet travelers app, solo travel apps to meet people, best travel buddy app, is there an app for solo travelers to meet | Commercial | "app to meet" 130 expansions | P1 | `/best-apps-to-meet-travelers` (new) |
| 4 | **Travel buddy app**: travel buddy app, travel buddy finder app, find travel companion app, travel companion app, travel friends app | Commercial | 14 expansions | P1 | `/travel-buddy-app` (existing) |
| 5 | **How to meet people solo**: how to meet people while traveling solo/alone, how to make friends while traveling, ways to meet people while traveling, where to meet people while traveling, meet other solo travelers | Informational | Many variants; PAA "How can I make friends while traveling solo?", "How do I deal with loneliness while traveling alone?" | P1 | `/how-to-meet-people-while-traveling-solo` (new) |
| 6 | **Solo female travel app**: solo female travel app, solo travel app for women, women only travel app, female travel buddy app, meet other solo female travelers, safe travel app for women | Commercial | "solo female travel" 225 expansions (mostly destinations) | P1 | `/solo-female-travel-app` (new) |
| 7 | **Digital nomad meetups**: digital nomad meetup(s), digital nomad meetup + lisbon/bangkok/buenos aires/da nang/barcelona/bali/valencia/koh phangan/tokyo, digital nomad events, digital nomad community | Informational/local | 10 city expansions | P1 | `/digital-nomad-meetups` (new) + city guides |
| 8 | **TripBFF alternative**: tripbff alternatives, tripbff android alternative, nomadtable vs tripbff, tripbff vs nomadtable | Commercial | Autocomplete + Trends breakout | P1 | `/tripbff-alternative` (new) |
| 9 | **Couchsurfing Hangouts alternative**: couchsurfing hangouts alternative, couchsurfing hangouts not working, couchsurfing alternative app, couchsurfing free alternative, nomadtable vs couchsurfing | Commercial | 10 "couchsurfing alternative" expansions | P2 | `/couchsurfing-hangouts-alternative` (new) |
| 10 | **Timeleft / dinner with strangers**: timeleft alternative (reddit, india, free), dinner with strangers app, app to meet strangers for dinner, app to meet people for dinner | Commercial | 6 + 10 expansions | P2 | `/timeleft-alternative` (new) |
| 11 | **City solo travel**: meet travelers in <city>, solo travel meetup <city> (london, tokyo, barcelona, lisbon, paris), solo female travel <city> | Local | Many city expansions; Nomadtable's trending trips list Paris, Rio, Barcelona, Mexico City, São Paulo, Madrid, Dubai, Bali, Bangkok, Tokyo, Lisbon, London, New York, Istanbul, Buenos Aires | P1 | `/solo-travel/<city>`; 12 cities added |
| 12 | Hostelworld Social Pass: hostelworld social pass (reddit, cost, review), nomadtable vs hostelworld | Navigational/commercial | Autocomplete | P3 | Section in `/best-apps-to-meet-travelers` |
| 13 | Meetup alternative, Bumble BFF alternative, bumble bff travel mode | Commercial, mostly not travel | Big volume but most searchers want local friends, which Tablamigo isn't built for | P3 | Sections in the roundup; no dedicated page |
| 14 | Tinder/Bumble/Hinge travel mode, "is there a Tinder for travelers" (PAA on 4 SERPs) | Dating | Tablamigo isn't a dating app | Skip | Answered once in the roundup FAQ |
| 15 | Things to do alone in <US city> | Informational, local | NYC, Vegas, Chicago dominate | P3 | New York guide covers NYC only |

## Top 15 keywords and their page

1. nomadtable alternative → /nomadtable-alternative
2. apps like nomadtable → /nomadtable-alternative
3. app like nomadtable in india → /travel-buddy-app-india
4. app to meet travelers → /best-apps-to-meet-travelers
5. best app to meet people while traveling → /best-apps-to-meet-travelers
6. solo travel app → /best-apps-to-meet-travelers (with /travel-buddy-app)
7. travel buddy app → /travel-buddy-app
8. how to meet people while traveling solo → /how-to-meet-people-while-traveling-solo
9. solo female travel app → /solo-female-travel-app
10. digital nomad meetups → /digital-nomad-meetups
11. tripbff alternative → /tripbff-alternative
12. couchsurfing hangouts alternative → /couchsurfing-hangouts-alternative
13. timeleft alternative → /timeleft-alternative
14. travel buddy app india → /travel-buddy-app-india
15. meet travelers in bangkok (and the other city queries) → /solo-travel/bangkok etc.

## Who ranks today (Google, top 5, 28 Sep 2026)

Nomadtable's own properties are in bold. Tablamigo does not rank for any of these, and a search for "tablamigo" returns unrelated results (Daylight "Tabla Go" etc.), so the site does not look indexed yet.

| Query | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| nomadtable alternative | Reddit r/digitalnomad | local-diaries.com | becksplore-travel.com | alternativeto.net | **Google Play (Nomadtable)** |
| apps like nomadtable (WebSearch, not Google) | **App Store** | App Store "you might also like" | g2.com | local-diaries.com | dayofus.com |
| app to meet travelers | **App Store (Nomadtable)** | Reddit r/travel | **Google Play (Nomadtable)** | Facebook "She Travels" | becksplore-travel.com (nomadtable.app #6, TripBFF App Store #7) |
| best app to meet people while traveling | Reddit r/travel | **App Store (Nomadtable)** | curlsenroute.com (Bumble BFF) | becksplore-travel.com | Facebook "She Travels" |
| solo travel app | **App Store (Nomadtable)** | Reddit r/travel | silvias-trips.com | **Google Play (Nomadtable)** | nomadsister.com |
| solo travel apps to meet people | Reddit r/TravelNoPics | **App Store** | **Google Play** | becksplore-travel.com | losethemap.com |
| travel buddy app | App Store (TripBFF) | Google Play (Travel Buddy: AI Buddy Finder) | tourlina.com | beatravelbuddy.com | trippii.app |
| how to meet people while traveling solo | Reddit r/solotravel | solotravelerworld.com | globe-gazers.com | blakeboles.com | carolinerosetravel.com |
| solo female travel app | nomadher.com | App Store (NomadHer) | Reddit r/solofemaletravellers | thegoodobserverblog.co.uk | Google Play (NomadHer) |
| digital nomad meetups | meetup.com | nomads.com | Reddit r/digitalnomad | nodesk.co | Facebook "Digital Nomads" |
| tripbff alternative | Reddit r/travel | becksplore-travel.com | tripbff.com | Google Play (TripBFF) | producthunt.com |
| nomadtable vs tripbff | Reddit r/solofemaletravellers | becksplore-travel.com | **Google Play** | Facebook | **App Store** (nomadtable.app #6) |
| couchsurfing hangouts alternative | Reddit r/couchsurfing | Facebook | Google Play (Couchsurfing) | couchers.org | App Store (Couchsurfing) |
| timeleft alternative | Reddit r/Austin | timeleft.com (their own "9 best apps") | introvrs.com | the-wknd.club | timeleft.com |
| dinner with strangers app | Reddit | timeleft.com | delish.com | App Store (Timeleft) | Google Play (Timeleft) |
| nomadtable india | **nomadtable.app** | **Google Play** | **App Store** | Reddit r/solofemaletravellers | **Instagram** |
| app like nomadtable in india (gl=in) | Reddit r/SoloTravel_India | alternativeto.net | local-diaries.com | Google Play (Travel Buddy: AI Buddy Finder) | dayofus.com |
| travel buddy app india (gl=in) | Google Play (Travel Buddy: AI Buddy Finder) | App Store (same) | beatravelbuddy.com | Google Play (GAFFL) | tourlina.com |
| meet travelers in bangkok | Reddit r/Bangkok | Facebook Expats in Bangkok | gogaffl.com | Quora | meetup.com |

Takeaways:
- Nomadtable ranks through its **store listings**, not its site. Its blog post "The 6 Best Apps to Meet People While Traveling Solo" is #7 for "nomadtable alternative" and shows up in WebSearch for "best apps..." queries.
- Most commercial SERPs have Reddit, Facebook and thin listicles in the top 5. A specific, sourced page can compete there. App-store-only SERPs ("travel buddy app") are hard until Tablamigo is on Google Play.
- "Nomadtable in India" is an open gap: nobody answers "Is Nomadtable available in India?" directly, and Tablamigo is free to use in India.

## People Also Ask worth answering (used as FAQs)

- Is Nomad Table legit? / Is Nomadtable a dating app? / Is Nomadtable free? / Is Nomadtable available in India?
- What is the best app for finding travel companions? / Which is the best travel buddy app?
- Is there a Tinder for travelers?
- How can I make friends while traveling solo? / How do I deal with loneliness while traveling alone?
- How can I find a female companion for travel? / What are the best solo female travel groups?
- What are some good groups for digital nomads to join?
- How safe is TripBFF?
- Does anyone use Couchsurfing anymore? / Is Couchsurfing no longer free?
- How much does Timeleft cost?

## Not verified / open

- Search volumes are relative (autocomplete depth, one Trends comparison), not absolute numbers. No paid keyword tool was used.
- Google Trends for Timeleft, Couchsurfing Hangouts, Hostelworld Social and the generic head terms didn't load.
- Google Play availability in India was checked from an Indian IP via the listing's rupee prices; I didn't try installing.
- SERPs were fetched once, from India with gl=us; rankings vary by location and day.

## Update, 29 September 2026

33 more queries were run through WebSearch (not Google, US-only, no People Also Ask, Reddit not searchable), including India variants. Tablamigo appeared in none, and a search for "tablamigo" still doesn't return the site.

- **India city intent is dominated by GAFFL's templated "travel buddy in <city>" pages.** Cities that came up repeatedly: Kasol (5 queries), Manali, Udaipur, Varanasi (3 each), McLeod Ganj, Leh-Ladakh, Hampi, Delhi (2 each). Guides added for all nine, plus a hub, `/solo-travel-india`, whose questions come from Quora and Tripadvisor thread titles ("best app in India to find a travel partner", "how can I find someone to travel with in India", "is it safe for an Indian girl to travel with strangers").
- **Not built, on purpose** (replaced on 11 October 2026 by the keyword plan below, which builds Gokarna and maps "solo travel groups india" to `/solo-trip-with-strangers-india`): "safar saathi / travel dost / hamsafar" (results are cargo apps, bus operators and GitHub projects, no companion intent), "safe travel app for women india" (SOS-app intent), "solo travel groups india" (paid group tours), Gokarna, Pushkar, Pondicherry and Varkala guides (one mention each).
- **New rivals seen:** Nomax (App Store id6757600229), Nearby Traveler (nearbytraveler.org), Parindey (Play), Sulekha Travel Companions, JoinMyTrip's India page.
- The India partner queries ("find travel partner india", "travel partner app india free") map to the existing `/travel-buddy-app-india`.

## Update, 11 October 2026: keyword page plan

The approved plan of 11 October (Google autocomplete with gl=in, hl=en, plus WebSearch on the US index; demand signals, not volumes). One page per search intent; close variants go into that page's headings, FAQ and copy, never into a page of their own. Branch `seo/keyword-pages`. Third-party facts were checked on their own sites or store listings on 11 October 2026 and are dated on the pages. This section replaces the 29 September "Not built, on purpose" list above: Gokarna now has a guide, and "solo travel groups india" belongs to `/solo-trip-with-strangers-india`.

| Intent | Main queries | Page | What changed |
|---|---|---|---|
| Travel buddy / partner app, India | travel buddy app india, travel partner app india (free), best travel partner app india, travel companion app india, solo travel apps india, find travel partner india, nomadtable india, tripbff india | `/travel-buddy-app-india` | Title "Travel buddy & partner apps in India: 9 compared"; SyncTrip added to the table (listings checked), Zostel's Zo Trips app and Nomax under "Other apps"; Nomadtable is still the first FAQ and in the meta description; one FAQ for Android and iPhone availability ("Which solo travel apps work in India?"); "Is there an app to travel with strangers in India?" is answered on the strangers page only; Goa and Manali partner line; Couchsurfing prices rechecked |
| Solo trip with strangers, India | solo trip with strangers (in india, from delhi/bangalore/mumbai), trip/travel with strangers (app, india, website), group trip with strangers, solo travel groups india, is it safe to travel with strangers in india | `/solo-trip-with-strangers-india` (new) | Three ways compared (operator trip, hostel-run trips, going alone), operator table from each operator's own site, vetting checklist, women-only trips, one departure-city table instead of origin-city pages |
| Solo female travel, India | solo female travel india, is india safe for solo female travellers, safe places for solo female travel in india, solo trip for girls/women in india | `/solo-female-travel-india` (new; held on 11 Oct 2026 via `HELD_PAGES` in build.py, then reviewed and released the same day: indexable, in sitemap.xml and llms*.txt) | UK FCDO advice (updated 7 Oct 2026), places with checked female-only dorms, a table of every such hostel (`<!-- women-dorms -->` from cities.json), women's coaches, 112/181/139 (1091 as listed by the UK advice), meeting other women |
| Solo travel places in India | solo travel places in india, best places for first solo trip in india, how to plan a solo trip in india, solo trips in india | `/solo-travel-india` | Title "Solo travel in India: where to go and meet travelers"; "Your first solo trip" (marked as our judgement), "Planning the trip", Spiti, Gokarna and Bir in the lists and season table; FAQs link the two new pages; "Is India safe to travel alone?" (the women's safety question belongs to the women's page) |
| Spiti solo trip | spiti valley solo trip, is spiti valley safe, best time to visit spiti valley, share taxi kaza | `/solo-travel/spiti-valley` (new guide) | Sourced meeting spots, why taxis are hard to share in Spiti, village bus times, permits, where to stay |
| Gokarna solo trip | solo trip to gokarna (from bangalore/mumbai), hostels in gokarna for solo travellers, solo female trip to gokarna | `/solo-travel/gokarna` (new guide) | Two hostels, beach-walk meeting spots, swimming safety, trains and buses |
| Bir solo trip | solo trip to bir billing, zostel bir billing, bir billing paragliding solo | `/solo-travel/bir-billing` (new guide) | Three hostels, landing-site meeting spots, monsoon flying ban, tandem licences |
| Leh-Ladakh solo trip | solo trip to leh ladakh, shared taxi leh, travel partner for ladakh | `/solo-travel/leh` | H1 and title say "Leh-Ladakh" (`display` in cities.json); "Finding people to share a taxi" section and FAQ |
| Solo trip to an India city | solo trip to goa/manali/kasol/rishikesh (female, from delhi/mumbai/bangalore) | `/solo-travel/<city>` | "<city> solo trip as a woman" on every India guide, "Getting to" lines (`getting_there`) for Goa, Rishikesh, Kasol, McLeod Ganj and Hampi, NomadGao in Goa, a second Zostel stay in Hampi, links to the two new pages |
| Digital nomads in India | digital nomad india, digital nomad goa, digital nomad meetups india | `/digital-nomad-meetups` | "Digital nomad meetups in India" (NomadGao, Nomads.com's India pages, dated) and FAQ |
| Backpacker meetups | backpackers meetup, backpacker meetups india, how to meet other travelers | `/how-to-meet-people-while-traveling-solo` | "Backpacker and traveler meetups" section with an India paragraph |
| Hostels in India | hostels for solo travellers india, zostel, hostel chains india | `/how-to-meet-people-in-hostels` | "Hostels in India" (Zostel, The Hosteller, goSTOPS, Madpackers) and FAQ |
| Travel buddy app, global | travel buddy app, travel companion app, meet travelers near me | `/travel-buddy-app` | Title unchanged; two FAQs and India links |
| Apps roundup | best app to meet people while traveling, apps for solo travelers | `/best-apps-to-meet-travelers` | "Other apps you'll see" (Nomax, roammate, SyncTrip; TRVL and Sociway no longer on the App Store) |
| Solo female travel app | solo female travel app, female travel buddy app | `/solo-female-travel-app` | "Traveling solo in India?" hands the India intent to the new page |
| Couchsurfing | couchsurfing alternative (india), couchsurfing india | `/couchsurfing-hangouts-alternative` | Couchers.org added; "Does Couchsurfing work in India?" |

Skipped, as the plan says: Pondicherry, Varkala, Kerala, Meghalaya, Coorg, Kedarnath, Pushkar and Jibhi guides (revisit Pondicherry once Spiti, Gokarna and Bir are indexed); akele ghumne (Hindi page waits for the hi-IN listing, a Hindi-reading reviewer and hreflang); meeting or dating foreigners; paid companions and package tours; `/nomadtable-alternative` (unchanged, current).
