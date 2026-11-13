# Google Play listing v2 (draft for review)

> **Status, 10 Oct 2026:** the paid-plans version of the Plus section below was drafted on 10 Oct 2026 and is NOT yet pushed to Google Play. The listing that is live is the v4 text in `store/play-listing.md` (pushed 5 Oct, free-only). Nothing here has been sent to Google Play.

Drafted 28 Sep 2026 from `store/play-listing.md` and `apps/web/KEYWORDS.md`. Everything else in v1 (package, category, graphics, subscription setup, app content answers, countries) is unchanged; only the three text fields below are proposed. Each feature named here is already in v1 or on the live site, so nothing new has to be backed up.

## App name (30 max)

**Recommended: keep `Tablamigo: Meet Solo Travelers` (30).**

It already carries the two strongest Play-relevant terms from the research, "meet travelers" (the "app to meet" seed had 130 autocomplete expansions) and "solo travel" (Nomadtable ranks #1 on the App Store and #4 on Play for "solo travel app"). Play matches words, not exact phrases, so this title also serves "app to meet solo travelers" and "solo travelers app". Changing it would trade one of those for a weaker term.

Variant B for a Store listing experiment once there is install traffic: `Tablamigo: Solo Travel Buddies` (30). It swaps "meet" for "travel buddy" (cluster 4). Only run it after the listing has enough visitors for the experiment to reach a result; with a new listing it won't.

Not used: competitor names (Play's metadata policy bans references to other apps), "free", "best", "#1" or emoji in the title (also against the metadata policy).

## Short description (80 max)

`Solo travel buddy app: meet travelers nearby for dinner, drinks and day trips.` (78)

Why: v1 ("Join dinners, drinks and day trips with solo travelers nearby. Never eat alone.") spends 16 characters on the slogan and doesn't include "travel buddy". This version covers "solo travel", "travel buddy app" and "meet travelers" in one readable sentence and keeps the concrete plans (dinner, drinks, day trips) that tell someone what the app actually does. The "Never eat alone" line moves to the top of the full description, where it still does its job.

## Full description (4000 max)

```
Traveling solo? Never eat alone.

Tablamigo is a travel buddy app for solo travelers, backpackers and digital nomads. Open the map, see what other travelers near you are doing right now, like street food tonight, sunset drinks, a hike tomorrow or a coworking session, and join with one tap. Or post your own plan and let people come to you.

No swiping and no endless small talk. Real plans, nearby, happening soon. It's the easiest way we know to meet people while traveling alone.

HOW IT WORKS
• Open the map and see plans from travelers around you, with who's going and how far away it is
• Tap Join and you're in the plan's group chat
• Or post "I want to…" in seconds and let other travelers join you
• Agree the details in the chat, meet up, keep exploring

MADE FOR SOLO TRAVEL
• Live plans map: dinners, drinks, nightlife, day trips, sports, culture and coworking near you, soonest first
• Trips: add where you're going next and see which travelers will be in the same city on the same dates
• City chats: talk to travelers arriving in your city this week
• Group chats for every plan, plus direct messages
• Plan ideas: stuck for something to do? Get suggestions for your city, ready to post in one tap
• Chat polls: let the group pick the time or the place
• Age filter: find travel friends around your age
• Countries visited: show your travel map on your profile
• Thumbs-up after a meetup: show who's great to hang out with
• Snooze: take a break and disappear from the map without deleting anything

FOR SOLO FEMALE TRAVELERS
• Women-only plans: women can host plans that only other women can see and join
• Selfie verification, so you can see who has been checked before you meet
• Share your live location with a plan's chat for 15 minutes to 8 hours; it stops by itself

SAFETY FIRST
• 18+ only
• Your exact location is never shown. Other travelers see a distance rounded to 0.5 km
• Selfie verification: verified travelers get a ✅ next to their name
• Group chats are checked by AI moderation
• Report or block anyone in one tap; blocked people can't see you anywhere
• Every report goes to our team
• Not a dating app: plans are for food, drinks, sightseeing, sport and coworking

FREE TO USE, WITH OPTIONAL PLUS
Free accounts see one small ad (none with Plus) and can join any plan, post 2 plans a day, chat in every plan, start 1 new direct-message conversation a day, see travelers nearby, join city chats for the next 3 days and see 3 trip overlaps. Safety features are free on every account.

Tablamigo Plus is optional and adds:
• Up to 20 plans a day
• 200 AI plan ideas a day
• Everyone overlapping your trips
• City chats up to a year ahead
• See who viewed your profile
• Unlimited new direct messages, and sharing phone numbers, emails and social handles in chats
• 6 profile photos, unlimited buddy requests and advanced filters

Plus is a Google Play subscription (weekly, monthly, 6-month or yearly). Google Play shows the price in your currency before you pay; cancel in Google Play → Payments & subscriptions.

Tablamigo is new, so the map is busiest in popular solo travel cities first. If there's nothing near you yet, post a plan: the next traveler to open the app in your city will see it.

On an iPhone or a laptop? Tablamigo also runs in the browser at tablamigo.hookstep.in/app.

Questions or feedback: support@hookstep.in
Terms: https://tablamigo.hookstep.in/terms
Privacy: https://tablamigo.hookstep.in/privacy
```

Length: 3,140 characters (limit 4,000), checked with `python3 -c "print(len(open(...).read()))"` on the block above.

## What changed from v1, and why

| Change | Reason |
|---|---|
| Opening paragraph now says "travel buddy app for solo travelers, backpackers and digital nomads" | Play indexes the full description, and ASO practice (not a documented Google rule) is to put the key terms in the first lines. v1's opener had none of the top terms. |
| Added "meet people while traveling alone" once | Cluster 3 and 5 phrasing ("best app to meet people while traveling", "how to meet people while traveling solo"), used once as a sentence, not a list |
| New "For solo female travelers" block, built only from existing features (women-only plans, selfie verification, live location) | "solo female travel" had 225 autocomplete expansions. v1 mentioned women-only plans but buried it. No women-only-app claim, since Tablamigo is mixed. |
| "Not a dating app" added to Safety | Answers the most common People Also Ask question for this category ("Is Nomadtable a dating app?") and sets expectations, which helps ratings |
| "Tablamigo is new…" paragraph | Honest about an empty map in quiet cities and turns it into an action. Stops the "nobody here" 1-star review from being the first one. |
| Web app line | Gives iPhone friends a route without claiming an iOS app |
| "Tablamigo is free to use" became "Meeting people on Tablamigo is free" | Same fact, but it's clear Plus exists, so nobody feels misled by a paywall |
| Removed nothing else | Every v1 feature bullet is kept |

Keyword use in the full description (counted): "solo travel/travelers" 3, "traveler/travelers" 11, "travel buddy" 1, "travel friends" 1, "meet people" 1, "digital nomads" 1, "solo female travelers" 1, "coworking" 3, "backpackers" 1. Nothing is repeated to hit a density target; Play's metadata policy prohibits repetitive or excessive keywords, and it reads badly.

## Before publishing

- Play Console will count characters itself; if it disagrees with the numbers here, trust the Console.
- The ✅ emoji is fine in the full description but not in the title or short description.
- If Plus prices or the Trip Pass change before launch, the text above doesn't name prices, so it won't need editing.
