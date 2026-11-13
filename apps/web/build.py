#!/usr/bin/env python3
"""Builds the static site: wraps every src/*.html fragment in the shared shell.

Each fragment starts with comment lines (the first block, before a blank line):
  <!-- title: Page title -->               required, under 60 characters
  <!-- description: One sentence -->       required, 70-155 characters
  <!-- crumb: Name -->                     BreadcrumbList (+ FAQPage when the page has <details> questions)
  <!-- parent: Name | /path -->            a middle breadcrumb level
  <!-- type: article -->                   Article markup, og:type article and a visible "Updated" date
  <!-- type: about -->                     AboutPage markup
In the body, <!-- whatis --> becomes the shared "What is Tablamigo?" definition, <!-- cities --> the list
of every city guide, <!-- cities-in: IN --> the guides for one country and <!-- women-dorms --> the table of female-only dorms checked in
the India guides.
<!-- play-badge: hero --> becomes the official Google Play badge linking to the listing, and {{play_url:faq}} the bare
listing URL. The word after the colon is the placement: it goes into the install referrer as utm_medium, so Play
Console's acquisition report shows which link sent each install.
Output goes to dist/, served by nginx with `try_files $uri $uri.html`.
Deployed by the CI/CD deploy job (.github/workflows/ci.yml) after a green push to main; infra/deploy.sh web is the fallback.
"""
import os, pathlib, re, shutil, datetime, json, hashlib, html as H
from urllib.parse import quote, urlsplit

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"
# TABLAMIGO_WEB_DIST builds somewhere else (a temp dir for checks and screenshots); deploy uses dist/.
DIST = pathlib.Path(os.environ["TABLAMIGO_WEB_DIST"]).resolve() if os.environ.get("TABLAMIGO_WEB_DIST") else ROOT / "dist"
SITE = "https://tablamigo.hookstep.in"
PLAY = "https://play.google.com/store/apps/details?id=com.tablamigo.app"  # the public Google Play listing
# Google's official "Get it on Google Play" badge (English), self-hosted so no page waits on a third-party host. It was
# downloaded once on 6 Oct 2026 from play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png
# (646x250, with Google's required clear space) and converted to lossless WebP: pixel-identical, unmodified artwork.
PLAY_BADGE_IMG = "/play-badge-en.webp"
PLAY_TM = "Google Play and the Google Play logo are trademarks of Google LLC."
DOWNLOAD = SITE + "/download"
# Pages the Android app opens (Profile: Privacy policy, Terms; Play Console: delete-account URL). Their menu has no Plus link, which leads to the web prices.
NO_PLUS_LINK = {"privacy.html", "terms.html", "delete-account.html"}
# PRICING (from 10 Oct 2026): Tablamigo is free to use with limits, and Plus is an optional paid upgrade. THIS IS THE ONLY PLACE
# Tablamigo's rupee prices and the free/Plus limits are written down. Pages use tokens: {{price_short}} (a table cell),
# {{price_line}} (one sentence), {{price_note}} (that sentence plus how each store bills, which is {{price_more}}), {{free_limits}}, {{plus_adds}},
# {{plus_month}}, {{plus_year}} and {{trip_pass}}. llms.txt, llms-full.txt and the app's schema offers read the same constants, and
# check.py fails the build if a page hard-codes a Tablamigo price. The rupee prices are what the website and web app charge through
# Razorpay. The Android app sells Plus through Google Play, which shows the price in the buyer's currency: no Google Play price is
# written anywhere on the site, because none is recorded where we can verify it. Never promise "free forever" or "always free".
PLUS_MONTH_INR, PLUS_YEAR_INR, TRIP_PASS_INR = 499, 3999, 299
rupees = lambda n: f"\u20b9{n:,}"
PLUS_MONTH, PLUS_YEAR, TRIP_PASS = rupees(PLUS_MONTH_INR), rupees(PLUS_YEAR_INR), rupees(TRIP_PASS_INR)
PRICE_SHORT = f"Free; optional Plus {PLUS_MONTH} a month or {PLUS_YEAR} a year on the web, Google Play price in the app"
# ADS IN THE ANDROID APP (20 Oct 2026, AdMob). The Android app can show free accounts one Google AdMob banner, at the end of the
# Explore tab's list of plans, but only in a build made with ADS_ENABLED=on (apps/mobile/ads-env.js); Plus never sees ads, and the
# web app has none. The site describes the app people can install, so this says whether such a build is LIVE ON GOOGLE PLAY, which
# is a different fact from the app's build flag. Set it to True in the same sitting as that release, never before
# (PLAY-DATA-SAFETY-ADS.md at the repo root). It switches the "no ads" wording on the homepage, llms.txt, the partnerships page
# and the privacy policy (ADS_COPY below), and check.py holds each state to its words. The website's own ads (Google AdSense on
# the guides) are a separate switch, ADSENSE_ON, further down.
ANDROID_ADS_LIVE = True
# "the app has no ads", not "with no ads": the sentence is printed on guides that carry the website's own ads (ADSENSE_ON).
PRICE_LINE = ((f"Tablamigo is free to use; in the Android app, free accounts see one ad banner. Plus is optional and has no ads: "
               f"{PLUS_MONTH} a month or {PLUS_YEAR} a year on the web, or a Google Play subscription in the Android app.")
              if ANDROID_ADS_LIVE else
              (f"Tablamigo is free to use, and the app has no ads. Plus is optional: {PLUS_MONTH} a month or {PLUS_YEAR} a year on the web, "
               "or a Google Play subscription in the Android app."))
PRICE_MORE = (f"On the website and web app you pay through Razorpay, in rupees: Plus renews automatically each month or year until you cancel, "
              f"and a {TRIP_PASS} Trip Pass gives 14 days of Plus once, with nothing to renew. In the Android app, Plus is a Google Play "
              "subscription (weekly, monthly, 6-month or yearly), billed and cancelled in Google Play, which shows the price in your currency before you pay.")
PRICE_NOTE = PRICE_LINE + " " + PRICE_MORE
FREE_LIMITS = ("joining any plan, posting 2 plans a day, a group chat in every plan, 1 new direct-message conversation a day, travelers nearby, "
               "city chats for the next 3 days, 3 people overlapping your trips and 3 AI plan ideas a day")
PLUS_ADDS = ("up to 20 plans a day, 200 AI plan ideas a day, everyone overlapping your trips, city chats up to a year ahead, who viewed your profile, "
             "unlimited new direct messages, sharing phone numbers, emails and social handles in direct messages, 6 profile photos, unlimited buddy requests "
             "and advanced filters")
SAFETY_FREE = ("Women-only plans, selfie verification, report and block, and AI moderation of group and city chats are free on every account.")
APK = json.loads((ROOT / "apk.json").read_text()) if (ROOT / "apk.json").exists() else {}
APP = "Tablamigo"
LAUNCHED = "2026-09-29"

# IST (+05:30), the zone this site is operated in, for the JSON-LD datetimes below.
SITE_TZ_OFFSET = "+05:30"
# A full ISO 8601 datetime with a zone: what schema_datetime() must produce and
# check.py holds every emitted value against.
SCHEMA_DATETIME_RE = r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})"


def schema_datetime(value):
    """An authoring date (YYYY-MM-DD) as the instant JSON-LD publishes: midnight IST. An instant is passed through.

    Google reads datePublished, dateModified and uploadDate as DateTime and will not guess a zone for a bare
    date, so it rejects one outright. On 25 Oct 2026 Search Console reported exactly that against a sibling
    site's VideoObject - "Datetime property 'uploadDate' is missing a time zone" and "Invalid datetime value
    for 'uploadDate'" - for the value "2026-10-25". Every date on this site is authored as a plain date
    (DEMO_UPLOADED, LAUNCHED, lastmod.json), which is right for a <time datetime> attribute and for a
    sitemap <lastmod>; the conversion happens here, once, on the way into the graph."""
    return f"{value}T00:00:00{SITE_TZ_OFFSET}" if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value or "") else value
FIRST_PUBLISHED = "2026-09-28"  # the day the site and its first pages went live (git history)
# IndexNow (Bing, Yandex, Seznam, Naver...): the key file is published at /<key>.txt; indexnow.py pings with it.
INDEXNOW_KEY = "5d948c79bf343e479756196a0cf32d06"
# Plus Jakarta Sans (SIL OFL) is self-hosted from /fonts and declared in style.css with font-display: optional, so text
# never reflows when the font arrives (no layout shift on any page). It is NOT preloaded: Chrome holds the first paint for a
# preloaded optional font, which put the font's own connection (fonts are fetched in CORS mode, so not on the page's
# connection) in front of FCP and LCP. Without the preload the first visit paints in the fallback font and the font is
# cached for the next page (audit TM-03, 11 Oct 2026).
OG_IMAGE = SITE + "/og.png"  # 1200x630

# One definition, used on key pages, in llms.txt and in the app schema, so every engine reads the same facts. It opens with
# "Tablamigo is a solo-travel app" on purpose (22 Oct 2026): Google India still corrects the brand query "tablamigo" to "tab amigo",
# and the name, written as one word next to what it is, is the entity signal every page and llms.txt repeat. The home page lead and
# About open with the same words (src/index.html, src/about.html).
DEFINITION = ("Tablamigo is a solo-travel app for meeting people nearby. Solo travelers and digital nomads post plans "
              "such as dinner, drinks, day trips or coworking on a map, and others nearby join with one tap and talk in "
              "the plan's group chat.")
WHATIS = ('<div class="callout whatis"><p><strong>What is Tablamigo?</strong> ' + DEFINITION + ' It launched on '
          '29 September 2026, <span class="desktop-only">runs on Android and in any web browser (including iPhone)</span>'
          '<span class="ios-only">runs in Safari on iPhone and iPad as a web app</span><span class="android-only">runs on Android</span>, is free to use '
          'with an optional Plus subscription, and is made by Hookstep in Mumbai, India. <a href="/about">About Tablamigo</a></p></div>')

# Hookstep, the company. It has no logo here on purpose: Tablamigo's icon belongs to Tablamigo (below), not to Hookstep.
# Pages and listings name the operator "Hookstep" and nothing else (never the registered business name; check.py enforces it).
# Google Play's developer name and hookstep.in write it "HookStep" (both read 11 Oct 2026), so that casing is the
# alternateName, and the Play developer page is a sameAs: one entity, whichever casing an engine meets first.
# Its @id is the one hookstep.in gives its own Organization node, so the two sites describe one Hookstep: hookstep.in lists
# Tablamigo (by #tablamigo) as a subOrganization, and Tablamigo names that same node as its parentOrganization (25 Oct 2026).
HOOKSTEP_ORG_ID = "https://hookstep.in/#organization"
ORG = {"@type": "Organization", "@id": HOOKSTEP_ORG_ID, "name": "Hookstep", "alternateName": "HookStep", "url": "https://hookstep.in",
       "sameAs": ["https://hookstep.in", "https://play.google.com/store/apps/developer?id=HookStep"],
       "email": "support@hookstep.in",
       "address": {"@type": "PostalAddress", "addressLocality": "Ghatkopar, Mumbai", "addressCountry": "India"},
       "contactPoint": {"@type": "ContactPoint", "contactType": "customer support", "email": "support@hookstep.in"},
       "brand": {"@id": SITE + "/#tablamigo"}}
# Tablamigo as its own entity (Hookstep's brand, above), so search engines and AI answers treat the app's name as a thing in its
# own right, made by Hookstep. It is the publisher of every page and of the app. Its sameAs is the real Google Play listing (also the
# MobileApplication's installUrl); the parent company is named by parentOrganization, whose url is https://hookstep.in, not by sameAs,
# because Tablamigo and Hookstep are two entities. Its other official profiles are TABLAMIGO_PROFILES, below (audit F1,
# 11 Oct 2026: both URLs above return 200). Hookstep's own sameAs is its site and its Google Play developer page.
# TABLAMIGO_PROFILES: Tablamigo's own official profiles, and only real ones. Checked 22 Oct 2026: the Product Hunt product page below
# is ours ("Visit website" goes to this site, the owner's account is its admin). There are no social media
# accounts: youtube.com/@tablamigo and instagram.com/tablamigo were "not available", x.com/tablamigo and linkedin.com/company/tablamigo
# returned 404, and the owner promotes Tablamigo from his personal accounts on purpose. Never add a profile that doesn't exist or isn't
# ours (a personal account, or the YouTube channel a promo video sits on, is not a Tablamigo profile). Each one added here goes into the Organization's sameAs and
# into llms.txt's facts; check.py enforces that sameAs is the Play listing plus exactly this list.
TABLAMIGO_PROFILES = ["https://www.producthunt.com/products/tablamigo"]
PROFILE_SITES = {"www.producthunt.com": "Product Hunt"}  # how llms.txt names each profile's site
# Spellings people type for the brand; declared on the Organization, MobileApplication and WebSite so they resolve to one entity.
ALT_NAMES = ["Tabl Amigo", "Table Amigo", "Tablamigo app"]
TABLAMIGO_ORG = {"@type": "Organization", "@id": SITE + "/#tablamigo", "name": APP, "url": SITE + "/", "logo": SITE + "/icon.png",
                 "sameAs": [PLAY, *TABLAMIGO_PROFILES],
                 "alternateName": ALT_NAMES + ["Tablamigo Travel", "Tablamigo: Meet Solo Travelers"],
                 "description": DEFINITION,
                 "disambiguatingDescription": ("Tablamigo (one word) is a solo-travel app made by Hookstep in India for meeting other travelers "
                                               "nearby. It is not related to medicines or tablets called Amigo."),
                 "parentOrganization": {"@id": HOOKSTEP_ORG_ID}}
FEATURES = [
    "Map of plans from travelers nearby (dinner, drinks, day trips, coworking)",
    "Join a plan with one tap and get its group chat",
    "List of travelers nearby with an age filter",
    "Trips: see who will be in the same city on your dates",
    "City chats", "Direct messages", "Chat polls",
    "Live location sharing in plan chats and direct messages for 15 minutes, 1 hour or 8 hours",
    "AI plan ideas", "Women-only plans that only women can see, host or join",
    "Optional selfie verification, checked automatically",
    "AI moderation of group and city chats", "Report and block", "Distances rounded to 0.5 km"
]
SCREENS = ["01-never-eat-alone", "02-join-plans", "03-chat-vote-meet", "04-see-whos-around", "05-before-you-land", "06-overlapping-dates", "07-women-only-verified"]
# Files the pages load (font, screenshots, logo, Play badge) are also written under a content-hashed name, NAME.<10 hex>.EXT,
# and every src, srcset and CSS url() points there. nginx (infra/nginx/tablamigo) caches those names for a year as immutable;
# a changed file gets a new name, so nothing stale is ever served. The plain names stay in dist/ for links from outside
# (the press kit, the schema screenshots, old cached pages). Links (href) keep the plain names.
HASHED = ("fonts/*.woff2", "screens/*.webp", "logo-68.webp", "play-badge-en.webp", "video/*.webm", "video/*.mp4", "video/*.avif", "video/*.webp")

# DEMO VIDEO (25 Oct 2026). The owner's 50-second landscape demo (recorded 24 Oct, cut and captioned in
# ~/Desktop/hookpost-ad-2026-10-24, judged PASS by two independent reviewers on 25 Oct), on the home page under "How it works"
# (<!-- demo-video --> in src/index.html). It is the best recorded explanation of the app: the two vertical ads (14.5 s and 18.9 s)
# show one flow each. The files in video/ are encoded from the 1080p master: AV1 + Opus WebM first (Chrome, Edge, Firefox, and
# Safari on AV1 hardware), H.264 + AAC MP4 (faststart) for every other browser; 1280x720 from DEMO_MEDIA up, 960x540 on phones.
# Posters are AVIF with a WebP fallback, the frame at 2.0 s (the face and the opening question).
# Nothing of it loads before the visitor presses play: preload="none", no autoplay, and the poster is a lazy <picture> with fixed
# width and height behind the video, in a box with a fixed aspect ratio (no layout shift). No native controls until a frame plays
# (Chrome paints a grey panel over a frameless video that has them); a play button covers the poster and turns into a spinner once
# pressed. Without JS, the button is a link to the MP4 (<noscript>). Its CSS (DEMO_CSS) goes into the home page's <head> only.
# Every file gets a content-hashed name through HASHED, which nginx caches for a year; VideoObject keeps the plain names (absolute
# URLs are never rewritten), which nginx caches for 7 days. There is no video sitemap: Google indexes a video only on a page whose
# main content it is, which a home page is not.
# What it says is fixed in pixels and sound: DEMO_FACTS holds the figures it states, and check.py holds them against the constants
# here. If one of them changes, the video is wrong: re-cut it, never edit DEMO_FACTS alone.
DEMO_MEDIA = "(min-width: 700px)"  # style.css's phone breakpoint
DEMO_CUTS = {
    "wide": {"base": "/video/tablamigo-demo-720p", "width": 1280, "height": 720, "av1": "av01.0.05M.08"},   # AV1 level 3.1
    "narrow": {"base": "/video/tablamigo-demo-540p", "width": 960, "height": 540, "av1": "av01.0.04M.08"},  # AV1 level 3.0
}
DEMO_SECONDS = 50.4
DEMO_UPLOADED = "2026-10-25"
DEMO_LABEL = "Tablamigo demo: meet solo travelers nearby, in 50 seconds"
DEMO_FACTS = {"plus_month_inr": 499, "min_age": 18, "distance_km": 0.5}
# The burned-in captions, line by line (what is said), and what the screen shows where it adds something.
DEMO_TRANSCRIPT = [
    ("Travelling solo and eating dinner alone again?", None),
    ("Here's how Tablamigo works.", None),
    ("Open the map and see plans from travellers near you.", "The Explore map in the app, with plan pins."),
    ("Street food tonight, sunset drinks, a hike tomorrow.", "The list of plans nearby."),
    ("Tap Join chat, and you are in the plan.", "A plan, then its group chat."),
    ("Agree the details, run a poll for the time, and go.", "A poll for the time in the chat."),
    ("Or post your own. \u201cI want to\u2026\u201d A place or time.", "The new plan form."),
    ("No ideas? Just tap Ideas for your city.", "AI plan ideas for the city."),
    ("Add your next city and see who will be in the same city on your dates.", "A trip, and the travelers there on the same dates."),
    ("Safety built in. 18 plus only.", "The safety page."),
    ("Distance rounded to half a kilometer, women-only plans, a selfie check.", "Distances on the travelers list, the women-only switch."),
    ("Free to join, and Plus is optional.", "The Free and Plus plans on this page."),
    ("On Android, get Tablamigo on Google Play,", "The download page."),
    ("or tablamigo.hookstep.in on iPhone.", "\u201ciPhone: tablamigo.hookstep.in \u00b7 web app \u00b7 free to join \u00b7 Plus {{plus_month}}/month optional\u201d."),
]

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{description}">
<meta name="robots" content="{robots}">
{canonical}<meta property="og:type" content="{ogtype}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{og_image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Tablamigo: meet solo travelers nearby">
<meta property="og:site_name" content="{app}">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{description}">
<meta name="twitter:image" content="{og_image}">
<meta name="theme-color" content="#FF5A36">
<meta name="application-name" content="Tablamigo">
<meta name="apple-mobile-web-app-title" content="Tablamigo">
<meta name="google-site-verification" content="6K7ezp3lw1wOrx--aqzhGmYwwsZ890owWWWzQzMskvg">
<meta name="google-site-verification" content="63JhsPq5jfJEg_jPC1oLQgUa03PSm01TolWlXfOdu3g">
<link rel="icon" href="/favicon.png">
<link rel="apple-touch-icon" href="/icon-192.png">
<script>{os_js}</script>
<noscript><style>.play-badge{{display:inline-block!important}}.ios-badge{{display:inline-flex!important}}</style></noscript>
<style>{css}</style>
{extra}
</head>
<body>
<!--email_off-->
<header class="wrap nav">
  <a class="brand" href="/"><img src="/logo-68.webp" alt="" width="34" height="34">{app}</a>
  <nav class="nav-links">
    <a href="/#how">How it works</a>
    <a href="/solo-travel">City guides</a>
    <a href="/best-apps-to-meet-travelers">Compare apps</a>
    <a href="/safety">Safety</a>
    <a href="/partnerships">Partnerships</a>
    <a href="/#plus">Plus</a>
    <a class="btn small primary" href="/download">Get the app</a>
  </nav>
</header>
"""

FOOT = """
<footer class="wrap">
  <p class="foot-links"><strong>Guides</strong><a href="/solo-travel">Solo travel city guides</a><a href="/solo-travel-india">Solo travel in India</a><a href="/how-to-meet-people-while-traveling-solo">How to meet people solo</a><a href="/solo-female-travel-app">Solo female travel app</a><a href="/digital-nomad-meetups">Digital nomad meetups</a><a href="/travel-buddy-app">Travel buddy app</a><a href="/travel-buddy-app-india">Travel buddy app in India</a><a href="/solo-trip-with-strangers-india">Solo trip with strangers in India</a><a href="/solo-female-travel-india">Solo female travel in India</a></p>
  <p class="foot-links"><strong>Compare</strong><a href="/best-apps-to-meet-travelers">Best apps to meet travelers</a><a href="/nomadtable-alternative">Nomadtable alternative & competitors</a><a href="/tripbff-alternative">TripBFF alternative</a><a href="/couchsurfing-hangouts-alternative">Couchsurfing Hangouts alternative</a><a href="/timeleft-alternative">Timeleft alternative</a></p>
  <p class="foot-links"><strong>Tablamigo</strong><a href="/about">About</a><a href="/press">Press and fact sheet</a><a href="/partnerships">Partnerships</a><a href="/partners">Partner programme</a><a href="/download">Get the app</a><a href="/app/">Web app</a><a href="/safety">Safety</a></p>
  <p class="foot-play">{play}<a href="/app/">Or open the web app</a></p>
  <p class="foot-links"><strong>Products by Hookstep</strong><a href="https://hookpost.hookstep.in">Hookpost, social media scheduler</a><a href="https://hookstep.in">Hookstep, hire tech talent</a></p>
  <div class="row">
    <div>
      <a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/child-safety">Child safety</a><a href="/delete-account">Delete account</a><a href="mailto:support@hookstep.in">Contact</a>
    </div>
    <div class="made">Tablamigo is made by <a href="https://hookstep.in">Hookstep</a>, India, for solo travelers · © {year} Hookstep</div>
  </div>
  <p class="tm not-ios">{tm}</p>
</footer>
<!--/email_off-->
<script>{play_js}</script>
{one_tap}{beacon}</body>
</html>
"""

# A creator partner's link (?ref=CODE, apps/api/src/lib/affiliate-ledger.ts) sets the tm_aff cookie for 60 days; while it is set,
# every Play link carries ref=CODE in the install referrer (and utm_source=affiliate when the visit has no utm of its own), the
# One Tap sign-in sends it as ref_code, and the web app (/app/, same origin) sends it with its sign-up.
# Every Play link on the page: carry the visitor's utm_* (from an ad or a social bio link) into the install
# referrer, so Play Console attributes installs to the campaign, and on Android open the Play Store app through an
# intent link. A plain https link to Google Play often stays inside the Instagram/Facebook in-app browser instead of
# opening the store, which is where ad clicks were being lost.
# Owner's call (14 Oct 2026): every visitor arriving on /download from a Meta ad (utm_source meta/facebook/instagram)
# goes straight on to the Play Store page with a plain https link, whatever the device, so Meta's review sees exactly what
# a user sees (no device sniffing). No intent:// without a tap. location.replace keeps Back from looping.
PLAY_JS = r"""(function(){try{var q=new URLSearchParams(location.search),k=['utm_source','utm_medium','utm_campaign'],u={},s;
try{s=JSON.parse(sessionStorage.getItem('tm_utm')||'null')}catch(e){}
k.forEach(function(x){var v=q.get(x);if(v)u[x]=v});if(u.utm_source){try{sessionStorage.setItem('tm_utm',JSON.stringify(u))}catch(e){}}else if(s){u=s}
var c=(q.get('ref')||'').trim().toUpperCase();if(/^[A-Z0-9]{4,16}$/.test(c)){try{document.cookie='tm_aff='+c+';max-age=5184000;path=/;SameSite=Lax;Secure'}catch(e){}}else{try{c=(/(?:^|;\s*)tm_aff=([A-Z0-9]{4,16})/.exec(document.cookie||'')||[])[1]||''}catch(e){c=''}}
var android=/Android/i.test(navigator.userAgent);
document.querySelectorAll('a[href*="play.google.com/store/apps/details?id=com.tablamigo.app"]').forEach(function(a){
var url=new URL(a.href),r=new URLSearchParams(url.searchParams.get('referrer')||'');
if(u.utm_source){k.forEach(function(x){if(u[x])r.set(x,u[x])});r.set('utm_content',a.getAttribute('data-placement')||'link');url.searchParams.set('referrer',r.toString())}
if(c){if(!u.utm_source){r.set('utm_source','affiliate');r.set('utm_medium','partner');r.set('utm_campaign',c);r.set('utm_content',a.getAttribute('data-placement')||'link')}r.set('ref',c);url.searchParams.set('referrer',r.toString())}
a.href=url.toString();
if(android){a.href='intent://details?id=com.tablamigo.app&referrer='+encodeURIComponent(r.toString())+'#Intent;scheme=market;package=com.android.vending;S.browser_fallback_url='+encodeURIComponent(url.toString())+';end'}});
if(/^(meta|facebook|fb|instagram|ig)([_\-. ].*)?$/i.test(q.get('utm_source')||'')&&/^\/download(\.html)?\/?$/.test(location.pathname)){var rr=new URLSearchParams();k.forEach(function(x){if(u[x])rr.set(x,u[x])});rr.set('utm_content','ad_redirect');
location.replace('https://play.google.com/store/apps/details?id=com.tablamigo.app&referrer='+encodeURIComponent(rr.toString()))}}catch(e){}})();"""

# Which store button a visitor sees. Owner's rule (4 Nov 2026, "like Google, OpenAI"): a phone or tablet sees only its own
# platform, every computer sees both. Runs in <head>, before anything paints. html gets os-ios (iPhone, iPad, and iPadOS in
# desktop mode, which says "Macintosh" but has touch), os-android, or os-desktop (Mac, Windows, Linux, anything else). Both badges
# are hidden until a class is set (style.css, "Store buttons"), so the wrong one never flashes; without JavaScript the <noscript>
# style in HEAD shows both.
OS_JS = ("(function(){var d=document.documentElement,c='os-desktop';try{var n=navigator,u=n.userAgent||'',"
         "p=(n.userAgentData&&n.userAgentData.platform)||n.platform||'',"
         "i=/iPhone|iPad|iPod/.test(u)||(/Mac/.test(u+p)&&n.maxTouchPoints>1);"
         "c=i?'os-ios':/Android/i.test(u)?'os-android':'os-desktop'}catch(e){}d.classList.add(c)})();")

# Google One Tap on the marketing pages: the "Continue as <name>" card Google shows top right to a visitor who is signed in
# to Google in that browser. The web app's own client id and API (apps/mobile/src/lib/config.ts, apps/api/src/lib/config.ts).
GOOGLE_WEB_CLIENT_ID = "316890004786-11d9pklbq4phqa7vk3a99vfiol2qsc1s.apps.googleusercontent.com"
API = "https://tablamigo-api.hookstep.in"
# Pages that never load Google's script: the legal pages (the Android app opens them, and they describe the service rather
# than sell it) and the 404. The admin panel is a standalone page and never gets the site shell at all.
NO_ONE_TAP = {"privacy.html", "terms.html", "delete-account.html", "child-safety.html", "404.html"}
# How it works:
# - Skipped for a visitor who already has a Tablamigo session in this browser: the web app at /app/ keeps it in localStorage
#   under tablamigo.tokens (apps/mobile/src/lib/session.web.ts), and /app/ is on this origin, so the same key is readable here.
#   Skipped as well when localStorage can't be used, because then the sign-in couldn't be kept.
# - Google's script loads only after the visitor's first scroll, tap, click or key press, never on a timer, so it is never part
#   of the page load and a visitor who only reads the page never fetches it. (Until 11 Oct 2026 a ~4 s timer also loaded it;
#   that fired inside Lighthouse and PageSpeed runs and logged Google's "Not signed in with the identity provider" FedCM
#   error, which cost Best Practices points: audit TM-04/F7.)
# - auto_select is off, so nothing happens until the visitor taps their account. FedCM is used where the browser has it.
# - The credential goes to POST /auth/google, the same call the web app's button makes, with the sign-up source the API already
#   records (utm tags as the Play links carry them, the first page of the visit, the site that sent the visitor). The Referer
#   header is left off so the API reads that site instead of our own page. The returned pair is stored exactly as the web app
#   stores it, then /app/ opens: its root layout sends a new account to onboarding and a finished one to the map.
# - If the API refuses (suspended account, rate limit, network), /app/ opens anyway, signed out, so the visitor sees the
#   normal sign-in screen and its error messages instead of a card that did nothing.
ONE_TAP_JS = (r"""(function(){try{var K='tablamigo.tokens',t;try{t=localStorage.getItem(K)}catch(e){return}
try{if(t&&JSON.parse(t))return}catch(e){}
var ss=function(k,v){try{if(v===undefined)return sessionStorage.getItem(k);sessionStorage.setItem(k,v)}catch(e){}return null},
ref=document.referrer;if(ref&&ref.indexOf(location.origin+'/')!==0)ss('tm_ref',ref.slice(0,300));if(!ss('tm_landing'))ss('tm_landing',location.pathname);
var E=['pointerdown','keydown','scroll','touchstart'],done=false;
function go(){if(done)return;done=true;E.forEach(function(e){removeEventListener(e,go,true)});
var s=document.createElement('script');s.src='https://accounts.google.com/gsi/client';s.async=true;s.onload=start;document.head.appendChild(s)}
function start(){var g=window.google&&google.accounts&&google.accounts.id;if(!g)return;
g.initialize({client_id:'"""
              + GOOGLE_WEB_CLIENT_ID
              + r"""',callback:signIn,auto_select:false,cancel_on_tap_outside:true,context:'signin',itp_support:true,use_fedcm_for_prompt:true});g.prompt()}
function signIn(r){if(!r||!r.credential)return;
var b={idToken:r.credential,landing:ss('tm_landing')||location.pathname},k=['utm_source','utm_medium','utm_campaign'],q=new URLSearchParams(location.search),u={},x;
k.forEach(function(n){var v=q.get(n);if(v)u[n]=v});if(!u.utm_source){try{x=JSON.parse(ss('tm_utm')||'null')}catch(e){}if(x)u=x}
k.forEach(function(n){if(u[n])b[n]=String(u[n]).slice(0,100)});x=ss('tm_ref');if(x)b.referrer=x;
try{x=(/(?:^|;\s*)tm_aff=([A-Z0-9]{4,16})/.exec(document.cookie||'')||[])[1];if(x)b.ref_code=x}catch(e){}
fetch('"""
              + API
              + r"""/auth/google',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b),referrerPolicy:'no-referrer'})
.then(function(res){return res.ok?res.json():res.json().then(function(j){return{error:j&&j.error}},function(){return{}})})
.then(function(j){if(j&&j.accessToken&&j.refreshToken){try{localStorage.setItem(K,JSON.stringify({accessToken:j.accessToken,refreshToken:j.refreshToken}))}catch(e){}location.href='/app/'}
else location.href=j&&j.error==='banned'?'/app/welcome?suspended=1':'/app/'},function(){location.href='/app/'})}
E.forEach(function(e){addEventListener(e,go,{capture:true,passive:true,once:true})})}catch(e){}})();""")
ONE_TAP_TAG = "<script>" + ONE_TAP_JS + "</script>\n"


# Cloudflare Web Analytics, the site's only analytics (page views, load time and Core Web Vitals; no cookies, no fingerprinting).
# Cloudflare's automatic setup injects its beacon (static.cloudflareinsights.com/beacon.min.js) into every HTML response, where it
# sits in the critical path and cost about 9 mobile Lighthouse points (audit TM-02, 11 Oct 2026). This loader loads the same beacon
# itself, after the window's load event and a browser idle moment, so it never delays a first paint. The token is the public site
# token for tablamigo.hookstep.in (it is in the HTML Cloudflare serves; Web Analytics > Manage site shows it).
# - It adds the beacon only when no script from cloudflareinsights.com/beacon is on the page already, so while Cloudflare's
#   automatic injection is still switched on nothing is counted twice (Cloudflare allows one snippet per page).
# - After the automatic injection is switched off, set the site to "Enable with JS Snippet installation" in Web Analytics >
#   Manage site, not "Disable", so the dashboard keeps accepting this snippet's data.
# - spa:false because every page here is a full page load. The web app (apps/mobile/public/index.html) carries the same loader
#   with spa:true, because its screens change without a page load.
# check.py enforces: one loader on every page, no beacon <script src> in the built HTML, and the privacy policy's disclosure.
CF_BEACON_TOKEN = "88c7787047e04bab8a994b5bb649e9a1"
BEACON_JS = (r"""(function(){try{if(location.hostname!=='tablamigo.hookstep.in')return;function add(){if(document.querySelector('script[src*="cloudflareinsights.com/beacon"]'))return;
var s=document.createElement('script');s.defer=true;s.src='https://static.cloudflareinsights.com/beacon.min.js';
s.setAttribute('data-cf-beacon','{"token":"%s","spa":false}');document.head.appendChild(s)}
function idle(){if(window.requestIdleCallback)requestIdleCallback(add,{timeout:5000});else setTimeout(add,1500)}
if(document.readyState==='complete')idle();else addEventListener('load',idle,{once:true})}catch(e){}})();""" % CF_BEACON_TOKEN)
BEACON_TAG = "<script>" + BEACON_JS + "</script>\n"


# ADS AND AFFILIATE LINKS ON THE GUIDES (owner's decision, 20 Oct 2026). Two networks only, and only on reading pages: Infolinks ads
# and Travelpayouts affiliate links (GetYourGuide, Klook). Never on /, /download, the app pages and comparisons, the legal pages, the 404,
# the admin panel or the web app at /app/, and never a popunder, push or redirect network. Each one stays off until its IDs below are
# filled in from the owner's dashboard; while they are empty no page changes. check.py enforces the page set, the loader, ads.txt and
# that the privacy policy matches whatever is switched on.
#
# Hookstep's Google publisher line, in /app-ads.txt (AdMob verifies the Android app against it) and in /ads.txt.
GOOGLE_ADS_TXT = "google.com, pub-6574958062528034, DIRECT, f08c47fec0942fa0"
# Infolinks: the publisher ID (pid) and website ID (wsid) from publishers.infolinks.com > integration code. Both are public (they are in
# every page's code). INFOLINKS_ADS_TXT holds the account's ads.txt lines exactly as the dashboard gives them. Only InText and InArticle
# should run (InScreen, InTop and InFold off): choose the ad units for this site in the Infolinks dashboard, and if its integration code
# carries ad-unit settings, copy them into INFOLINKS_JS beside the two IDs. Before turning it on, compare INFOLINKS_JS with that code.
INFOLINKS_PID = ""   # digits, e.g. "3412345"
INFOLINKS_WSID = "0"
INFOLINKS_ADS_TXT = ()  # e.g. ("infolinks.com, 3412345, DIRECT", ...)
# The pages that may carry it: every city guide (solo-travel/<slug>.html, not the solo-travel.html hub) and the how-to guides below.
INFOLINKS_GUIDES = {"how-to-meet-people-in-hostels.html", "how-to-meet-people-while-traveling-solo.html", "eating-alone-while-traveling.html"}
INFOLINKS_SRC = "https://resources.infolinks.com/js/infolinks_main.js"
# The site has no consent banner, so nothing here waits for one. Like the Cloudflare beacon, Infolinks' script is added after the window's
# load event and a browser idle moment, so it never delays a first paint, and only on the production host (local builds and previews
# never request an ad).
INFOLINKS_JS = (r"""(function(){try{if(location.hostname!=='tablamigo.hookstep.in')return;window.infolinks_pid=%s;window.infolinks_wsid=%s;
function add(){if(document.querySelector('script[src*="infolinks.com/js/"]'))return;var s=document.createElement('script');s.async=true;s.src='%s';document.body.appendChild(s)}
function idle(){if(window.requestIdleCallback)requestIdleCallback(add,{timeout:5000});else setTimeout(add,1500)}
if(document.readyState==='complete')idle();else addEventListener('load',idle,{once:true})}catch(e){}})();"""
                % (INFOLINKS_PID or "0", INFOLINKS_WSID or "0", INFOLINKS_SRC))
INFOLINKS_TAG = ("<script>" + INFOLINKS_JS + "</script>\n") if INFOLINKS_PID else ""


def infolinks_page(rel):
    """True for the pages that may carry Infolinks: the city guides and the how-to guides."""
    return rel in INFOLINKS_GUIDES or (rel.startswith("solo-travel/") and rel.endswith(".html"))


# GOOGLE ADSENSE ON THE GUIDES (owner's decision, 25 Oct 2026). Hookstep's AdSense account is GOOGLE_ADS_TXT's publisher. AdSense no
# longer lists subdomains as sites of their own, so these pages are served under the account's hookstep.in site once AdSense marks it
# Ready. Auto ads: the script below is the whole integration, and which formats run is chosen in AdSense (Ads > By site). Same page set
# as Infolinks minus the thin guides (adsense_page): template text with ads on it is what AdSense calls low-value content. Never on
# /, /download, the app pages and comparisons, safety, the legal pages, the 404, the admin panel or the web app at /app/.
ADSENSE_CLIENT = "ca-pub-6574958062528034"
ADSENSE_ON = True
# Consent. Google needs a Google-certified consent tool (a TCF CMP) for ads to visitors in the EEA and the UK (from 16 Jan 2024) and
# Switzerland (from 31 Jul 2024). AdSense's own is its Privacy & messaging "European regulations" message, which the AdSense script
# shows by itself. ADSENSE_CMP says whether the loader may rely on that message:
#   False (shipped): the loader asks Cloudflare (/cdn-cgi/trace, same host, no cookie) for the visitor's country and loads nothing
#         at all for CONSENT_COUNTRIES, or when the country can't be told.
#   True: the script loads for every country and Google's message asks in the EEA, the UK and Switzerland, with a "Privacy and
#         cookie settings" link to change the choice later (answer 14852903).
# State on 25 Oct 2026: "European regulations message - hookstep.in" is Published (since 17 Mar 2026), and a message on a site shows
# on all its subsites (support.google.com/adsense/answer/14113511). A live check with Google's standalone consent tag and
# ?fc=alwaysshow&fctype=gdpr brought up Google's consent tool on a guide here exactly as on hookstep.in, and not on an unlisted host,
# so the message is matched to these pages. But the dialog never rendered on either host, and the AdSense script these pages ship
# never loaded the consent tool at all (it did send an ad request). Google says messages may only go live once eligible ads serve
# (Ad Manager answer 10130765; hookstep.in is not approved yet), so with True an EEA visitor could get Google's script and an ad
# request with no consent prompt. The independent review failed the switch on that, so it stays False.
# Set it to True only after hookstep.in is approved AND a guide opened from an EEA connection (fresh browser profile, no ?fc
# parameters) shows Google's dialog from the AdSense script alone, sends no ad request before a choice and one with
# gdpr=1&gdpr_consent= after it, and then shows the "Privacy and cookie settings" link. Check also that no message of any type is
# published on a more specific site (it would take precedence), and keep a screenshot of the "Allow Google to maximize message
# coverage" setting in Privacy & messaging (answer 17341119). When switching, also check whether Google's message relies on
# legitimate interest for any purpose; if it does, the policy's legal bases should say so and name the right to object. Update
# privacy.html's "Last updated" in the same commit.
ADSENSE_CMP = False
# The EEA (the 27 EU countries, their outermost regions and Åland, plus Iceland, Liechtenstein and Norway), the UK with Gibraltar, the
# Channel Islands and the Isle of Man, and Switzerland, as ISO codes Cloudflare reports. Used only while ADSENSE_CMP is False.
CONSENT_COUNTRIES = ("AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
                     "PL", "PT", "RO", "SK", "SI", "ES", "SE", "GF", "GP", "MQ", "RE", "YT", "MF", "AX", "IS", "LI", "NO",
                     "GB", "GI", "GG", "JE", "IM", "CH")
ADSENSE_SRC = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + ADSENSE_CLIENT


def adsense_js(cmp):
    """The loader for either consent state (tests run both). Core Web Vitals: nothing loads during the page load. The script is added
    after the visitor's first scroll, tap, click or key press (as Google's sign-in script is), then a browser idle moment, async, and
    only on the production host (local builds, previews and lab tests without input never request an ad)."""
    return (r"""(function(){try{if(location.hostname!=='tablamigo.hookstep.in')return;var CMP=%s,NO=%s;
function add(){if(document.querySelector('script[src*="adsbygoogle.js"]'))return;var s=document.createElement('script');s.async=true;s.crossOrigin='anonymous';s.src='%s';document.head.appendChild(s)}
function gate(){if(CMP)return add();fetch('/cdn-cgi/trace',{cache:'no-store'}).then(function(r){return r.ok?r.text():''}).then(function(t){var m=/(?:^|\n)loc=([A-Z]{2})\b/.exec(t),c=m&&m[1];if(c&&c!=='XX'&&c!=='T1'&&NO.indexOf(c)<0)add()})['catch'](function(){})}
var ev=['scroll','pointerdown','keydown','touchstart'],done=false;function go(){if(done)return;done=true;ev.forEach(function(e){removeEventListener(e,go,true)});if(window.requestIdleCallback)requestIdleCallback(gate,{timeout:3000});else setTimeout(gate,200)}
ev.forEach(function(e){addEventListener(e,go,{capture:true,passive:true})})}catch(e){}})();"""
            % ("true" if cmp else "false", json.dumps(list(CONSENT_COUNTRIES), separators=(",", ":")), ADSENSE_SRC))


ADSENSE_JS = adsense_js(ADSENSE_CMP)
ADSENSE_TAG = ("<script>" + ADSENSE_JS + "</script>\n") if ADSENSE_ON else ""


def adsense_page(rel):
    """True for the pages that carry Google's ad script: the how-to guides and the city guides that aren't THIN_GUIDES."""
    if rel in INFOLINKS_GUIDES:
        return True
    m = re.fullmatch(r"solo-travel/([a-z0-9-]+)\.html", rel)
    return bool(m) and m.group(1) not in THIN_GUIDES


# Travelpayouts: TRAVELPAYOUTS_MARKER is the partner ID from app.travelpayouts.com (public: every affiliate link carries it). A programme's
# links show only once it is joined there and listed in TP_JOINED. CITY_AFFILIATE holds, per city guide, at most two links made with
# Travelpayouts' link generator for that programme, and only where the guide's "Good plans" list already suggests that activity (the
# guides that do: Goa's Dudhsagar day trip, Rishikesh rafting, Chiang Mai and Udaipur cooking classes, Varanasi's boat ride, Hanoi's
# Ninh Binh day trip and others). Each shows with rel="sponsored nofollow noopener", opens in a new tab and says it is an affiliate link.
TRAVELPAYOUTS_MARKER = ""  # digits
TP_PROGRAMMES = {"getyourguide": "GetYourGuide", "klook": "Klook"}
TP_JOINED = set()  # e.g. {"getyourguide", "klook"}
CITY_AFFILIATE = {}  # slug -> [(programme, link text, link)], e.g. "goa": [("getyourguide", "Dudhsagar Falls day trips", "https://tp.media/r?marker=...")]
INFOLINKS_ON, AFFILIATE_ON = bool(INFOLINKS_PID), bool(TRAVELPAYOUTS_MARKER and TP_JOINED and CITY_AFFILIATE)
# The ad networks on this website's guides, as the privacy policy and the partnerships page name them ("" when the site shows none).
WEB_AD_NETWORKS = [name for name, on in (("Google AdSense", ADSENSE_ON), ("Infolinks", INFOLINKS_ON)) if on]
WEB_ADS = " and ".join(WEB_AD_NETWORKS)
ANY_ADS = bool(WEB_ADS) or ANDROID_ADS_LIVE


def city_affiliate(c):
    """The guide's affiliate links (at most two), or "" while Travelpayouts is off or the guide has none."""
    if not (TRAVELPAYOUTS_MARKER and TP_JOINED):
        return ""
    links = [x for x in CITY_AFFILIATE.get(c["slug"], []) if x[0] in TP_JOINED][:2]
    if not links:
        return ""
    a = " or ".join(f'<a href="{H.escape(url)}" rel="sponsored nofollow noopener" target="_blank">{H.escape(text)} on {TP_PROGRAMMES[p]}</a>'
                    for p, text, url in links)
    return (f"<p class=\"small\">Rather book a tour? See {a}. Affiliate link{'s' if len(links) > 1 else ''}: if you book, we may earn a commission, "
            "at no extra cost to you.</p>\n")


# What the privacy policy and the partnerships page say about ads, from the three switches: ADSENSE_ON (this website's guides),
# INFOLINKS_ON (the same guides) and ANDROID_ADS_LIVE (AdMob in a Play release). With all three off, the policy reads as it did
# before any ads (no advertising trackers anywhere). Switching any of them changes the policy: update its "Last updated" date in
# src/privacy.html in the same commit. Pages use {{ads_*}} tokens and <!-- ads-* --> markers; check.py holds every state to its words.
_ADSENSE_GATE = ("In the EEA, the UK and Switzerland, Google first shows its consent message, and its ads there use cookies only as far as "
                 "you agree in it. You can change your choice at any time with the \"Privacy and cookie settings\" link Google adds at the "
                 "bottom of those guides." if ADSENSE_CMP else
                 "Before it does, the page asks Cloudflare, which runs in front of this website, which country your connection comes from. If "
                 "it is in the EEA, the UK or Switzerland, or the country can't be told, the script isn't loaded and you see no ads.")
_APP_ADS_PLACE = ("the sign-in, chat, direct message and payment screens" + ("" if WEB_ADS else ", or on this website"))
ADS_COPY = {
    "ads_short": ("We don't sell your data and use no advertising trackers." if not ANY_ADS else
                  "We don't sell your data. "
                  + ("The Android app shows free accounts an ad banner from Google AdMob, which can use your phone's advertising ID; Plus "
                     "members see no ads, and the web app has none." if ANDROID_ADS_LIVE else
                     "The Android app and the web app have no ads and no advertising trackers.")
                  + (f" Some travel guides on this website show ads from {WEB_ADS}, which can use cookies (section 3)." if WEB_ADS else "")),
    "ads_share": ("We don't sell or rent personal data, and we don't use advertising trackers." if not ANY_ADS else
                  "We don't sell or rent personal data."
                  + (" The Android app's ad banner comes from Google AdMob (below)." if ANDROID_ADS_LIVE else
                     " The Android app and web app use no advertising trackers.")
                  + (f" Some of this website's travel guides show ads from {WEB_ADS}, described below." if WEB_ADS else "")),
    "ads_measure": ("The only third-party measurement on the website and web app is the Cloudflare Web Analytics row above." if not WEB_ADS else
                    "The only third-party measurement in the web app is the Cloudflare Web Analytics row above; on this website there is also "
                    f"the ad measurement {WEB_ADS} {'do' if len(WEB_AD_NETWORKS) > 1 else 'does'} on some travel guides (section 3)."),
    "ads_app_sdk": ("The only third-party advertising or analytics software in the Android app is Google's ad software, described in the "
                    "ads row above." if ANDROID_ADS_LIVE else "There are no third-party analytics or advertising SDKs in the Android app."),
    "ads_legal": (((", cookies for the ads on this website's travel guides, which you accept or refuse in Google's consent message"
                    if ADSENSE_ON and ADSENSE_CMP else "")
                   + (", and the ad choices you make in Google's consent form in the Android app" if ANDROID_ADS_LIVE else ""))),
    "ads_rows": (("<tr><td>Ads in the Android app (Google AdMob)</td><td>Free accounts in the Android app see one ad banner, at the end of "
                  "the list of plans on the Explore tab. Plus members see no ads, and there are none in the web app, or on "
                  + _APP_ADS_PLACE + ". The banner comes from Google AdMob, Google's ad service, through Google's Mobile Ads software in the "
                  "app, not from us. Google says this software collects your phone's advertising ID, an app set ID and, where applicable, other "
                  "identifiers of accounts signed in on the phone, your IP address (which "
                  "can be used to estimate your general location), app interactions such as launches, taps and video views, and diagnostic "
                  "information about the app's performance, and uses them for advertising, analytics and fraud prevention. You can reset or "
                  "delete your advertising ID in your phone's settings. The software also asks Android for its ad-services features (ad "
                  "topics, ad measurement and the advertising ID through Android's ad services); on phones that offer them, you control "
                  "them in Android's ad privacy settings. Where the law requires consent, for example in the EEA and the UK, the app shows "
                  "Google's consent form before any ad loads, and you can change your choice later under Profile → Ad privacy choices; "
                  "whether the ads you see are personalised depends on those choices. We don't pass Google your name, email address, "
                  "profile, messages or position, and we never receive your advertising ID.</td><td>Google, under its own policies "
                  "(<a href=\"https://policies.google.com/technologies/ads\">how Google uses information in ads</a>). We see only totals, "
                  "such as how many ads were shown, in our AdMob account.</td></tr>\n") if ANDROID_ADS_LIVE else ""),
    "ads_choices": ((("<li><strong>Ads on this website:</strong> turn off personalised ads in Google's "
                      "<a href=\"https://www.google.com/settings/ads\">Ads Settings</a>, or opt out of many ad companies' personalised ads at "
                      "<a href=\"https://www.aboutads.info/choices/\">aboutads.info</a> or <a href=\"https://www.youronlinechoices.eu/\">"
                      "youronlinechoices.eu</a>."
                      + (" In the EEA, the UK and Switzerland, change your consent with the \"Privacy and cookie settings\" link at the bottom "
                         "of a guide." if ADSENSE_ON and ADSENSE_CMP else "")
                      + " A content blocker, or blocking cookies in your browser, also works; the guides read the same without ads.</li>\n")
                     if WEB_ADS else "")
                    + (("<li><strong>Ads in the Android app:</strong> Plus has no ads. Where Google's consent form applies, change your choice "
                        "under Profile → Ad privacy choices in the Android app. You can reset or delete your phone's advertising ID in its "
                        "settings.</li>\n") if ANDROID_ADS_LIVE else "")),
    "ads_vendors": ((("<li><strong>Google AdSense</strong> — shows ads on some of this website's travel guides: our how-to guides, and the "
                      "city guides under tablamigo.hookstep.in/solo-travel/ that name sourced places where travelers stay or meet. Nowhere "
                      "else: not on the home page, the download page, the app comparisons, the safety page, these legal pages, the web app "
                      "or the Android app. On those guides your browser loads Google's ad script from googlesyndication.com after your first "
                      "scroll, tap, click or key press. " + _ADSENSE_GATE + " Third-party vendors, including Google, use cookies to serve "
                      "ads based on your prior visits to this website or other websites. Google's use of advertising cookies enables it and "
                      "its partners to serve ads to you based on your visits to this and other sites on the internet. Google may also let "
                      "other ad companies show and measure ads here (<a href=\"https://support.google.com/admanager/answer/9012903\">"
                      "Google's list of ad technology partners</a>). Google and those companies receive your IP address, browser details "
                      "and the page you are reading. You can opt out of personalised advertising in Google's "
                      "<a href=\"https://www.google.com/settings/ads\">Ads Settings</a>, and opt out of many other companies' cookies for "
                      "personalised advertising at <a href=\"https://www.aboutads.info/choices/\">aboutads.info</a> or, in Europe, "
                      "<a href=\"https://www.youronlinechoices.eu/\">youronlinechoices.eu</a>. See "
                      "<a href=\"https://policies.google.com/technologies/partner-sites\">how Google uses information from sites that use "
                      "its services</a>. We don't give Google your name, email or any account ID. You can block the ads with a content "
                      "blocker or your browser's cookie settings; the guides work the same without them.</li>\n") if ADSENSE_ON else "")
                    + (("<li><strong>Google AdMob</strong> — the ad banner that free accounts see in the Android app. Google's Mobile Ads "
                        "software in the app sends Google the data described in the ads row above, and Google uses it under its own policies "
                        "to show and measure ads and to prevent fraud. We don't send Google anything from your Tablamigo account.</li>\n")
                       if ANDROID_ADS_LIVE else "")
                    + (("<li><strong>Infolinks</strong> — shows ads on some of this website's travel guides: the city guides under "
                     "tablamigo.hookstep.in/solo-travel/ and our how-to guides. Nowhere else: not on the home page, the download page, the app "
                     "comparisons, these legal pages, the web app or the Android app. On those guides your browser loads Infolinks' script from "
                     "infolinks.com after the page has finished loading. Infolinks and its advertising partners receive your IP address, browser "
                     "details and the page you are reading, and may set cookies or use similar technologies to show, measure and personalise ads, "
                     "under <a href=\"https://www.infolinks.com/privacy-policy/\">Infolinks' privacy policy</a>. We don't give them your name, "
                     "email or any account ID. You can block the ads with a content blocker or your browser's cookie settings; the guides work "
                     "the same without them.</li>\n") if INFOLINKS_ON else "")
                   + (("<li><strong>Travelpayouts</strong> — some city guides link to tours on "
                       + " or ".join(TP_PROGRAMMES[p] for p in sorted(TP_JOINED))
                       + " through Travelpayouts, an affiliate network, and say so next to the link. Nothing is loaded from Travelpayouts unless "
                       "you open such a link. If you do, Travelpayouts and the booking site record the click, and the booking site may set a "
                       "cookie, so that a booking you make can be credited to us; we may then earn a commission, at no extra cost to you. We "
                       "don't learn who you are or what you booked. See <a href=\"https://www.travelpayouts.com/legal/privacy-policy/\">"
                       "Travelpayouts' privacy policy</a> and the booking site's own.</li>\n") if AFFILIATE_ON else "")),
    # The partnerships page: "there are {{partner_ads}}. Nothing on this page is for sale yet." and one fact-list item.
    "partner_ads": (("no sponsored listings in Tablamigo today; the only ads are Google AdMob banners shown to free accounts in the Android app"
                     + (f" and ads from {WEB_ADS} on some travel guides on this website" if WEB_ADS else "")
                     + ", and we don't sell ad space ourselves") if ANDROID_ADS_LIVE else
                    ("no ads or sponsored listings in the Tablamigo app today"
                     + (f"; some travel guides on this website show ads from {WEB_ADS}, and we don't sell ad space ourselves" if WEB_ADS else ""))),
    "partner_ads_item": (("<li><strong>No sponsored placements in the app.</strong> Plans in Tablamigo are posted by travelers, and we don't "
                          "mark any plan as sponsored. The only ads in the app are Google AdMob banners for free accounts in the Android app; "
                          "we don't sell ad space ourselves.</li>") if ANDROID_ADS_LIVE else
                         ("<li><strong>No ads or sponsored placements in the app.</strong> Plans in Tablamigo are posted by travelers. We "
                          "don't mark any plan as sponsored today.</li>")),
}
_ADS_MARKERS = ("ads_rows", "ads_vendors", "ads_choices")  # <!-- ads-rows --> etc., each on a line of its own


def ads_tokens(body):
    for marker in _ADS_MARKERS:
        body = body.replace("<!-- " + marker.replace("_", "-") + " -->\n", ADS_COPY[marker])
    for token, text in ADS_COPY.items():
        if token not in _ADS_MARKERS:
            body = body.replace("{{" + token + "}}", text)
    return body


# THIN CITY GUIDES (audit F4, 11 Oct 2026). 28 of the 42 guides are the same template with a few one-line area descriptions and no
# named, sourced places; the other 14 (the slugs not listed here) carry the sourced "Social hostels" and "Where solo travelers meet"
# sections. The 28 are noindex,follow and left out of the sitemap and llms.txt, so Google judges the site on the guides that tell a
# reader something. The pages stay built and linked (from the guide hub, from each other and from the India pages). A guide comes
# off this list when it is enriched: add its hostels and meet_spots to cities.json (each with a source and a checked date), then
# delete its slug here. check.py enforces both directions: a listed guide that has sourced places, and an unlisted guide that has
# none, both fail the build.
# How "thin" was measured on 11 Oct 2026 (python3 infra/seo/guide_words.py prints the table): unique words = words in sentences that
# appear on at most 2 of the 42 guides once the city and country names are masked (the template reads the same everywhere else).
#   28 guides with no sourced places: 205-376 unique words (median 238.5), 536-707 words in all.
#   14 guides with sourced places:    349-560 unique words (median 489),   796-1,038 words in all.
# The rule is fewer than 400 unique words AND no sourced places. Bali (349 unique words, 5 sourced entries) stays indexed because its
# named places are the information the template cannot produce; Hanoi (376, none) is the nearest guide to the line, and is listed.
THIN_GUIDES = {
    "berlin", "budapest", "buenos-aires",
    "cape-town", "cusco", "da-nang", "dubai", "hanoi",
    "ho-chi-minh-city", "istanbul", "koh-phangan", "kuala-lumpur", "lisbon",
    "london", "madrid", "medellin", "mexico-city", "new-york-city",
    "paris", "prague", "rio-de-janeiro", "rome", "seoul",
    "singapore", "tokyo", "valencia",
}

# HELD PAGES (owner decision, 11 Oct 2026): pages from src/ that are built and linked like any other, but held out of search until
# someone has reviewed them. They get the same treatment as THIN_GUIDES: robots noindex,follow, left out of sitemap.xml, llms.txt and
# the llms-*.txt full-text files. Links to them stay, because they are useful to visitors. check.py enforces all of it.
# Delete a page's name here once it has been reviewed, and it is indexed and listed again on the next build.
# solo-female-travel-india.html was held from 11 Oct 2026 and released the same day after its review (see HANDOFF.md).
HELD_PAGES = set()

# UTILITY PAGES: built in the site shell but only reached through a personal link, never by search: /invite (a friend's invite link,
# made by the API's GET /me/referral, lib/referral.ts). robots noindex,follow, out of sitemap.xml and the llms files. check.py
# enforces it like HELD_PAGES.
UTILITY_PAGES = {"invite.html"}

# LIVE COUNTS (NomadTable teardown gaps 7 and 8, 1 Nov 2026). The API's public GET /public/social-proof and /public/popular-cities
# (apps/api/src/lib/social-proof.ts) hold only real travellers' trips and plans, and leave out every city with fewer than 10 upcoming
# trips. Nothing about them is typed here: the home page's "Live on Tablamigo" block is empty and hidden in the HTML and fills in from
# the API in the browser, staying hidden while no city qualifies. /popular-cities is built on every deploy; it is held (noindex,
# unlinked, out of the sitemap and llms files, like UTILITY_PAGES) until the API says 3 cities qualify. The build asks the API only
# when TABLAMIGO_LIVE_DATA=1 (the production deploy, infra/ci/cd.sh and infra/deploy.sh); every other build, CI and tests included,
# is offline and treats the page as held. A held page still shows the live list in the browser once cities qualify.
LIVE_MIN_TRIPS, LIVE_MIN_CITIES = 10, 3


def live_popular_cities():
    """The API's popular-cities answer at build time, or a held page when the build is offline or the API can't say."""
    held = {"enabled": False, "cities": []}
    if os.environ.get("TABLAMIGO_LIVE_DATA") != "1":
        return held
    try:
        from urllib.request import urlopen
        # TABLAMIGO_LIVE_API: tests point the build at a local fake; production builds use the API.
        with urlopen(os.environ.get("TABLAMIGO_LIVE_API", API) + "/public/popular-cities", timeout=8) as r:
            d = json.loads(r.read().decode())
        cities = [c for c in d.get("cities", []) if int(c.get("upcomingTrips", 0)) >= LIVE_MIN_TRIPS]
        return {"enabled": bool(d.get("enabled")) and len(cities) >= LIVE_MIN_CITIES, "cities": cities}
    except Exception as e:  # never fail a deploy over it: the page stays held until the next build
        print(f"popular-cities: API unavailable ({e}); page held")
        return held


POPULAR = live_popular_cities()
if not POPULAR["enabled"]:
    UTILITY_PAGES.add("popular-cities.html")


def popular_cities_html(cities):
    """The ranked list, built in when the page is enabled; the page's script refreshes it from the API."""
    if not cities:
        return '<p id="pc-empty">Not enough trips yet to rank cities honestly. A city appears here once ' + str(LIVE_MIN_TRIPS) + ' or more travelers have upcoming trips there.</p>'
    rows = "".join(f'<li><b>{H.escape(c["city"])}</b> <span class="small">{int(c["upcomingTrips"])} upcoming trips · {int(c["plansThisWeek"])} plans this week</span></li>' for c in cities)
    return f'<ol id="pc-list">{rows}</ol>'


# The home page's block and the popular-cities page's refresh. On /popular-cities the API's answer always wins over the list built in
# at deploy time: a city that dropped under the line disappears without waiting for the next deploy. Both read the API after the
# page has loaded (never in the critical path), write text only (textContent, never HTML from the API), and leave the page exactly as built when the API is down or has
# nothing to show. The plan times are shown in the visitor's own clock. Only on the production host, so local builds, previews and
# the browser tests never call the production API (tests/live-counts.test.mjs runs it in a fake browser).
LIVE_JS = (r"""(function(){try{if(location.hostname!=='tablamigo.hookstep.in')return;var A='""" + API + r"""';function idle(f){if(window.requestIdleCallback)requestIdleCallback(f,{timeout:4000});else setTimeout(f,1200)}
function el(t,txt,c){var e=document.createElement(t);if(txt!=null)e.textContent=txt;if(c)e.className=c;return e}
function n(x,one,many){return x+' '+(x===1?one:many)}
function home(){var box=document.getElementById('live-now');if(!box)return;fetch(A+'/public/social-proof').then(function(r){return r.ok?r.json():null}).then(function(d){
if(!d||!d.cities||!d.cities.length)return;var t=d.totals,b=document.getElementById('live-body');b.textContent='';
if(t)b.appendChild(el('p',n(t.upcomingTrips,'upcoming trip','upcoming trips')+' · '+n(t.plansThisWeek,'plan','plans')+' this week · '+n(t.cities,'city','cities'),'lead'));
var tr=d.trending||[];if(tr.length){b.appendChild(el('h3','Trending trips'));var ul=el('ul');tr.forEach(function(c){ul.appendChild(el('li',c.city+': '+n(c.travellers,'traveler','travelers')+' arriving in the next 30 days'))});b.appendChild(ul)}
var td=d.today||[];if(td.length){b.appendChild(el('h3',"Today's plans"));var ol=el('ul');td.forEach(function(p){var w=new Date(p.startsAt);ol.appendChild(el('li',(p.emoji?p.emoji+' ':'')+p.title+' · '+p.city+' · '+w.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})+' · '+n(p.going,'going','going')))});b.appendChild(ol)}
box.hidden=false})['catch'](function(){})}
function popular(){var box=document.getElementById('pc-live');if(!box)return;fetch(A+'/public/popular-cities').then(function(r){return r.ok?r.json():null}).then(function(d){
if(!d)return;if(!d.enabled||!d.cities||!d.cities.length){box.textContent='';box.appendChild(el('p',"Not enough trips yet to rank cities honestly. A city appears here once "+(d.minTrips||10)+" or more travelers have upcoming trips there."));return}var ol=el('ol');ol.id='pc-list';d.cities.forEach(function(c){var li=el('li');li.appendChild(el('b',c.city));li.appendChild(document.createTextNode(' '));li.appendChild(el('span',n(c.upcomingTrips,'upcoming trip','upcoming trips')+' · '+n(c.plansThisWeek,'plan','plans')+' this week','small'));ol.appendChild(li)});
box.textContent='';box.appendChild(ol)})['catch'](function(){})}
function go(){idle(function(){home();popular()})}if(document.readyState==='complete')go();else addEventListener('load',go,{once:true})}catch(e){}})();""")
LIVE_TAG = "<script>" + LIVE_JS + "</script>\n"
LIVE_HOME = ('<section id="live-now" hidden>\n  <div class="wrap">\n    <h2>Live on Tablamigo</h2>\n'
             '    <p class="sub">Real travelers only: no team, demo or test accounts. A city shows here once ' + str(LIVE_MIN_TRIPS) + ' or more travelers have upcoming trips there.</p>\n'
             '    <div id="live-body"></div>\n  </div>\n</section>\n')

# Invite rewards and how long a new account has to use a code (API lib/plus.ts REFERRAL.rewardDays and redeemWithinDays; the API's prices-and-limits test holds the two together).
INVITE_DAYS, INVITE_REDEEM_DAYS = 7, 14

def jsonld(obj):
    return '<script type="application/ld+json">' + json.dumps(obj, ensure_ascii=False).replace("</", "<\\/") + '</script>'


def play_url(placement):
    """The Play listing with an install referrer. Play reads utm_* from `referrer` (URL-encoded as one value)."""
    if not re.fullmatch(r"[a-z0-9_]+", placement):
        raise ValueError(f"play placement must be lower_snake_case: {placement!r}")
    return PLAY + "&referrer=" + quote(f"utm_source=website&utm_medium={placement}&utm_campaign=play_badge", safe="")


def play_badge(placement, eager=False):
    """Google's badge artwork, unmodified, as a link to the listing (sized in CSS, .play-badge img), followed by the iPhone badge.
    OS_JS and the .os-* rules show the Play badge on Android, the iPhone one on iPhone and iPad, and both on a computer."""
    lazy = "" if eager else ' loading="lazy"'
    return (f'<a class="play-badge" href="{H.escape(play_url(placement))}" data-placement="{placement}">'
            f'<img src="{PLAY_BADGE_IMG}" alt="Get it on Google Play" width="646" height="250" '
            f'decoding="async"{lazy}></a>' + ios_badge(placement))


def store_badges(placement, eager=False):
    """Both store badges in one flex row (same 52px height, centred on one line, wrapping on a narrow screen)."""
    return f'<span class="store-badges">{play_badge(placement, eager)}</span>'


def ios_badge(placement):
    """There is no App Store app: on iPhone the web app, added to the Home Screen (the steps are on /download#iphone-install).
    Our own artwork, never Apple's badge or logo (those are for App Store apps only)."""
    return (f'<a class="ios-badge" href="/download#iphone-install" data-placement="{placement}_ios" '
            f'aria-label="Get it on iPhone: add the Tablamigo web app to your Home Screen">'
            f'<svg aria-hidden="true" width="22" height="30" viewBox="0 0 22 30"><rect x="1.5" y="1.5" width="19" height="27" rx="4" fill="none" stroke="currentColor" stroke-width="2.4"/><rect x="8" y="23.5" width="6" height="2" rx="1" fill="currentColor"/></svg>'
            f'<span><small>Add to Home Screen</small>Get it on iPhone</span></a>')


def play_tokens(body):
    body = re.sub(r"<!-- play-badge: (\w+) -->", lambda m: store_badges(m.group(1), eager=m.group(1) == "hero"), body)
    return re.sub(r"\{\{play_url:(\w+)\}\}", lambda m: H.escape(play_url(m.group(1))), body)


def price_tokens(body):
    """Tablamigo's prices and limits come from the constants above, so the wording and the rupee amounts are changed in one place."""
    for token, text in (("price_short", PRICE_SHORT), ("price_line", PRICE_LINE), ("price_note", PRICE_NOTE), ("price_more", PRICE_MORE), ("free_limits", FREE_LIMITS),
                        ("plus_adds", PLUS_ADDS), ("invite_days", str(INVITE_DAYS)), ("invite_redeem_days", str(INVITE_REDEEM_DAYS)), ("safety_free", SAFETY_FREE), ("plus_month", PLUS_MONTH), ("plus_year", PLUS_YEAR),
                        ("trip_pass", TRIP_PASS)):
        body = body.replace("{{" + token + "}}", text)
    return body


def strip(x):
    return re.sub(r"\s+", " ", H.unescape(re.sub(r"<[^>]+>", "", x))).strip()


def load_cities():
    return json.loads((ROOT / "cities.json").read_text())


def faq_items(body):
    """FAQ from the page's own <details> questions, so the markup always matches what's visible."""
    return re.findall(r"<details><summary>(.*?)</summary><p>(.*?)</p></details>", body, re.S)


def faq_ld(pairs):
    return {"@type": "FAQPage", "mainEntity": [{"@type": "Question", "name": strip(q), "acceptedAnswer": {"@type": "Answer", "text": strip(a)}} for q, a in pairs]}


def crumbs(*items):
    return {"@type": "BreadcrumbList", "itemListElement": [
        {"@type": "ListItem", "position": i, "name": n, "item": u} for i, (n, u) in enumerate([(APP, SITE + "/"), *items], 1)]}


def article_ld(url, headline, description, published, modified):
    return {"@type": "Article", "@id": url + "#article", "headline": headline[:110], "description": description,
            "url": url, "mainEntityOfPage": url, "image": OG_IMAGE, "inLanguage": "en",
            "datePublished": schema_datetime(published), "dateModified": schema_datetime(modified),
            "author": {"@id": SITE + "/#tablamigo"}, "publisher": {"@id": SITE + "/#tablamigo"}}


def app_ld():
    """The Android app (installed from Google Play) and the web app, every price in rupees (INR) so the two never disagree on currency.
    The Android app is a free download with a single Offer at price 0: Plus is billed by Google Play in the buyer's currency, and no
    Google Play price is recorded anywhere we can verify (see PRICING above), so no Plus offer is listed there. The web app lists the
    free offer, the two Plus subscriptions and the Trip Pass it sells through Razorpay, at the prices above."""
    shots = [f"{SITE}/screens/{s}.webp" for s in SCREENS]
    common = {"applicationCategory": "TravelApplication", "applicationSubCategory": "Social networking",
              "description": DEFINITION, "image": SITE + "/icon.png", "screenshot": shots, "featureList": FEATURES,
              "datePublished": schema_datetime(LAUNCHED), "inLanguage": "en",
              "author": {"@id": SITE + "/#tablamigo"}, "publisher": {"@id": SITE + "/#tablamigo"}}
    free = lambda cur: {"@type": "Offer", "name": "Free", "price": "0", "priceCurrency": cur, "category": "free"}
    plus = lambda name, price, every: {"@type": "Offer", "name": name, "price": str(price), "priceCurrency": "INR", "category": "subscription",
                                       "description": f"Optional. Billed {every} through Razorpay and renews until cancelled."}
    trip_pass = {"@type": "Offer", "name": "Tablamigo Trip Pass", "price": str(TRIP_PASS_INR), "priceCurrency": "INR", "category": "one-time purchase",
                 "description": "Optional. 14 days of Plus, paid once through Razorpay, with nothing to renew."}
    return [
        {"@type": "MobileApplication", "@id": SITE + "/#app", "name": APP, "alternateName": ALT_NAMES + ["Tablamigo: Meet Solo Travelers"],
         "identifier": "com.tablamigo.app", "operatingSystem": "Android 7.0 or later",
         "url": SITE + "/", "installUrl": PLAY, "downloadUrl": DOWNLOAD, "sameAs": [PLAY], **common, "offers": [free("INR")]},
        {"@type": "WebApplication", "@id": SITE + "/#webapp", "name": APP + " web app", "operatingSystem": "Any modern web browser, including Safari on iPhone",
         "browserRequirements": "Requires JavaScript", "url": SITE + "/app/", **common,
         "offers": [free("INR"), plus("Tablamigo Plus, monthly", PLUS_MONTH_INR, "monthly"), plus("Tablamigo Plus, yearly", PLUS_YEAR_INR, "yearly"), trip_pass]},
    ]


def cities_list(cities):
    return '<ul class="cities">' + "".join(f'<li><a href="/solo-travel/{c["slug"]}">{H.escape(c["city"])}</a>, {H.escape(c["country"])}</li>' for c in cities) + "</ul>"


def city_guide_links(cities):
    """<!-- city-guides -->: one line linking every indexed city guide, India first as on /solo-travel. On 22 Oct 2026 Search Console
    listed Goa, Manali, Delhi, Kasol, Bali, Bangkok and Chiang Mai as "Discovered - currently not indexed": they sat two clicks deep,
    behind /solo-travel. Thin guides (THIN_GUIDES) are noindex, so they are left out."""
    full = sorted((c for c in cities if c["slug"] not in THIN_GUIDES), key=lambda c: c.get("cc") != "IN")
    return ('<p class="sub" style="margin-top:28px">City guides: '
            + " · ".join(f'<a href="/solo-travel/{c["slug"]}">{H.escape(c["city"])}</a>' for c in full)
            + ' · <a href="/solo-travel">all solo travel guides</a></p>')


def sourced_items(items):
    """A <ul> of named, sourced entries ({"name", "why", "source", "checked"}), each linking the page it was checked on."""
    def source(x):
        site = re.sub(r"^www\.", "", urlsplit(x["source"]).netloc)
        return f' <span class="small">(source: <a href="{H.escape(x["source"])}">{H.escape(site)}</a>)</span>'
    return "<ul>" + "".join(f"<li><strong>{H.escape(x['name'])}</strong>: {H.escape(x['why'])}{source(x)}</li>" for x in items) + "</ul>\n"


def checked_on(items):
    return datetime.date.fromisoformat(max(x["checked"] for x in items)).strftime("%B %-d, %Y")


# Hand-written links a guide carries beyond the template (HTML, so they live here rather than in cities.json). "tips" goes after its
# solo tips, "extra" after its extra sections (cities.json "extra") and "best" after its best-time paragraph. Most point on to the
# guide the keyword plan of 11 Oct 2026 pairs it with: Manali and Leh with Spiti Valley, Goa and Hampi with Gokarna, McLeod Ganj with
# Bir Billing. Spiti's entries link the Spiti guides that its Manali tip and its winter reading come from (cities.json text can't carry
# a link).
SPITI_SEASON = "https://discoverwithdheeraj.com/spiti-valley-season-to-travel/"  # updated 10 Oct 2026, checked 11 Oct 2026
SPITI_TRANSPORT = "https://discoverwithdheeraj.com/budget-trip-to-spiti-valley-public-transport/"  # updated 8 Aug 2026, checked 11 Oct 2026
CITY_LINKS = {
    "spiti-valley": {"tips": f'<p>Coming from Manali? Ask around there first: <a href="{SPITI_TRANSPORT}">one Spiti public-transport guide</a> says '
                             'you have a better chance of finding people heading to Spiti in Manali than on the Shimla and Kinnaur side.</p>\n',
                     "best": f'<p>Met officials reported minus 10.8°C at Tabo on the night of 5 January 2026, according to '
                             f'<a href="{SPITI_SEASON}">this Spiti season guide</a>, which cites PTI.</p>\n'},
    "manali": {"tips": '<p>Manali is where the roads to Spiti and Ladakh start. Heading on? See <a href="/solo-travel/spiti-valley">meeting travelers in Spiti Valley</a>, '
                       'where travelers have to find each other to share a taxi out of Kaza, and <a href="/solo-travel/leh">Leh-Ladakh</a>.</p>\n'},
    "leh": {"extra": '<p>Doing Spiti too? Our <a href="/solo-travel/spiti-valley">Spiti Valley guide</a> covers Kaza, the two roads in, and why a shared taxi is '
                     'harder to find there than in Leh.</p>\n'},
    "goa": {"tips": '<p>Want a smaller beach town next? <a href="/solo-travel/gokarna">Gokarna</a>, in Karnataka, has its own run of beaches and backpacker hostels.</p>\n'},
    "hampi": {"tips": '<p>Heading to the coast after Hampi? Here is <a href="/solo-travel/gokarna">our guide to Gokarna</a>.</p>\n'},
    "mcleod-ganj": {"tips": '<p><a href="/solo-travel/bir-billing">Bir Billing</a>, the paragliding village, is about 50 km from Dharamshala, two to three hours by road.</p>\n'},
}


def city_women(c):
    """'<city> solo trip as a woman', for India guides: female-only dorms and women-only trips checked on their sources (cities.json
    "women"). A guide with no checked entries says so instead of guessing. Women-only plans are in the template's "Find a travel
    buddy" list, so this section doesn't repeat them, and it is the guide's one link to each of the two women's pages."""
    city = H.escape(c["city"])
    if c.get("women"):
        items = (f"<p>What we could check on the sources linked below, on {checked_on(c['women'])}:</p>\n" + sourced_items(c["women"]))
    elif c.get("hostels"):
        items = ("<p>We couldn't confirm a female-only dorm at the hostels above from their own websites, so ask the hostel before you book.</p>\n")
    else:
        items = ("<p>We haven't checked a hostel with a female-only dorm here, so ask your guesthouse or homestay about rooms before you book.</p>\n")
    return (f"<h2>{city} solo trip as a woman</h2>\n" + items
            + "<p>More in <a href=\"/solo-female-travel-india\">solo female travel in India</a>, and "
              "women-only group trips in <a href=\"/solo-trip-with-strangers-india#women\">solo trips with strangers</a>.</p>\n")


def city_extra(c):
    """Extra sourced sections a guide carries (cities.json "extra": [{"title", "intro", "items"}]), such as Leh's shared taxis."""
    return "".join(f"<h2>{H.escape(x['title'])}</h2>\n<p>{H.escape(x['intro'])}</p>\n" + sourced_items(x["items"]) for x in c.get("extra", []))


def women_dorms(cities):
    """<!-- women-dorms -->: every hostel in an India guide whose female-only dorm we checked (cities.json "women", leaving out the
    group trips marked "trip"), so /solo-female-travel-india and the guides always list the same hostels with the same dates."""
    rows = []
    for c in cities:
        if c.get("cc") != "IN":
            continue
        for x in c.get("women", []):
            if x.get("trip"):
                continue
            site = re.sub(r"^www\.", "", urlsplit(x["source"]).netloc)
            date = datetime.date.fromisoformat(x["checked"]).strftime("%-d %B %Y")
            rows.append(f'<tr><td><strong>{H.escape(x["name"])}</strong></td><td><a href="/solo-travel/{c["slug"]}">{H.escape(c["city"])}</a></td>'
                        f'<td>{H.escape(x["why"])}</td><td><a href="{H.escape(x["source"])}">{H.escape(site)}</a>, {date}</td></tr>')
    return ('<table><thead><tr><th scope="col">Hostel</th><th scope="col">Guide</th><th scope="col">What its own site says</th>'
            '<th scope="col">Checked</th></tr></thead><tbody>' + "".join(rows) + "</tbody></table>")


def city_getting_there(c):
    """'Getting to <city>' from the origin cities people search with ("solo trip to Gokarna from Bangalore"), as sourced lines
    (cities.json "getting_there"), so those searches land on the guide instead of needing a page per origin city."""
    if not c.get("getting_there"):
        return ""
    return (f"<h2>Getting to {H.escape(c['city'])}</h2>\n<p>Checked on the sources linked below on {checked_on(c['getting_there'])}. "
            "Timetables and fares change, so confirm before you travel.</p>\n" + sourced_items(c["getting_there"]))


def city_places(c):
    """Named hostels and meeting spots for a city guide, from the optional "hostels" and "meet_spots" lists in cities.json.
    Every entry carries the source it was checked against ("source") and the date ("checked"); the page shows the date and links
    each entry's source, so a reader or an answer engine can trace the claim (audit F3, 11 Oct 2026).
    A city with neither list gets an empty string, so its page is unchanged."""
    def checked(items):
        return datetime.date.fromisoformat(max(x["checked"] for x in items)).strftime("%B %-d, %Y")
    def source(x):
        site = re.sub(r"^www\.", "", urlsplit(x["source"]).netloc)
        return f' <span class="small">(source: <a href="{H.escape(x["source"])}">{H.escape(site)}</a>)</span>'
    city, out = H.escape(c["city"]), ""
    if c.get("hostels"):
        out += (f"<h2>Social hostels in {city}</h2>\n<p>Hostels where meeting other travelers is part of the stay. We checked each one on "
                f"its own website or booking listing, linked below, on {checked(c['hostels'])}. Events and prices change, so check before you book.</p>\n<ul>"
                + "".join(f"<li><strong>{H.escape(x['name'])}</strong> ({H.escape(x['area'])}): {H.escape(x['why'])}{source(x)}</li>" for x in c["hostels"])
                + "</ul>\n<p>Staying in one? Here's <a href=\"/how-to-meet-people-in-hostels\">how to meet people in hostels</a>, "
                "with or without an app.</p>\n")
    if c.get("meet_spots"):
        out += (f"<h2>Where solo travelers meet in {city}</h2>\n<p>Places and regular events that are easy to join on your own, checked against "
                f"the sources linked below on {checked(c['meet_spots'])}. Times shift with the season, so confirm on the day. Going to one? Post it "
                f"as a plan on Tablamigo so travelers nearby can join you.</p>\n<ul>"
                + "".join(f"<li><strong>{H.escape(x['name'])}</strong>: {H.escape(x['why'])}{source(x)}</li>" for x in c["meet_spots"])
                + "</ul>\n")
    return out


def city_pages():
    """One page per city: real local detail, so it is useful on its own, not a keyword doorway. It never claims
    that people or plans already exist there."""
    cities = load_cities()
    # Cross-links stay inside a city's own group (India or the rest of the world): each guide links the next six in its
    # group, wrapping round, so every guide in a group of seven or more receives exactly six links from its neighbours.
    groups = {g: [c for c in cities if (c.get("cc") == "IN") == g] for g in (True, False)}
    pages = []
    for c in cities:
        city = H.escape(c["city"])
        faq = [
            (f"How do I meet other solo travelers in {c['city']}?", f"Open Tablamigo in {c['city']} to see plans other travelers have posted nearby, like dinners, drinks, day trips and coworking, and join one with a tap. If there's nothing on the map yet, post your own plan and the next traveler who opens the app nearby will see it."),
            (f"Where do travelers hang out in {c['city']}?", " ".join(f"{a[0]}: {a[1]}" for a in c["areas"][:3])),
            (f"Is {c['city']} safe for solo travelers?", " ".join(c["safety"])),
            (f"When is the best time to visit {c['city']}?", c["best"]),
        ] + [tuple(x) for x in c.get("faq", [])]  # a guide's own questions (cities.json "faq": [[question, answer]]), after the template's
        areas = "".join(f"<li><strong>{H.escape(a)}</strong>: {H.escape(b)}</li>" for a, b in c["areas"])
        plans = "".join(f"<li>{H.escape(x)}</li>" for x in c["plans"])
        safety = "".join(f"<li>{H.escape(x)}</li>" for x in c["safety"])
        tips = ("<h2>Solo tips for " + city + "</h2><ul>" + "".join(f"<li>{H.escape(x)}</li>" for x in c["tips"]) + "</ul>") if c.get("tips") else ""
        own = CITY_LINKS.get(c["slug"], {})
        if own.get("tips"):
            tips += "\n" + own["tips"].rstrip("\n")
        india_guide = c.get("cc") == "IN"
        extra = city_getting_there(c) + city_extra(c) + own.get("extra", "")
        women = city_women(c) if india_guide else ""
        faqs = "".join(f"<details><summary>{H.escape(q)}</summary><p>{H.escape(a)}</p></details>" for q, a in faq)
        places = city_places(c)
        affiliate = city_affiliate(c)
        group = groups[c.get("cc") == "IN"]
        j = group.index(c)
        others = (group[j + 1:] + group[:j])[:6]
        links = " · ".join(f'<a href="/solo-travel/{o["slug"]}">Solo travel in {H.escape(o["city"])}</a>' for o in others)
        # The women's section above links /solo-female-travel-india, so this line doesn't repeat it.
        india = (' Traveling around India? See <a href="/solo-travel-india">solo travel in India: where to go and meet travelers</a>, '
                 '<a href="/travel-buddy-app-india">travel buddy apps in India, compared</a> '
                 'and <a href="/solo-trip-with-strangers-india">three ways to take a solo trip with strangers</a>.') if india_guide else ""
        url = f"{SITE}/solo-travel/{c['slug']}"
        # "meet travelers in <city>" is the phrase people search (KEYWORDS.md #11), so the title and H1 lead with it. "display" is the
        # name people search for when it differs from the town's (Leh is searched as "Leh-Ladakh"); the rest of the page uses "city".
        name = c.get("display") or c["city"]
        heading = f"Meet travelers in {name} on a solo trip"
        title = f"{heading} | Tablamigo"
        if len(title) > 60:
            heading = f"Meet travelers in {name}"
            title = f"{heading} | Tablamigo"
        desc = c.get("description") or f"Traveling solo in {name}? Where travelers meet, plans worth joining, local safety tips and the best time to go, plus how to find company tonight."
        if len(desc) > 155:
            desc = f"Solo in {name}? Where travelers meet, plans to join, safety tips and the best time to go, plus how to find company tonight."
        body = f"""
<main class="wrap doc">
<p class="updated"><a href="/solo-travel">Solo travel guides</a> › {city}</p>
<h1>{c['emoji']} {H.escape(heading)}</h1>
<p class="lead">{H.escape(c['intro'])}</p>
<p><a class="btn primary" href="/download">Find people to meet in {city}</a></p>
<h2>Where travelers meet in {city}</h2>
<ul>{areas}</ul>
{places}<h2>Good plans to join or post in {city}</h2>
<p>Ideas that suit {city}. If one is already on the Tablamigo map, join it. If not, post it and let travelers nearby join you.</p>
<ul>{plans}</ul>
{affiliate}<h2>Safety tips for {city}</h2>
<ul>{safety}</ul>
<p>Meet in busy public places and keep chats in the app until you're comfortable. More in our <a href="/safety">safety guide</a>.</p>
{tips}
{extra}{women}<h2>Find a travel buddy for {city}</h2>
<p>Tablamigo is an app for meeting other travelers nearby. Here's how it helps in {city}.</p>
<ul>
<li><strong>Plans on a map.</strong> See what travelers near you in {city} have posted, listed by start time with plans from Plus members first, and join with one tap. You land in that plan's group chat.</li>
<li><strong>Post your own.</strong> Tablamigo is new, so {city} may be quiet on the map. A specific plan with a place and a time is the quickest way to get company.</li>
<li><strong>Before you arrive.</strong> Add {city} as a trip to see who'll be there on your dates, and join the city chat for people arriving soon.</li>
<li><strong>Women-only plans.</strong> Women can host plans that only other women can see and join. Gender is self-declared on the profile, so meet somewhere busy first.</li>
</ul>
<h2>Best time to go</h2>
<p>{H.escape(c['best'])}</p>
{own.get('best', '')}<h2>Questions</h2>
{faqs}
<div class="callout"><strong>Heading somewhere else?</strong> {links}</div>
<p>New to Tablamigo? See <a href="/travel-buddy-app">how the travel buddy app works</a>, <a href="/how-to-meet-people-while-traveling-solo">ways to meet people when you travel alone</a> and <a href="/best-apps-to-meet-travelers">the best apps to meet travelers, compared</a>. Used Nomadtable before? Here's <a href="/nomadtable-alternative">how Tablamigo compares with Nomadtable</a>. Working remotely? Here's <a href="/digital-nomad-meetups">how to find digital nomad meetups</a>.{india}</p>
</main>
"""
        pages.append(dict(rel=f"solo-travel/{c['slug']}.html", url=url, title=title, description=desc, body=body,
                          kind="article", headline=heading, faq=faq, noindex=c["slug"] in THIN_GUIDES,
                          trail=[("Solo travel", SITE + "/solo-travel"), (c["city"], url)]))
    # The hub leads with the guides that carry sourced hostels and meeting spots (India first, then the rest of the world); the
    # 28 shorter, noindexed guides (THIN_GUIDES) follow under their own heading, so the grid doesn't give them equal weight.
    card = lambda c: (f'<a class="feat" style="text-decoration:none;color:inherit" href="/solo-travel/{c["slug"]}"><div class="ic">{c["emoji"]}</div>'
                      f'<h3>{H.escape(c["city"])}</h3><p>{H.escape(c["country"])}</p></a>')
    full_in = [c for c in cities if c["slug"] not in THIN_GUIDES and c.get("cc") == "IN"]
    full_world = [c for c in cities if c["slug"] not in THIN_GUIDES and c.get("cc") != "IN"]
    short = [c for c in cities if c["slug"] in THIN_GUIDES]
    hub = f"""
<main class="wrap doc" style="max-width:1120px">
<h1>Solo travel city guides: where travelers meet</h1>
<p class="lead">Where solo travelers actually meet, plans worth joining and what to watch out for, city by city. The full guides list social hostels and meeting spots we checked on their own websites; every guide covers the neighbourhoods travelers use, meetup-friendly plans, local safety tips and the best time to go.</p>
<h2>Guides for India</h2>
<div class="grid3">{"".join(card(c) for c in full_in)}</div>
<h2>Guides outside India</h2>
<div class="grid3">{"".join(card(c) for c in full_world)}</div>
<h2>Traveling in India?</h2>
<p>Start with <a href="/solo-travel-india">solo travel in India: where to go and meet travelers</a>. The newest guides are <a href="/solo-travel/spiti-valley">Spiti Valley</a>, where travelers team up in Kaza to share taxis, <a href="/solo-travel/gokarna">Gokarna</a>, a temple town with a string of beaches on the Karnataka coast, and <a href="/solo-travel/bir-billing">Bir Billing</a>, known as India's paragliding capital. Want company for the whole trip? <a href="/solo-trip-with-strangers-india">Solo trips with strangers in India</a> compares group trips, hostel-run trips and going alone. Traveling as a woman? See <a href="/solo-female-travel-india">solo female travel in India</a>.</p>
<h2>Shorter guides</h2>
<p>These cover neighbourhoods, plans, safety tips and the best time to go, without a checked list of hostels and meeting spots yet.</p>
<div class="grid3">{"".join(card(c) for c in short)}</div>
<div class="callout" style="margin-top:32px"><strong>Want company wherever you are?</strong> <a href="/travel-buddy-app">Tablamigo, the travel buddy app</a> shows plans from travelers nearby in any city. New to traveling alone? Start with <a href="/how-to-meet-people-while-traveling-solo">how to meet people while traveling solo</a>. Coming from Nomadtable? Here's <a href="/nomadtable-alternative">an honest comparison</a>.</div>
</main>
"""
    ordered = full_in + full_world + short
    pages.append(dict(rel="solo-travel.html", url=SITE + "/solo-travel", title="Solo travel guides: meet travelers city by city | Tablamigo",
                      description=f"Where solo travelers meet, city by city: Goa, Rishikesh, Manali, Leh and {len(full_in) - 4} more in India, plus Bangkok, Chiang Mai and Bali, with checked hostels.",
                      body=hub, kind="collection", trail=[("Solo travel", SITE + "/solo-travel")],
                      extra_ld=[{"@type": "ItemList", "itemListElement": [{"@type": "ListItem", "position": n, "name": c["city"], "url": f"{SITE}/solo-travel/{c['slug']}"} for n, c in enumerate(ordered, 1)]}]))
    return pages


def demo_video_ld():
    """The demo as a schema.org VideoObject on the home page: the wide cut's MP4 and WebP poster by absolute (plain) URL."""
    wide = DEMO_CUTS["wide"]
    said = " ".join(line for line, _ in DEMO_TRANSCRIPT)
    return {"@type": "VideoObject", "@id": SITE + "/#demo-video", "name": DEMO_LABEL,
            "description": ("How Tablamigo works: see plans from travelers near you on the map, join a plan's group chat with one tap, "
                            "run a poll and go, post your own plan or tap Ideas for your city, and add your next city to see who will "
                            "be there on your dates. Safety: 18+ only, distances rounded to 0.5 km, women-only plans and a selfie check. "
                            "Free to join; Plus is optional."),
            "thumbnailUrl": SITE + wide["base"] + ".webp", "contentUrl": SITE + wide["base"] + ".mp4",
            "uploadDate": schema_datetime(DEMO_UPLOADED), "duration": f"PT{round(DEMO_SECONDS)}S", "width": wide["width"], "height": wide["height"],
            "inLanguage": "en", "transcript": said, "publisher": {"@id": SITE + "/#tablamigo"}, "about": {"@id": SITE + "/#app"}}


DEMO_CSS = """
.demo { max-width: 880px; margin: 48px auto 0; }
.demo-box { position: relative; aspect-ratio: 16 / 9; border-radius: var(--r); overflow: hidden; background: var(--bg-soft); box-shadow: 0 10px 30px rgba(40, 20, 10, .12); }
.demo-box img, .demo-box video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.demo-play { position: absolute; inset: 0; display: flex; align-items: flex-end; justify-content: flex-start; padding: 4%; border: 0; background: transparent; cursor: pointer; text-decoration: none; font: inherit; }
.demo-play[hidden], .demo-nojs-wide { display: none; }
@media DEMO_MEDIA { .demo-nojs-wide { display: flex; } .demo-nojs-narrow { display: none; } }
.demo-pill { display: inline-flex; align-items: center; gap: 8px; height: 48px; padding: 0 18px 0 14px; border-radius: 999px; background: var(--cta); color: #fff; font: inherit; font-size: 15px; font-weight: 700; line-height: 1; box-shadow: 0 10px 24px -8px rgba(208, 57, 26, .8); }
.demo-play:hover .demo-pill, .demo-play:focus-visible .demo-pill { background: var(--primary-dark); }
.demo-spin { display: none; width: 20px; height: 20px; border-radius: 50%; border: 3px solid rgba(255, 255, 255, .35); border-top-color: #fff; animation: demo-spin .8s linear infinite; }
.demo-play.loading .demo-spin { display: block; } .demo-play.loading svg { display: none; }
@keyframes demo-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .demo-spin { animation: none; } }
.demo-failed { position: absolute; left: 12px; right: 12px; bottom: 12px; margin: 0; padding: 8px 12px; border-radius: 12px; background: rgba(22, 22, 29, .85); color: #fff; font-size: 14px; text-align: center; outline: none; }
.demo-failed:empty { left: 0; bottom: 0; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); }
.demo figcaption { margin-top: 10px; color: var(--ink3); font-size: 14px; text-align: center; }
.demo-transcript { max-width: 880px; margin: 0 auto; }
.demo-transcript summary { font-size: 15px; }
.demo-transcript ul { margin: 10px 0 0; padding-left: 20px; color: var(--ink2); }
.demo-transcript small { color: var(--ink3); }
"""


def demo_video_html():
    """The <!-- demo-video --> block: a poster <picture> behind a <video> that loads nothing before play, a play button the script
    below shows (a link to the MP4 without JS), an empty status line for a failure, a caption, and the transcript."""
    w, n = DEMO_CUTS["wide"], DEMO_CUTS["narrow"]
    webm = lambda c: f"video/webm; codecs=&quot;{c['av1']}, opus&quot;"
    lines = "".join(f"<li>{H.escape(said)}" + (f"<br><small>On screen: {H.escape(shown)}</small>" if shown else "") + "</li>"
                    for said, shown in DEMO_TRANSCRIPT)
    pill = ('<span class="demo-pill"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" '
            'd="M8 5v14l11-7z"/></svg><span class="demo-spin" aria-hidden="true"></span>Watch in 50 s</span>')
    label = H.escape(DEMO_LABEL)
    # Behind the video with JS (a frameless video with no controls is transparent). Without JS, Chrome shows a video's native
    # controls whatever its attributes say, and their grey panel would cover it, so <noscript> repeats it on top (same URLs, one fetch).
    poster = (f'<picture><source media="{DEMO_MEDIA}" type="image/avif" srcset="{w['base']}.avif" width="{w['width']}" height="{w['height']}">'
              f'<source media="{DEMO_MEDIA}" type="image/webp" srcset="{w['base']}.webp" width="{w['width']}" height="{w['height']}">'
              f'<source type="image/avif" srcset="{n['base']}.avif" width="{n['width']}" height="{n['height']}">'
              f'<img src="{n['base']}.webp" width="{n['width']}" height="{n['height']}" alt="" loading="lazy" decoding="async" fetchpriority="low"></picture>')
    return f"""<figure class="demo" id="demo">
      <div class="demo-box" data-demo>
        {poster}
        <video playsinline preload="none" tabindex="-1" aria-label="{label}">
          <source src="{w['base']}.webm" media="{DEMO_MEDIA}" type="{webm(w)}">
          <source src="{w['base']}.mp4" media="{DEMO_MEDIA}" type="video/mp4">
          <source src="{n['base']}.webm" type="{webm(n)}">
          <source src="{n['base']}.mp4" type="video/mp4">
        </video>
        <noscript>{poster}<a class="demo-play demo-nojs-narrow" href="{n['base']}.mp4" aria-label="{label} (MP4)">{pill}</a><a class="demo-play demo-nojs-wide" href="{w['base']}.mp4" aria-label="{label} (MP4)">{pill}</a></noscript>
        <button class="demo-play" type="button" aria-label="Play the Tablamigo demo video, 50 seconds, with sound" hidden>{pill}</button>
        <p class="demo-failed" role="status" tabindex="-1"></p>
      </div>
      <figcaption>Tablamigo in 50 seconds, with sound. The app screens are the real app with sample data.</figcaption>
    </figure>
    <details class="demo-transcript"><summary>Transcript of the video</summary><ul>{lines}</ul></details>
    <script>
      // The demo video (build.py, DEMO_CUTS). No native controls until a frame plays: Chrome paints a grey panel over a frameless
      // video that has them, which would cover the poster. The play button covers the poster and turns into a spinner once pressed.
      // If every source fails, the poster stays and the status line points at the transcript.
      (function () {{
        var box = document.querySelector('[data-demo]');
        if (!box) return;
        var v = box.querySelector('video'), play = box.querySelector('button.demo-play'), status = box.querySelector('.demo-failed');
        var done = false;
        var focusHere = function () {{ return document.activeElement === play || document.activeElement === v; }};
        play.hidden = false;
        play.addEventListener('click', function () {{
          if (done) return;
          play.classList.add('loading');
          play.setAttribute('aria-label', 'Loading the Tablamigo demo video');
          var p = v.play();
          if (p && p.catch) p.catch(function () {{
            if (done) return;
            play.classList.remove('loading');
            play.setAttribute('aria-label', 'Play the Tablamigo demo video, 50 seconds, with sound');
          }});
        }});
        v.addEventListener('playing', function () {{
          if (done) return;
          done = true;
          var refocus = focusHere();
          play.hidden = true;
          v.controls = true;
          v.removeAttribute('tabindex');
          if (refocus) v.focus();
        }});
        // Only on an error event: right after parsing, networkState is NETWORK_NO_SOURCE (3) until the browser has picked a
        // source, so reading it anywhere else would mistake every page load for a failure. After the last <source> fails it stays 3.
        v.addEventListener('error', function () {{
          if (done || !(v.networkState === 3 || v.error)) return;
          done = true;
          var refocus = focusHere();
          play.hidden = true;
          v.pause();
          status.textContent = "The video didn't load. The transcript below has every line of it.";
          if (refocus) status.focus();
        }}, true);
      }})();
    </script>"""


def hash_assets():
    """Copies each HASHED file in dist/ to NAME.<hash>.EXT and returns {"/plain/path": "/hashed/path"}."""
    out = {}
    for pattern in HASHED:
        for f in sorted(DIST.glob(pattern)):
            digest = hashlib.sha256(f.read_bytes()).hexdigest()[:10]
            hashed = f.with_name(f"{f.stem}.{digest}{f.suffix}")
            shutil.copyfile(f, hashed)
            out["/" + f.relative_to(DIST).as_posix()] = "/" + hashed.relative_to(DIST).as_posix()
    return out


def use_hashed(page, assets):
    """Points src, srcset and CSS url() at the hashed names. href and absolute URLs (schema, Open Graph) are left alone."""
    one = lambda u: assets.get(u, u)
    page = re.sub(r'(\ssrc=")(/[^"]+)"', lambda m: f'{m.group(1)}{one(m.group(2))}"', page)
    page = re.sub(r'(\ssrcset=")([^"]+)"', lambda m: m.group(1) + ", ".join(
        " ".join([one(c.split()[0]), *c.split()[1:]]) for c in m.group(2).split(",")) + '"', page)
    return re.sub(r"url\((/[^)]+)\)", lambda m: f"url({one(m.group(1))})", page)


def favicon_ico():
    """/favicon.ico for browsers and crawlers that ask for it by that name: favicon.png (48x48) inside an ICO container
    (one directory entry pointing at the PNG bytes, which every current browser reads)."""
    png = (ROOT / "favicon.png").read_bytes()
    w, h = int.from_bytes(png[16:20], "big"), int.from_bytes(png[20:24], "big")
    if png[:8] != b"\x89PNG\r\n\x1a\n" or w > 256 or h > 256:
        raise ValueError("favicon.png must be a PNG of at most 256x256")
    entry = bytes([w % 256, h % 256, 0, 0]) + (1).to_bytes(2, "little") + (32).to_bytes(2, "little") \
        + len(png).to_bytes(4, "little") + (6 + 16).to_bytes(4, "little")
    (DIST / "favicon.ico").write_bytes((0).to_bytes(2, "little") + (1).to_bytes(2, "little") + (1).to_bytes(2, "little") + entry + png)


def content_hash(title, description, body):
    """lastmod = the date a page's own content last changed: its title, description and body, not the shared
    nav, footer or CSS (a footer link shouldn't make 50 pages look freshly updated)."""
    return hashlib.sha256("\n".join([title, description, body]).encode()).hexdigest()[:16]


def lastmods(pages):
    """Dates are kept in lastmod.json, which is committed so they survive rebuilds on any machine.
    'first' is the date a URL was first built (datePublished); 'date' is the last content change."""
    store = ROOT / "lastmod.json"
    known = json.loads(store.read_text()) if store.exists() else {}
    today = datetime.date.today().isoformat()
    out = {}
    for p in pages:
        digest = content_hash(p["title"], p["description"], p["body"])
        prev = dict(known.get(p["url"]) or {})
        first = prev.get("first") or (FIRST_PUBLISHED if prev else today)
        if prev.get("v") != 2:  # hash scheme changed on 29 Sep 2026: adopt the new hash, keep the known date
            prev = {"hash": digest, "date": prev.get("date", today)}
        elif prev["hash"] != digest:
            prev = {"hash": digest, "date": today}
        out[p["url"]] = {**prev, "first": first, "v": 2}
    if out != known:
        store.write_text(json.dumps(out, indent=1, sort_keys=True) + "\n")
    return out


def html_to_text(body):
    """Readable plain text of a page's <main>, for llms-full.txt."""
    # The demo video's block (player, script, transcript) is not page copy.
    t = re.sub(r'<figure class="demo".*?</figure>|<details class="demo-transcript">.*?</details>|<noscript>.*?</noscript>', "", body, flags=re.S)
    t = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", t, flags=re.S)
    t = re.sub(r"<h1[^>]*>(.*?)</h1>", lambda m: "\n# " + strip(m.group(1)) + "\n", t, flags=re.S)
    t = re.sub(r"<h2[^>]*>(.*?)</h2>", lambda m: "\n## " + strip(m.group(1)) + "\n", t, flags=re.S)
    t = re.sub(r"<h3[^>]*>(.*?)</h3>", lambda m: "\n### " + strip(m.group(1)) + "\n", t, flags=re.S)
    t = re.sub(r"<summary>(.*?)</summary>", lambda m: "\nQ: " + strip(m.group(1)) + "\nA: ", t, flags=re.S)
    t = re.sub(r"<tr[^>]*>(.*?)</tr>", lambda m: "\n| " + " | ".join(strip(c) for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", m.group(1), re.S)) + " |", t, flags=re.S)
    t = re.sub(r"<li[^>]*>", "\n- ", t)
    t = re.sub(r"</(p|div|ul|ol|table|details)>", "\n", t)
    t = re.sub(r"<br\s*/?>", "\n", t)
    t = H.unescape(re.sub(r"<[^>]+>", "", t))
    lines = [re.sub(r"[ \t]+", " ", l).strip() for l in t.splitlines()]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def render(p, dates, shell, foot):
    url, d = p["url"], dates[p["url"]]
    body = p["body"]
    graph = []
    kind = p.get("kind")
    if kind == "home":
        # WebSite on the home page is what Google reads for the site name it shows above each result. It names Tablamigo, not
        # Hookstep, so results from this subdomain can be labelled "Tablamigo" instead of "hookstep.in" / "HookStep".
        graph += app_ld() + [ORG, TABLAMIGO_ORG, {"@type": "WebSite", "@id": SITE + "/#website", "name": APP, "alternateName": ALT_NAMES,
                                                  "url": SITE + "/", "inLanguage": "en", "description": DEFINITION,
                                                  "about": {"@id": SITE + "/#app"}, "publisher": {"@id": SITE + "/#tablamigo"}}]
        if 'class="demo-box" data-demo' in body:  # src_pages put demo_video_html() in place of <!-- demo-video -->
            graph.append(demo_video_ld())
    else:
        graph += [ORG, TABLAMIGO_ORG]
    if kind == "article":
        graph.append(article_ld(url, p.get("headline") or strip(re.search(r"<h1[^>]*>(.*?)</h1>", body, re.S).group(1)), p["description"], d["first"], d["date"]))
        # A visible date that matches dateModified, after the H1.
        body = re.sub(r"(</h1>)", r'\1\n<p class="small">Updated ' + datetime.date.fromisoformat(d["date"]).strftime("%-d %B %Y") + ' · By the Tablamigo team</p>', body, count=1)
    if kind == "about":
        graph.append({"@type": "AboutPage", "@id": url + "#page", "url": url, "name": p["title"], "about": {"@id": SITE + "/#app"}, "publisher": {"@id": SITE + "/#tablamigo"}, "dateModified": schema_datetime(d["date"])})
        graph += app_ld()
    if kind == "collection":
        graph.append({"@type": "CollectionPage", "@id": url + "#page", "url": url, "name": p["title"], "dateModified": schema_datetime(d["date"])})
    if p["rel"] == "download.html":  # the page is about getting the app, so the app's own nodes (and offers) are on it too
        graph += app_ld()
    graph += p.get("extra_ld", [])
    pairs = p.get("faq") or faq_items(body)
    if pairs:
        graph.append(faq_ld(pairs))
    if p.get("trail"):
        graph.append(crumbs(*p["trail"]))
    extra = jsonld({"@context": "https://schema.org", "@graph": graph}) if kind != "404" else ""
    if 'class="demo-box" data-demo' in body:  # the demo video's CSS, on the one page that has it
        extra += "\n<style>" + re.sub(r"\s*\n\s*", "", DEMO_CSS).replace("DEMO_MEDIA", DEMO_MEDIA) + "</style>"
    canonical = "" if kind == "404" else f'<link rel="canonical" href="{url}">\n'
    robots = "noindex, follow" if kind == "404" or p.get("noindex") else "index, follow, max-image-preview:large, max-snippet:-1"
    head = HEAD.format(title=H.escape(p["title"]), description=H.escape(p["description"]), url=url, canonical=canonical,
                       robots=robots, ogtype="article" if kind == "article" else "website", og_image=OG_IMAGE,
                       extra=extra, **shell)
    if p["rel"] in NO_PLUS_LINK:  # the Play app opens these pages, so no link to the web price list in their menu
        head = head.replace('    <a href="/#plus">Plus</a>\n', "")
    if p["rel"] in NO_ONE_TAP:
        foot = foot.replace(ONE_TAP_TAG, "")
    if 'id="live-now"' in body or 'id="pc-live"' in body:
        foot = foot.replace("</body>", LIVE_TAG + "</body>")
    if INFOLINKS_TAG and infolinks_page(p["rel"]):
        foot = foot.replace("</body>", INFOLINKS_TAG + "</body>")
    if ADSENSE_TAG and adsense_page(p["rel"]):
        foot = foot.replace("</body>", ADSENSE_TAG + "</body>")
    return head + body + foot


def src_pages(cities):
    pages = []
    for page in sorted(SRC.glob("*.html")):
        raw = page.read_text()
        # <!-- standalone --> pages (the admin panel) ship as written: no site shell, not in the sitemap,
        # lastmod or llms.txt. nginx serves /admin with no-store + noindex headers.
        if raw.startswith("<!-- standalone -->"):
            (DIST / page.name).write_text(raw.split("\n", 1)[1])
            continue
        meta = dict(re.findall(r"<!--\s*(\w+):\s*(.*?)\s*-->", raw.split("\n\n", 1)[0]))
        body = re.sub(r"^(<!--.*?-->\s*)+", "", raw, flags=re.S)
        whatis = WHATIS.replace(' <a href="/about">About Tablamigo</a>', "") if page.stem == "about" else WHATIS
        body = body.replace("<!-- demo-video -->", demo_video_html()) if page.stem == "index" else body
        body = body.replace("<!-- live-now -->", LIVE_HOME).replace("<!-- popular-cities -->", popular_cities_html(POPULAR["cities"] if POPULAR["enabled"] else []))
        # The link to /popular-cities exists only once the page is enabled (unlinked while held).
        body = body.replace("<!-- popular-cities-link -->", '<p class="small"><a href="/popular-cities">Popular cities on Tablamigo right now</a></p>' if POPULAR["enabled"] else "")
        body = body.replace("<!-- cities -->", cities_list(cities)).replace("<!-- city-guides -->", city_guide_links(cities)).replace("<!-- whatis -->", whatis).replace("<!-- women-dorms -->", women_dorms(cities))
        body = re.sub(r"<!-- cities-in: (\w+) -->", lambda m: cities_list([c for c in cities if c.get("cc") == m.group(1)]), body)
        body = play_tokens(body)
        body = price_tokens(body)
        body = ads_tokens(body)
        for k, v in APK.items():  # the old sideload beta APK, from apk.json (only /download mentions it)
            body = body.replace("{{apk_" + k + "}}", H.escape(str(v)))
        slug = "" if page.stem == "index" else page.stem
        url = f"{SITE}/{slug}"
        kind = "home" if page.stem == "index" else "404" if page.stem == "404" else meta.get("type", "page")
        trail = None
        if "crumb" in meta:
            trail = [(meta["crumb"], url)]
            if meta.get("parent"):
                name, path = [x.strip() for x in meta["parent"].split("|")]
                trail.insert(0, (name, SITE + path))
        pages.append(dict(rel=page.name, url=url, title=meta["title"], description=meta["description"], body=body, kind=kind, trail=trail,
                          noindex=page.name in HELD_PAGES or page.name in UTILITY_PAGES))
    return pages


def build():
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()
    for asset in ROOT.glob("*"):
        if asset.suffix in {".css", ".png", ".svg", ".txt", ".xml", ".webmanifest", ".webp"} or asset.name in {".well-known", "screens", "fonts", "video"}:
            (shutil.copytree if asset.is_dir() else shutil.copy)(asset, DIST / asset.name)
    assets = hash_assets()
    favicon_ico()
    css = re.sub(r"\s*\n\s*", "", re.sub(r"/\*.*?\*/", "", (ROOT / "style.css").read_text(), flags=re.S))
    shell = dict(site=SITE, app=APP, css=css, os_js=OS_JS)
    foot = FOOT.format(year=datetime.date.today().year, play=store_badges("footer"), tm=PLAY_TM, play_js=PLAY_JS, one_tap=ONE_TAP_TAG, beacon=BEACON_TAG)
    cities = load_cities()
    pages = src_pages(cities) + city_pages()
    listed = [p for p in pages if p["kind"] != "404"]
    dates = lastmods(listed)
    dates[SITE + "/404"] = {"first": FIRST_PUBLISHED, "date": FIRST_PUBLISHED}
    for p in pages:
        out = DIST / p["rel"]
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(use_hashed(render(p, dates, shell, foot), assets))
    (DIST / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "".join(f"  <url><loc>{p['url']}</loc><lastmod>{dates[p['url']]['date']}</lastmod></url>\n" for p in listed if not p.get("noindex")) + "</urlset>\n")
    (DIST / f"{INDEXNOW_KEY}.txt").write_text(INDEXNOW_KEY)
    write_llms(listed, [c for c in cities if c["slug"] not in THIN_GUIDES])  # the thin guides are noindex, so llms.txt does not point at them
    # Everyone is welcome. The named AI crawlers are listed only to make the intent explicit; `*` already allows them.
    bots = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User", "PerplexityBot",
            "Perplexity-User", "Google-Extended", "Googlebot", "Bingbot", "Applebot", "Applebot-Extended", "CCBot", "Meta-ExternalAgent", "DuckAssistBot"]
    (DIST / "robots.txt").write_text("# All crawlers, including AI search and answer engines, are welcome.\n"
        + "".join(f"User-agent: {b}\n" for b in bots) + "Allow: /\n\nUser-agent: *\nAllow: /\n\n"
        + f"Sitemap: {SITE}/sitemap.xml\n")
    # AdMob verifies the Android app against this file on the Play listing's developer website.
    (DIST / "app-ads.txt").write_text(GOOGLE_ADS_TXT + "\n")
    # The website's own ads.txt: Google's line plus the Infolinks account's lines once Infolinks is on (see INFOLINKS_ADS_TXT).
    (DIST / "ads.txt").write_text("\n".join((GOOGLE_ADS_TXT, *INFOLINKS_ADS_TXT)) + "\n")
    print(f"built {len(listed)} pages -> {DIST}")


FACTS = f"""- Name: Tablamigo, written as one word (not "Tab Amigo"). It is not related to medicines or tablets called Amigo.
- What it is: {DEFINITION}
- Other features: a list of travelers nearby with an age filter, trips that show who will be in the same city on your dates, city chats, direct messages, chat polls, live location sharing in plan chats and direct messages (15 minutes, 1 hour or 8 hours, then it stops), AI plan ideas, and women-only plans that only women can see, host or join.
- Safety: 18+ only; other travelers see a distance rounded to 0.5 km, not your exact position, unless you choose to share live location in a chat; optional selfie verification, checked automatically against your profile photo on Tablamigo's own servers (the badge shows the selfie matched the photo, not the person's gender); AI moderation of group and city chat messages before they post (direct messages are not checked, and a message posts unchecked if the check cannot finish in time); report (six reasons) and block; reports go to the Tablamigo team. It is not a dating app.
- Launched: 29 September 2026.
- Platforms: Android, from Google Play ({PLAY}, package com.tablamigo.app, Android 7 or newer), and a web app at {SITE}/app/ that runs in any modern browser, including Safari on iPhone. There is no native iPhone app.
- Sign-in: with Google, or with your email and a 6-digit code (no password).
- Pricing: {PRICE_NOTE} The app download is free (price 0).
- Ways to get Plus without paying: invite a friend who signs up (7 days each), or host a plan that at least 2 other travelers check in at (7 days, at most twice in 30 days).
- Free account: {FREE_LIMITS}, plus 3 profile photos and 3 buddy requests a day. {SAFETY_FREE}
- Plus adds: {PLUS_ADDS}.
- Numbers: Tablamigo is new and publishes no user totals, ratings, reviews or awards. Live counts of upcoming trips and plans appear on the website only for cities where 10 or more real travelers have upcoming trips.
- Maker: Hookstep (written HookStep on Google Play and at https://hookstep.in), Ghatkopar, Mumbai, India. Contact: support@hookstep.in.
- Website: {SITE}
- Official profiles: {"; ".join(f"{name} ({url})" for name, url in [("Google Play", PLAY)] + [(PROFILE_SITES.get(urlsplit(u).netloc, urlsplit(u).netloc), u) for u in TABLAMIGO_PROFILES])}. Tablamigo has no official social media accounts."""


# Pages whose full text goes in llms-full.txt (what the app is, how it is priced and kept safe, and how it compares), and the India
# travel guides, which go in llms-india.txt (split out on 11 Oct 2026, when the India pages took llms-guides.txt past its size limit);
# every other non-legal, non-city page goes in llms-guides.txt.
LLMS_FULL = {"/", "/about", "/press", "/download", "/safety", "/travel-buddy-app", "/best-apps-to-meet-travelers", "/nomadtable-alternative",
             "/tripbff-alternative", "/couchsurfing-hangouts-alternative", "/timeleft-alternative", "/hostelworld-social-pass-alternative"}
LLMS_INDIA = {"/solo-travel-india", "/travel-buddy-app-india", "/solo-trip-with-strangers-india", "/solo-female-travel-india"}
LLMS_PARTS = ("llms-full.txt", "llms-guides.txt", "llms-india.txt")  # check.py reads this tuple


def write_llms(pages, cities):
    pages = [p for p in pages if not p.get("noindex")]  # held pages (HELD_PAGES) and thin guides are noindex, so no llms file names them
    by = {p["url"]: p for p in pages}
    named = set()
    def line(path, what):
        """One link line, or None for a page that is held out of search (it is not in `by`); lines() drops the Nones."""
        named.add(path)
        p = by.get(SITE + path)
        return f"- [{re.sub(r' [|—] Tablamigo$', '', p['title'])}]({p['url']}): {what}" if p else None
    lines = lambda *xs: "\n".join(x for x in xs if x)
    def more_guides():
        """Every other page from src/ that the hand-written sections don't name (a new guide or comparison), with its own
        title and description, so a new page is never missing here. Called from inside the template below, after every
        line() call, so `named` is complete. The legal pages, partnerships, the partner programme and the city guides are left out on purpose."""
        leave_out = named | {"/", "/privacy", "/terms", "/child-safety", "/delete-account", "/partnerships", "/partners"}
        extra = [p for p in pages if p["url"][len(SITE):] not in leave_out and not p["url"].startswith(SITE + "/solo-travel/")]
        return ("## More guides\n" + "\n".join(f"- [{re.sub(r' [|—] Tablamigo$', '', p['title'])}]({p['url']}): {p['description']}" for p in extra)
                + "\n\n") if extra else ""
    guides = "\n".join(f"- [{c['city']}]({SITE}/solo-travel/{c['slug']}): meeting solo travelers in {c['city']}, {c['country']}" for c in cities)
    (DIST / "llms.txt").write_text(f"""# {APP}

> {DEFINITION} It launched on 29 September 2026, runs on Android and in any web browser, is free to use with an optional Plus subscription, and is made by Hookstep in Mumbai, India.

## Facts
{FACTS}

## About
{line('/about', 'what Tablamigo is, who makes it and how it works')}
{line('/press', 'fact sheet for journalists and writers: launch date, platforms, pricing, safety features, logos and contact')}
{line('/download', 'get the Android app from Google Play, or use the web app on iPhone and computers')}
{line('/safety', 'how Tablamigo keeps meetups safe, and tips for meeting travelers')}

## Guides
{lines(
    line('/travel-buddy-app', 'how to meet other travelers with Tablamigo, features and FAQ'),
    line('/how-to-meet-people-while-traveling-solo', 'practical ways to meet people when you travel alone'),
    line('/solo-female-travel-app', 'women-only plans, verification and safety tools, and other apps for women'),
    line('/digital-nomad-meetups', 'where remote workers find meetups and coworking company'),
    line('/travel-buddy-app-india', "nine travel buddy and travel partner apps for India compared (Travel Buddy, GAFFL, SyncTrip, Tablamigo, Solomigo, Nomadtable, TripBFF, Hostelworld, Couchsurfing), plus others seen in India searches (Zostel's Zo Trips app, Nomax): Android and iPhone availability in India, rupee prices, and whether Nomadtable works in India"),
    line('/solo-travel-india', 'where to go solo in India and where travelers meet there, when to go, where to start a first solo trip, and how to plan it'),
    line('/solo-trip-with-strangers-india', 'a solo trip with strangers in India three ways: an operator group trip, a hostel-run trip, or going alone and meeting people there; operators compared from their own sites, a checklist for vetting one, and where weekend groups go from Delhi, Bengaluru and Mumbai'),
    line('/solo-female-travel-india', 'solo female travel in India: what the UK government advises, hostels with female-only dorms checked on their own sites, women-only coaches, helplines, and how to meet other women travelers'),
    line('/solo-travel', 'all city guides'))}

## Comparisons
{line('/best-apps-to-meet-travelers', 'Nomadtable, TripBFF, Solomigo, Couchsurfing, Hostelworld, Timeleft, Meetup, BFF and Tablamigo compared, plus newer apps (Nomax, roammate, SyncTrip), from their store listings and websites (checked dates on the page)')}
{line('/nomadtable-alternative', 'Tablamigo and Nomadtable compared on features, safety and pricing')}
{line('/tripbff-alternative', 'Tablamigo and TripBFF compared')}
{line('/couchsurfing-hangouts-alternative', 'Tablamigo and Couchsurfing Hangouts compared')}
{line('/timeleft-alternative', 'Tablamigo and Timeleft compared for dinners with strangers')}

{more_guides()}## City guides
{guides}

## Optional
- [Full text: the app, safety, pricing and the app comparisons]({SITE}/llms-full.txt)
- [Full text: the travel guides]({SITE}/llms-guides.txt) (the city guides above are linked one by one, not included in any of the full-text files)
- [Full text: the India travel guides]({SITE}/llms-india.txt)
- [Privacy]({SITE}/privacy) · [Terms]({SITE}/terms) · [Child safety]({SITE}/child-safety) · [Delete account]({SITE}/delete-account)
""")
    # Full text in three files, each small enough for an answer engine to read whole (audit F8: one 348 KB file with every
    # city guide was about 90k tokens, so agents truncated it). llms-full.txt has the product and comparison pages; every other
    # page except the legal pages, the city guides and the India guides (llms-india.txt) goes to llms-guides.txt, so a new page is never left out. Each file
    # starts with the same fact sheet; the "What is Tablamigo?" box is dropped from each page because the facts already say it.
    legal = {"/privacy", "/terms", "/child-safety", "/delete-account"}
    texts = {name: [] for name in LLMS_PARTS}
    for p in pages:
        path = p["url"][len(SITE):] or "/"
        if path in legal or path.startswith("/solo-travel/"):
            continue
        body = re.sub(r'<div class="callout whatis">.*?</div>', "", p["body"].replace("<!-- cities -->", ""), flags=re.S)
        texts["llms-full.txt" if path in LLMS_FULL else "llms-india.txt" if path in LLMS_INDIA else "llms-guides.txt"].append(
            f"\n\n---\n\nURL: {p['url']}\nTitle: {p['title']}\nSummary: {p['description']}\n\n{html_to_text(body)}\n")
    about = {"llms-full.txt": f"the product, safety and app-comparison pages. The travel guides are in {SITE}/llms-guides.txt and {SITE}/llms-india.txt",
             "llms-guides.txt": f"the travel guides. The product, safety and app-comparison pages are in {SITE}/llms-full.txt, and the India guides in {SITE}/llms-india.txt",
             "llms-india.txt": f"the India travel guides. The product, safety and app-comparison pages are in {SITE}/llms-full.txt, and the other travel guides in {SITE}/llms-guides.txt"}
    for n, (name, parts) in enumerate(texts.items(), 1):
        (DIST / name).write_text(f"# {APP}: full site text, part {n} of {len(texts)}\n\n> {DEFINITION}\n\n"
                                 f"Generated from {SITE} when the site is built. Facts first, then the text of {about[name]}; "
                                 f"the city guides are linked from {SITE}/llms.txt.\n\n## Facts\n{FACTS}\n" + "".join(parts))


if __name__ == "__main__":
    build()
