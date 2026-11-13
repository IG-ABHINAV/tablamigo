# Tablamigo: testing

Two halves: **automated suites** that run on every push and pull request (`ci.yml`) and weekly, and the **team test plan** further down (three people, three phones) for what only a real phone shows.

## Automated suites

Every suite runs against a throwaway local database and fakes every outside service (Resend, OpenAI, Razorpay, Google Play, FCM, Web Push, geocoding). Nothing writes to production.

No API test process reaches the internet: `apps/api/src/tests/network-guard.ts` (installed by both vitest setup files) answers Nominatim from a fixed table of cities (nearest within 50 km, else "Unable to geocode") and Photon with no places, and refuses any other non-local `fetch` or TCP/TLS connection with an error naming the host. A test that needs an outside answer stubs `fetch` or mocks the client itself. The server the e2e and scenario layers start gets its fakes from `src/scripts/e2e-preload.ts`, and the web-app browser pass serves a stub Google sign-in script instead of loading `accounts.google.com`.

| Layer | What | Where | Run it |
|---|---|---|---|
| API unit | pure functions, config boot guard, moderation fail-open, migrations, prices/limits/retention said the same way in the API, website, Play listing and app, error codes with app copy | `apps/api/src/tests/unit` | `npm --workspace apps/api run test:unit` |
| API integration | the Fastify app in-process (`app.inject`) on PostGIS: every route family, 615 older tests in `apps/api/src/*.test.ts` plus `apps/api/src/tests/integration` (sign-in codes and sessions, billing webhook auth, SOS, seat races and polls, admin routes, AI ideas, email preferences, who gets a push and gone FCM tokens, the owner's sale alerts on every Razorpay and Play path) | `apps/api/src` | `npm --workspace apps/api run test:integration` |
| API e2e | the real server process (`src/main.ts`) over HTTP and WebSocket (including the owner's sale alerts from a forwarded webhook and an RTDN push, and an email outage: creating `<MAIL_CAPTURE_FILE>.down` makes every send fail), and the AI engagement worker (acts on the whole DB, so it runs alone, after integration) | `apps/api/src/tests/e2e` | `npm --workspace apps/api run test:e2e` |
| API scenarios | 48 multi-account cases of the team plan below, over HTTP, emails captured | `apps/api/src/scripts/e2e-scenarios.ts` | `DATABASE_URL=$E2E_DATABASE_URL npm --workspace apps/api run test:scenarios` |
| Website | `build.py` + `check.py`; build facts (`test_site.py`, including which pages carry Google AdSense, ads.txt built, the privacy policy's ad wording); the Play-link script and the AdSense loader in a fake browser (`play-links.test.mjs`, `ads-loader.test.mjs`: first interaction, consent-country gate, production host only); every page in Chromium at phone and desktop width (`browser-smoke.mjs`); AdSense end to end on the production builds of the site and the web app (`ads-browser.mjs`: a guide loads Google's ad script after a scroll or tap, EEA/UK/CH and unknown countries get none, the home, download, legal, safety and comparison pages, thin guides and `/app/` never do) | `apps/web/tests` | see below |
| App unit | `src/lib` and `components/format.ts` with node:test (API client refresh, socket, session, links, copy; native-only libs with the Expo modules stubbed: camera-only verification selfie, photo uploads, FCM registration, push banners and taps, report reasons and targets = the API's, Google Play purchases verified from app start; AdMob: the build switch and ids, who sees the banner, the consent gate with a fake consent SDK, and `expo config` resolving the ads plugin only for an `ADS_ENABLED=on` build) | `apps/mobile/tests/unit`, `apps/mobile/e2e-web/*.test.mjs` | `cd apps/mobile && npm run test:unit` |
| Web app browser pass | about 100 steps per screen size over personas at 1440x900 and 390x844 (plus the admin panel), against a local Expo web export and a local API | `apps/mobile/e2e-web` | see below |
| Native app | Maestro flows for native-only paths (sign-in, onboarding, MapLibre plan, chat and poll, camera-only selfie, Play paywall view, deep links) | `apps/mobile/maestro` | local only, see below |
| Home page demo video | build facts in `test_site.py` (`DemoVideo`: AV1/Opus WebM at the level its type names, faststart H.264 MP4, posters at the video's size, content-hashed names that match the bytes, size budgets, the transcript = the captions) and `check.py` (markup, VideoObject, the figures the video states); `video-browser.mjs` in Chrome: no video byte before play on a phone or desktop (load or scroll), the right cut's poster, no layout shift, the MP4 when the WebM does not load (Safari's path), every file a 404, slow 3G, no JS; | `apps/web/tests` | see below |

### The test database (read this first)

The suites delete and rewrite rows, so `apps/api/src/test-db-guard.ts` refuses to run unless `DATABASE_URL` is set explicitly, points at localhost (or a host in `TEST_DB_HOSTS`), is not on port 5434, and names a database with `test` in it. There is no override. A Cloud SQL proxy to another company's production database once listened on 5434 on this Mac, which is also the API's default port, so never rely on the default. The web-app browser pass applies the same guard to `E2E_DATABASE_URL`, which it requires. Tests never read `apps/api/.env`.

```
bash apps/api/scripts/test-db.sh up        # docker postgis on 127.0.0.1:5499: tablamigo_test, tablamigo_e2e_test, tablamigo_browser_test, migrated
export DATABASE_URL=postgres://tablamigo:tablamigo-test@127.0.0.1:5499/tablamigo_test
export E2E_DATABASE_URL=postgres://tablamigo:tablamigo-test@127.0.0.1:5499/tablamigo_e2e_test
export BROWSER_DATABASE_URL=postgres://tablamigo:tablamigo-test@127.0.0.1:5499/tablamigo_browser_test
bash apps/api/scripts/test-db.sh reset     # clean slate;  ... down   removes the container
```

Node 24 (`nvm use 24`): the realtime tests need Node's built-in WebSocket (Node 22+).

**Dates in tests:** when the code under test compares with Postgres `current_date`, take "today" from the database (`current_date` in the insert, or `select current_date::text`), never `new Date().toISOString().slice(0, 10)`. `current_date` follows the database's time zone (the runner's zone on CI, ahead of UTC and by its failure hours IST; UTC in the local Docker container), so a UTC date from JS can be a day off. To check a test, run it against a copy of the test database whose clock is a day ahead or behind: `create database tablamigo_tzahead_test template tablamigo_test; alter database tablamigo_tzahead_test set timezone = '<+21>-21'` (behind: `'<-11>+11'`).

### Commands

On this Mac, run each one through `~/.local/bin/heavy` (one build or test at a time across every session; parallel builds rebooted the Mac twice on 22 Oct) and give vitest `--maxWorkers=2`, e.g. `~/.local/bin/heavy npx vitest run --project integration --maxWorkers=2` in `apps/api`.

```
# API: all three layers in order (unit, integration, then e2e alone)
npm ci && npm --workspace apps/api test
# the 48 scenario cases (they count emails, so they get their own database)
DATABASE_URL=$E2E_DATABASE_URL npm --workspace apps/api run test:scenarios

# Website
python3 apps/web/build.py && python3 apps/web/check.py
python3 -m unittest discover -s apps/web/tests -v
node --test apps/web/tests/play-links.test.mjs apps/web/tests/ads-loader.test.mjs
PLAYWRIGHT_FROM=<folder with node_modules/playwright> node apps/web/tests/browser-smoke.mjs
# AdSense end to end: needs the web app's production export too; CI reuses the browser pass's export
(cd apps/mobile && env -u EXPO_PUBLIC_API_URL npx expo export -p web --output-dir web-build)
PLAYWRIGHT_FROM=<folder with node_modules/playwright> node apps/web/tests/ads-browser.mjs   # APP_DIR=<export> to use another one

# App
cd apps/mobile && npm ci && npm run typecheck && npm run test:unit

# Web app in a real browser (exports the web app, starts a local API with faked outside services)
# Its own database: it leaves @qa.test personas behind, and in the scenarios' database the scheduler would email them
# and fail "Second scheduler runs send nothing new". run.sh reads the URL from E2E_DATABASE_URL.
E2E_DATABASE_URL=$BROWSER_DATABASE_URL PLAYWRIGHT_FROM=<folder with node_modules/playwright> bash apps/mobile/e2e-web/run.sh both
#   desktop | mobile | both, then optional scenarios: run.sh mobile bangkok,realtime
#   ADMIN_HTML=$PWD/apps/web/src/admin.html adds the admin panel; E2E_SKIP_EXPORT=1 reuses the last export
#   screenshots of failures land in apps/mobile/e2e-web/out/shots; it uses the installed Google Chrome (E2E_BROWSER_CHANNEL=chromium for Playwright's)

# Home page demo video in Chrome (CHROME_CHANNEL=chrome for H.264; Playwright's Chromium otherwise)
CHROME_CHANNEL=chrome PLAYWRIGHT_FROM=<folder with node_modules/playwright> node apps/web/tests/video-browser.mjs

```

Playwright: `npm i --prefix <dir> playwright@1.56.1 && npx --prefix <dir> playwright install chromium`, then `PLAYWRIGHT_FROM=<dir>`.

### Native app: Maestro flows (local only)

No device runs in CI. On an emulator with a release-variant APK built against a local API (`EXPO_PUBLIC_API_URL=http://10.0.2.2:4100`, the API's `REVIEW_EMAILS` listing the address below):

```
maestro test --env EMAIL=qa1@review.test --env CODE=<REVIEW_CODE> apps/mobile/maestro
```

The flows find buttons by their visible text (the app has no testIDs; the chat's two icon buttons have accessibility labels "Attach" and "Send message"). The flows were written from the screens' source and have not been run on a device yet; fix a selector the first time a flow can't find it. Push delivery and a notification tap still need the phone checklist below (section 7).

### CI on every push and pull request: `.github/workflows/ci.yml`

- **Where:** GitHub-hosted `ubuntu-latest`. No repository secrets: everything outside is faked or public. Pull requests from forks run after a maintainer approves the first run.
- **Jobs:** API (migrations from zero twice, typecheck, `npx vitest run`: unit, integration, e2e, on a `postgis/postgis:16-3.4` service container), website (`build.py`, `check.py`, unittest, node tests), app (typecheck, unit). The scenarios and the browser passes run locally (commands above).

### Bugs the suites found (22 Oct 2026), fixed with their tests un-skipped

No test is skipped. A test written for a bug that is not fixed yet is skipped with the reason in it, and un-skipped in the change that fixes it.

| Test | Bug, and the fix |
|---|---|
| `tests/integration/plans-race-and-polls.test.ts` "six people tap Join on the last two seats" | concurrent joins overbooked a full plan: the seat count came from before the row-lock wait. `lib/plans.ts` counts after the lock (`lockPlanForJoin`), for join, RSVP and tickets |
| `tests/e2e/ai-engagement.test.ts` "women-only plans only ever get a woman" | the engagement worker inserted memberships directly. It now joins through `assertCanJoin`, the join route's own rules |
| `tests/integration/ai-suggest.test.ts` "a reply that is not JSON" | a non-JSON model reply was a 500; now `ai_failed`, and the idea is given back |
| `tests/integration/billing-webhooks-auth.test.ts` "production refuses an unauthenticated RTDN post" | RTDN accepted any post with neither RTDN variable set. Production refuses the post and refuses to start without one |
| `tests/unit/error-copy.test.ts` "a mistyped invite code" | `invalid_code` had no app copy, so a wrong invite code read as a server error |
| `tests/integration/plans-race-and-polls.test.ts` "someone leaves a full plan with a waitlist while someone else taps Join" | the leave deleted the seat and promoted from the waitlist in separate statements with no plan lock, so a Join in between put the plan one over. The leave and the promotion now run in one transaction under `lockPlanForJoin`, and promote only into a free seat |
| `tests/e2e/ai-engagement.test.ts` "a plan the worker has joined is free for a person" | the worker kept every plan it joined row-locked until its one transaction ended, through up to 9 more OpenAI calls. Each join and each reply is now its own short transaction after its OpenAI call |
| `tests/integration/auth-codes.test.ts` "when the email provider fails", "failing sends count toward the 5 codes an hour" | a code whose email failed to send stayed guessable and gave its hourly-cap place back. `unsendLoginCode` now withdraws it (the previous code, if unexpired, is current again) and the failed send still counts |
| `tests/integration/ai-suggest.test.ts` "a list with no usable idea" | an ideas list where every idea lacked a title or place returned nothing and still cost an idea; now `ai_failed`, and the idea is given back |
| `apps/mobile/tests/unit/play-billing.test.mjs` | Play purchases were only listened for while the paywall was open, so a UPI payment that settled later was never verified and Google refunds it after 3 days. `lib/play-billing.ts` listens from the tabs (signed in, anything for sale) and verifies unacknowledged purchases at each start |

---

# Team test plan

Three people, three phones: **A** (woman), **B** (man), **C** (any). Sign up with your own email; there's no password, the app emails a 6-digit code. Report bugs with a screenshot, the phone model and the time to support@hookstep.in.

Install from the download page (https://tablamigo.hookstep.in/download) or, to test payments, from the Play testing link (you must be on the tester list, then open https://play.google.com/apps/internaltest/4701297362276400647).

## 1. Sign-up and profile (everyone)
- [ ] Sign up: email → code arrives → name, birthday, gender, country, interests, photo, location.
- [ ] Try a birthday under 18: it must refuse.
- [ ] Edit bio and photo; interests must stay as they were.
- [ ] Add countries visited; the flags show on your profile.
- [ ] Log out and back in: everything is still there.

## 2. Plans (A hosts, B and C join)
- [ ] A posts a plan with a place, a time and a limit of 3 people.
- [ ] B and C see it on the map and in the list; they tap it and join.
- [ ] The group chat opens for all three; "X joined" messages appear.
- [ ] A fourth join is refused when the plan is full.
- [ ] A posts a **women-only** plan: B (man) must not see it; A can.
- [ ] A closes a plan to new people: C (not yet in it) can't join, members still chat. A reopens it.
- [ ] A cancels a plan: everyone in it gets told.
- [ ] Idea cards: on an empty area, tap an idea and the new-plan form is prefilled.

## 3. Chat (all three in one plan)
- [ ] Messages arrive instantly on the other phones; the typing indicator shows.
- [ ] Send a photo.
- [ ] Create a poll (2-6 options); everyone votes, changes vote, counts update live.
- [ ] Share live location for 15 min: others see the pin move as you walk; "Stop sharing" ends it.
- [ ] City chat: live location must not be offered there.
- [ ] Send an abusive message in a group chat: it must be blocked.
- [ ] DM: open someone's profile → Message.

## 4. Trips
- [ ] Add a trip to the same city and overlapping dates on two phones: each sees the other under "travelers during these dates".
- [ ] The trip screen shows the countdown and the "city chat" button.
- [ ] Trending cities show dates and faces.

## 5. Travelers, profile views, thumbs-up
- [ ] Travelers list: the age filter chips work.
- [ ] Open each other's profiles: "Profile views" goes up (names hidden for free accounts, shown for Plus).
- [ ] After a plan's start time: give each other a thumbs-up; the count shows on the profile.
- [ ] Snooze for 24 hours: you disappear from the others' Travelers list and map, Undo brings you back.

## 6. Safety
- [ ] Report someone (long-press a message, or the ••• on a profile or plan) with each of the 6 reasons.
- [ ] Block someone: you disappear from each other's map, lists and chats.
- [ ] Get verified: take the selfie with the head pose shown (camera only, no gallery). It says "Checking…" and is approved or rejected with a reason within a few seconds; 5 tries a day.

## 7. Notifications (phones locked)
- [ ] Someone joins your plan → push notification.
- [ ] New chat message → push; tapping it opens the chat.
- [ ] The 🔔 inbox on the map lists joins, thumbs-ups, profile views and verification results.

## 7b. Free-tier limits (free accounts, not in any plan together)
These limits only apply when the API runs with `ALL_FREE=false`. While the app is fully free (the default), every account is treated as Plus and none of this is shown.
- [ ] A messages B (a stranger): 3 messages go through, the 4th opens the "Give B a moment to reply" sheet.
- [ ] A opens C's profile the same day and taps Message: the "used today's free new chat" sheet opens.
- [ ] B replies to A: both can now chat without limits.
- [ ] A sends a phone number (also "nine eight seven…", "insta: abc", an email) in a DM or the city chat: it isn't sent and the safety sheet explains why. The same number in a plan group chat goes through.
- [ ] A and B join the same plan: DMs between them have no limits and numbers can be shared.
- [ ] A adds a trip where more than 3 people overlap: the "N travelers will be in <city>" Trip Pass sheet opens.
- [ ] A Plus account shows a PLUS tag in Travelers and ranks above free people at a similar distance.

## 8. Payments (maintainers only, Play testing link, only when `ALL_FREE=false`)
The app is currently fully free and sells nothing, so skip this section unless paid plans are switched back on.
Testers on the license-testers list pay with Google's **test card** (no real money).
- [ ] Buy Plus **weekly**: Plus unlocks (profile viewers, 20 plans a day, city chats early).
- [ ] Test subscriptions renew every few minutes: Plus stays on.
- [ ] Cancel in Google Play → Subscriptions: Plus stays until the period ends, then turns off.
- [ ] Buy a **Trip Pass**: 14 days of Plus, no renewal. Buy it again: the days add up.
- [ ] Refund the pass (Play Console → Order management): Plus turns off within a minute.

## 9. Delete account
- [ ] Profile → Delete account: you're signed out, your plans and messages disappear for the others, and signing up again starts fresh.
