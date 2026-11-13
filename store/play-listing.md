# Google Play listing — Tablamigo

Package: `com.tablamigo.app` · Category: **Travel & Local** · Tags: Travel, Social, Meetups
Contact email: support@hookstep.in · Website: https://tablamigo.hookstep.in · Privacy: https://tablamigo.hookstep.in/privacy

> **1 Nov 2026 (ASO pass, ships with 1.4.1): NOT pushed.** Title unchanged. Short and full description are the 1 Nov pre-release text (policy fixes: one alternate spelling, no web-app line, softened ad, pins and moderation claims; ~/ops-routines/reports/tablamigo-android-prerelease-2026-11-01.md) plus three search phrases ("travel buddy", "meet travelers", "Table Amigo" in the first line) and small trims. en-IN and the new en-GB use "Tablamigo: Solo Travel Buddy". Report with the paste-ready text, screenshots and feature graphic: ~/ops-routines/reports/tablamigo-aso-2026-11-01.md. Push all four with `node infra/play/listing.mjs --no-video en-US en-IN en-GB hi-IN` (the promo video still says the app is completely free).
>
> **Status, 22 Oct 2026:** live on Google Play for en-US, en-IN and hi-IN, without the promo video (it says "abhi bilkul free hai", false since 10 Oct). The 22 Oct push changed only the short description in all three locales, so it now leads with "Tablamigo" (Google India corrects the brand query to "tab amigo"); the full text is the 11 Oct text below, which describes production 1.2.2 (versionCode 11). Push with `node infra/play/listing.mjs --no-video en-US en-IN hi-IN`.
>
> **Earlier status, 11 Oct 2026 (branch `seo/wave1`):** The short and full descriptions below add the "travel partner / travel companion" search words (audit ASO-T3) and correct two claims against the code: contact details are held back in city chats for everyone, and in DMs unless you have Plus or share a plan (`apps/api/src/lib/chat-gate.ts`), and live location in a chat does show your position, so "your exact location is never shown" is gone. The closing line reads "Made by Hookstep, India" (no city). Live on Google Play is still the 10 Oct text (`git show 7663438:store/play-listing.md`, 3,955 characters, byte-identical to the live page on 11 Oct). Source of truth for the pushed text is this file (en-US), `store/play-listing.en-IN.md` and `store/play-listing.hi-IN.md`.
>
> **To push** (listing text only, no release; it refuses if anything is in review, and it checks every limit before it sends anything): `node infra/play/listing.mjs en-US en-IN hi-IN` from the repo root. With no arguments it pushes en-US only. `--no-video` leaves the promo video out (use it if Play rejects the video). The Play listing's default language is en-US; en-IN and hi-IN are new, and users whose device is set to English (India) or Hindi see them, everyone else sees en-US. Graphics are not localised, so all three use the en-US screenshots.
>
> **What's new:** the live release notes (1.2.0, 4 Oct) still open with "Tablamigo is now completely free: every feature, no ads, nothing to buy", which has been false since Plus went back on sale on 10 Oct. Release notes change only with a new release. The "What's new" section below is the corrected text; `node infra/play/upload.mjs <aab> <track>` attaches it (en-US) to the release it creates. Add that release's own changes to it before promoting the release to production in Play Console.

## App name (30 max)
Tablamigo: Meet Solo Travelers

## Short description (80 max)
Tablamigo (Table Amigo): meet solo travelers nearby and join their plans

## Full description (4000 max)
Solo tonight? Join a plan near you.

Tablamigo (Table Amigo) is a travel buddy app for solo travel: backpackers, digital nomads and anyone exploring alone. Open the map to see what travelers near you are doing, like dinner tonight, sunset drinks, a hike tomorrow or a coworking session, and join with one tap. Or post your own plan and let people come to you.

No swiping, no endless small talk: real plans, nearby, happening soon. Looking for a travel buddy, a travel partner or a companion for the day? Post a plan and travelers nearby can join you. An easy way to meet travelers and make travel friends while traveling alone.

How it works
• Open the map: plans near you by day, with who's going and how far away
• Tap Join and you're in the plan's group chat
• Or post "I want to…" in seconds and let travelers nearby join you
• Sort the details in the chat, meet somewhere public

Plans and meetups for solo travel
• Dinners, drinks, nightlife, exploring, outdoors, culture, sports and coworking
• "Popular" and "Almost full" tags show what's filling up
• Few plans nearby? Plan ideas for your city can appear as pins on the map: tap one, it fills in, you pick a time
• Share a plan with a link, or leave it if plans change

Chat
• A group chat for every plan, plus direct messages
• Reply, react and see who has read it
• Polls to pick the time or the place
• Share your live location in a plan chat or direct message for 15 minutes, 1 hour or 8 hours; it stops by itself

Trips and city chats
• Add your next trip and see which travelers will be in the same city on the same dates; switch trip match alerts on or off in your profile
• Join the city chat and talk to travelers arriving soon
• Digital nomads: add your next base, then post a coworking session

Travelers nearby
• See which solo travelers are around and filter by age
• Profiles show languages spoken and countries visited

For solo female travelers
• Women-only plans: hosted by women, seen and joined only by women
• See who has passed the selfie check before you meet

Safety
• 18+ only
• Other travelers see a distance rounded to 0.5 km, not your location, unless you share live location in a chat
• Selfie check: your selfie is compared with your profile photo; a match earns a green tick. It's not an ID check, so meet in public
• Messages in plan and city chats, and poll questions, go through automated moderation
• Phone numbers, emails and social handles are held back in city chats, and in direct messages unless you have Plus or you share a plan
• Report or block anyone from their profile; every report goes to our team
• Snooze to hide from the map and Travelers list without deleting anything
• Not a dating app: plans are for food, drinks, sightseeing, sport and coworking

Free to use, with optional Plus
Free accounts see one small ad in the plan list (none with Plus) and can join any plan, post 2 plans a day, chat in every plan, start 1 new direct-message conversation a day, see travelers nearby, join city chats for the next 3 days and see 3 trip overlaps. Safety features are free on every account.

Tablamigo Plus is optional and adds:
• Up to 20 plans a day
• 200 AI plan ideas a day
• Everyone overlapping your trips
• City chats up to a year ahead
• See who viewed your profile
• Unlimited new direct messages, with phone numbers, emails and social handles allowed
• 6 profile photos, unlimited buddy requests and advanced filters

Plus is a Google Play subscription (weekly, monthly, 6-month or yearly). Google Play shows the price in your currency before you pay; cancel in Google Play → Payments & subscriptions.

Tablamigo is new, so the map is busiest in popular solo travel cities. Nothing near you? Post a plan and the next traveler nearby will see it.

Sign in with Google or email.

Made by Hookstep, India. Questions: support@hookstep.in
Terms: https://tablamigo.hookstep.in/terms
Privacy: https://tablamigo.hookstep.in/privacy

## What's new (500 max)
New: nothing near you yet? See the nearest cities with plans, start one for your city in one tap, or get a ping when someone nearby posts.
• Sign in faster with Google
• Choose to get notified about trips to your city and replies
• Snooze your account instead of deleting it

## Promo video (YouTube URL)
https://www.youtube.com/watch?v=7INyG9IPu8g

## Graphics
- App icon 512×512: `store/icon-512.png`
- Feature graphic 1024×500: `store/feature-graphic.png`
- Phone screenshots (min 2, 1080×2400): `store/screenshots/`

## Subscription setup (Monetize → Subscriptions)
Product ID **`tablamigo_plus`** (must match exactly — the app and server look for it), name "Tablamigo Plus". Four base plans, all auto-renewing:

| Base plan ID | Period |
|---|---|
| `weekly` | 1 week |
| `monthly` | 1 month |
| `halfyearly` | 6 months (added 2 Nov 2026 by `infra/play/add-halfyearly.mjs`) |
| `yearly` | 1 year |

Prices are set in Play Console and are not recorded here; Plus is on sale again from 10 Oct 2026 (the server's ALL_FREE is off) and the site and listing text quote no Google Play price. Grace period: 7 days. Optional: a 3-day free trial offer on `weekly`.

## App content answers
- **App access:** "All functionality is available with a login." Add credentials from `credentials/play-review.txt` (email + fixed 6-digit code; instructions: enter the email, tap Continue, enter the code).
- **Ads:** Yes, from 1.4.0 (versionCode 13): one Google AdMob banner at the end of the Explore plan list, free accounts only.
- **Content rating (IARC):** Category "Social / Communication". Users can interact/communicate: Yes. Shares user location with other users: Yes (approximate). Digital purchases: Yes. No violence, sexual content, gambling or drugs in the app itself. Expected rating: Teen / PEGI 12 (UGC).
- **Target audience:** 18 and over only. Not designed for children.
- **Data safety:** don't re-enter it from this file. The answers, row by row with the code behind each, are in `store/data-safety-1.3.0.md`. The earlier list that stood here ("Crash logs" collected, "Shared with third parties: None") is wrong and would undo the live form.
  - **What the public Play page showed on 11 Oct 2026** (https://play.google.com/store/datasafety?id=com.tablamigo.app, read without logging in): *Shared:* Approximate and Precise location (App functionality); In-app search history (App functionality). *Collected:* Contacts; Purchase history; Approximate and Precise location (App functionality, Personalisation); Device or other IDs; App interactions (App functionality, Analytics); In-app search history; Other user-generated content; Other actions; Other in-app messages; Name, Email address, User IDs, Phone number, Other info; Diagnostics; Photos. Encrypted in transit: Yes. Deletion can be requested: Yes. No Crash logs row.
  - **To verify in Play Console (the form itself needs a Console login; only the public page was read):** the public page differs from `store/data-safety-1.3.0.md` on a few details, so check which one is intended before the next edit: Location purposes include Personalisation (the doc says App functionality only); Device or other IDs shows as optional (the doc says required); Purchase history and Other in-app messages show no Fraud prevention purpose (the doc lists it). The public page does not show required/optional for every row or the ephemeral flags.
- **Account deletion URL:** https://tablamigo.hookstep.in/delete-account
- **Child safety standards (required for social apps):** URL https://tablamigo.hookstep.in/child-safety · point of contact support@hookstep.in
- **Government app / financial features / health:** No.

## Countries
Recommended first wave: United States, United Kingdom, Canada, Australia, Ireland, New Zealand, Germany, Netherlands, Spain, Portugal, France, Italy, Brazil, Mexico, Argentina, Colombia, Thailand, Indonesia, Vietnam, Philippines, Malaysia, Japan, South Korea, UAE, Nepal, Sri Lanka. India is your call (see report).
