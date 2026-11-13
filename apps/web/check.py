#!/usr/bin/env python3
"""Checks dist/ after a build: every JSON-LD block parses and has the expected @type, every internal
link and asset resolves to a built file, and each page has one canonical, a title and a description.
  python3 apps/web/build.py && python3 apps/web/check.py
"""
import html as H, json, pathlib, re, sys
from html.parser import HTMLParser

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from build import DIST, SITE, THIN_GUIDES, HELD_PAGES, UTILITY_PAGES, LLMS_PARTS, SCHEMA_DATETIME_RE  # noqa: E402

EXPECTED = {  # page path -> @types that must be present
    "index.html": {"MobileApplication", "WebApplication", "Organization", "WebSite", "FAQPage"},
    "about.html": {"AboutPage", "MobileApplication", "Organization", "FAQPage", "BreadcrumbList"},
    "press.html": {"Organization", "BreadcrumbList"},
    "solo-travel-india.html": {"Article", "FAQPage", "BreadcrumbList"},
    "travel-buddy-app.html": {"FAQPage", "BreadcrumbList"},
    "solo-travel.html": {"BreadcrumbList", "ItemList"},
    "best-apps-to-meet-travelers.html": {"Article", "FAQPage", "BreadcrumbList"},
    "how-to-meet-people-while-traveling-solo.html": {"Article", "FAQPage", "BreadcrumbList"},
    "solo-female-travel-app.html": {"Article", "FAQPage", "BreadcrumbList"},
    "digital-nomad-meetups.html": {"Article", "FAQPage", "BreadcrumbList"},
    "tripbff-alternative.html": {"Article", "FAQPage", "BreadcrumbList"},
    "couchsurfing-hangouts-alternative.html": {"Article", "FAQPage", "BreadcrumbList"},
    "timeleft-alternative.html": {"Article", "FAQPage", "BreadcrumbList"},
    "travel-buddy-app-india.html": {"Article", "FAQPage", "BreadcrumbList"},
    "nomadtable-alternative.html": {"Article", "FAQPage", "BreadcrumbList"},
    "download.html": {"MobileApplication", "WebApplication", "FAQPage", "BreadcrumbList"},
    "safety.html": {"FAQPage", "BreadcrumbList"},
    "partners.html": {"FAQPage", "BreadcrumbList"},
    "solo-trip-with-strangers-india.html": {"Article", "FAQPage", "BreadcrumbList"},
    "solo-female-travel-india.html": {"Article", "FAQPage", "BreadcrumbList"},
}
THIN_REL = {f"solo-travel/{slug}.html" for slug in THIN_GUIDES}  # noindex,follow guides (build.py THIN_GUIDES, audit F4)
HELD_REL = set(HELD_PAGES) | set(UTILITY_PAGES)  # noindex,follow pages from src/ held out of search until reviewed (build.py HELD_PAGES)
STANDALONE = {"admin.html"}  # shipped without the site shell (build.py); must be noindex and stay out of the sitemap
EXTERNAL = ("/apk/", "/app/")  # served by nginx outside this build: the beta APK and the web app
TITLE_MAX, DESC_MAX = 60, 155  # what search results show before truncating
KNOWN = {"MobileApplication", "WebApplication", "Organization", "WebSite", "FAQPage", "BreadcrumbList", "ItemList",
         "Question", "Answer", "ListItem", "Offer", "Article", "AboutPage", "CollectionPage", "PostalAddress",
         "ContactPoint", "Brand", "VideoObject"}
MAX_CLICKS = 2  # every sitemap page must be reachable from the home page in this many clicks


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links, self.ld, self.canon, self._ld = [], [], [], None
        self.h1, self.noalt, self.og_image, self.robots, self.anchors = 0, [], None, "", []
        self.levels = []  # heading levels in document order, for the no-skipped-level check

    def handle_starttag(self, tag, a):
        a = dict(a)
        if tag == "a" and a.get("href"):
            self.links.append(a["href"])
            self.anchors.append(a["href"])
        if tag == "h1":
            self.h1 += 1
        if re.fullmatch(r"h[1-6]", tag):
            self.levels.append(int(tag[1]))
        if tag in ("img", "source") and a.get("srcset"):
            self.links += [c.split()[0] for c in a["srcset"].split(",") if c.strip()]
        if tag == "img" and "alt" not in a:
            self.noalt.append(a.get("src"))
        if tag == "meta" and a.get("property") == "og:image":
            self.og_image = a.get("content")
        if tag == "meta" and a.get("name") == "robots":
            self.robots = a.get("content", "")
        if tag in ("link", "img", "script") and (a.get("href") or a.get("src")):
            self.links.append(a.get("href") or a.get("src"))
        if tag == "link" and a.get("rel") == "canonical":
            self.canon.append(a["href"])
        if tag == "script" and a.get("type") == "application/ld+json":
            self._ld = ""

    def handle_data(self, d):
        if self._ld is not None:
            self._ld += d

    def handle_endtag(self, tag):
        if tag == "script" and self._ld is not None:
            self.ld.append(self._ld)
            self._ld = None


def types(node, out):
    if isinstance(node, dict):
        if "@type" in node:
            out.add(node["@type"])
        for v in node.values():
            types(v, out)
    elif isinstance(node, list):
        for v in node:
            types(v, out)
    return out


def resolves(path):
    path = path.split("#")[0].split("?")[0]
    if path in ("", "/"):
        return (DIST / "index.html").exists()
    f = DIST / path.lstrip("/")
    return f.is_file() or f.with_name(f.name + ".html").is_file()


errors, n_ld, n_links = [], 0, 0
titles, descs = {}, {}
graph = {}  # page path -> internal pages it links to, for the click-depth check


# The schema.org properties Google reads as a DateTime. A bare date in one of
# these is rejected, not widened: that is the error Search Console reported on
# 25 Oct 2026 against the home page's VideoObject uploadDate. build.py converts
# every authored date with schema_datetime(); this walks what actually reached
# the markup, on every page, so a new node that skips the conversion fails here
# rather than in Search Console three weeks later.
DATETIME_PROPERTIES = ("datePublished", "dateModified", "dateCreated", "uploadDate",
                       "datePosted", "validFrom", "validThrough", "startDate", "endDate")


def datetime_violations(node, at="$"):
    """Every DATETIME_PROPERTIES value in a JSON-LD document that is not an ISO 8601 datetime with a zone."""
    out = []
    if isinstance(node, list):
        for i, child in enumerate(node):
            out += datetime_violations(child, f"{at}[{i}]")
        return out
    if not isinstance(node, dict):
        return out
    label = node["@type"] if isinstance(node.get("@type"), str) else at
    for prop, value in node.items():
        if prop in DATETIME_PROPERTIES:
            if not isinstance(value, str) or not re.fullmatch(SCHEMA_DATETIME_RE, value):
                out.append(f"{label}.{prop} is {value!r}, not an ISO 8601 datetime with a time zone")
        else:
            out += datetime_violations(value, f"{at}.{prop}")
    return out


def page_key(href):
    href = href.split("#")[0].split("?")[0]
    if href.startswith(SITE):
        href = href[len(SITE):]
    if not href.startswith("/") or href.startswith(EXTERNAL):
        return None
    href = href.rstrip("/") or "/"
    return "index.html" if href == "/" else href.lstrip("/") + ".html"

for f in sorted(DIST.rglob("*.html")):
    rel = f.relative_to(DIST).as_posix()
    html = f.read_text()
    if rel in STANDALONE:
        if 'content="noindex' not in html:
            errors.append(f"{rel}: standalone page must be noindex")
        continue
    p = Page()
    p.feed(html)
    if not re.search(r"<title>[^<]{10,}</title>", html):
        errors.append(f"{rel}: missing title")
    if rel != "404.html" and not re.search(r'<meta name="description" content="[^"]{50,}"', html):
        errors.append(f"{rel}: missing or short description")
    t = re.search(r"<title>([^<]*)</title>", html)
    d = re.search(r'<meta name="description" content="([^"]*)"', html)
    if t and rel != "404.html":
        t = H.unescape(t.group(1))
        if len(t) > TITLE_MAX:
            errors.append(f"{rel}: title is {len(t)} chars (max {TITLE_MAX}): {t}")
        titles.setdefault(t, []).append(rel)
    if d and rel != "404.html":
        d = H.unescape(d.group(1))
        if len(d) > DESC_MAX:
            errors.append(f"{rel}: description is {len(d)} chars (max {DESC_MAX})")
        descs.setdefault(d, []).append(rel)
    want_canon = SITE + "/" + ("" if rel == "index.html" else rel[:-5])
    if rel == "404.html":
        if p.canon or "noindex" not in p.robots:
            errors.append(f"{rel}: the 404 page must be noindex with no canonical")
    elif p.canon != [want_canon]:
        errors.append(f"{rel}: canonical {p.canon} should be [{want_canon}]")
    elif rel in THIN_REL or rel in HELD_REL:
        if [x.strip() for x in p.robots.lower().split(",")][:2] != ["noindex", "follow"]:
            errors.append(f"{rel}: a thin guide or held page (build.py THIN_GUIDES, HELD_PAGES) must be robots noindex, follow, not {p.robots!r}")
    elif "noindex" in p.robots:
        errors.append(f"{rel}: noindex on an indexable page")
    if p.h1 != 1:
        errors.append(f"{rel}: {p.h1} <h1> tags (want exactly 1)")
    # Headings never skip a level (h1 then h4 is a W3C validator error; audit TM-07). Decorative text is not a heading.
    for prev, cur in zip(p.levels, p.levels[1:]):
        if cur > prev + 1:
            errors.append(f"{rel}: heading h{cur} follows h{prev}, skipping a level")
            break
    for src in p.noalt:
        errors.append(f"{rel}: <img src={src}> has no alt attribute")
    if not p.og_image or not p.og_image.startswith(SITE) or not (DIST / p.og_image[len(SITE):].lstrip("/")).is_file():
        errors.append(f"{rel}: og:image {p.og_image} is not a built file")
    graph[rel] = {k for k in (page_key(h) for h in p.anchors) if k}
    # The font, screenshots, logo and Play badge load from their content-hashed names (build.py HASHED), which nginx caches
    # for a year; a plain name here would get only the 7-day cache (audit TM-06).
    loaded = re.findall(r'\ssrc="(/[^"]+)"', html) + re.findall(r"url\((/[^)]+)\)", html) + [
        c.split()[0] for s in re.findall(r'\ssrcset="([^"]+)"', html) for c in s.split(",") if c.strip()]
    for u in loaded:
        if re.fullmatch(r"/(fonts/[^/]+\.woff2|screens/[^/]+\.webp|logo-68\.webp|play-badge-en\.webp)", u) and not re.search(r"\.[0-9a-f]{10}\.\w+$", u):
            errors.append(f"{rel}: loads {u} by its plain name instead of the content-hashed copy")
    found = set()
    for block in p.ld:
        n_ld += 1
        try:
            data = json.loads(block)
        except ValueError as e:
            errors.append(f"{rel}: JSON-LD does not parse ({e})")
            continue
        if data.get("@context") != "https://schema.org":
            errors.append(f"{rel}: JSON-LD missing schema.org @context")
        types(data, found)
        for bad in datetime_violations(data):
            errors.append(f"{rel}: JSON-LD {bad}")
        for q in [x for x in data.get("@graph", []) if x.get("@type") == "FAQPage"]:
            if not q["mainEntity"] or any(not e["name"] or not e["acceptedAnswer"]["text"] for e in q["mainEntity"]):
                errors.append(f"{rel}: FAQPage empty or has a blank question/answer")
    unknown = found - KNOWN
    if unknown:
        errors.append(f"{rel}: unexpected @type {unknown}")
    want = EXPECTED.get(rel, {"FAQPage", "BreadcrumbList"} if rel.startswith("solo-travel/") else set())
    if want - found:
        errors.append(f"{rel}: missing @type {want - found}")
    for href in p.links:
        if href.startswith(SITE):
            href = href[len(SITE):] or "/"
        if href.startswith(("http:", "https:", "mailto:", "//", "data:") + EXTERNAL) or href.startswith("#"):
            continue
        n_links += 1
        if not resolves(href):
            errors.append(f"{rel}: broken internal link {href}")

errors += [f"duplicate title on {', '.join(v)}" for v in titles.values() if len(v) > 1]
errors += [f"duplicate description on {', '.join(v)}" for v in descs.values() if len(v) > 1]

for loc in re.findall(r"<loc>(.*?)</loc>", (DIST / "sitemap.xml").read_text()):
    if loc[len(SITE):].lstrip("/") + ".html" in STANDALONE:
        errors.append(f"sitemap: {loc} is a standalone page and must not be listed")
    if not loc.startswith(SITE) or not resolves(loc[len(SITE):] or "/"):
        errors.append(f"sitemap: {loc} has no built page")
# Thin city guides (audit F4, 11 Oct 2026): THIN_GUIDES in build.py is the one list. A listed guide is noindex,follow and stays out of the
# sitemap and llms.txt; every other guide is indexable and listed. A guide is thin when cities.json gives it no sourced hostels or meet
# spots (python3 infra/seo/guide_words.py prints the measured table), so a listed guide that has gained them must come off the list, and
# a new guide without them must go on it.
import json as _json  # noqa: E402
_cities = _json.loads((pathlib.Path(__file__).parent / "cities.json").read_text())
_slugs = {c["slug"] for c in _cities}
_sitemap = re.findall(r"<loc>(.*?)</loc>", (DIST / "sitemap.xml").read_text())
_llms = (DIST / "llms.txt").read_text()
for slug in sorted(THIN_GUIDES - _slugs):
    errors.append(f"build.py THIN_GUIDES: {slug!r} is not a city in cities.json")
for c in _cities:
    sourced = bool(c.get("hostels") or c.get("meet_spots"))
    url = f"{SITE}/solo-travel/{c['slug']}"
    if c["slug"] in THIN_GUIDES:
        if sourced:
            errors.append(f"solo-travel/{c['slug']}: has sourced places now; take {c['slug']!r} off THIN_GUIDES in build.py so it is indexed again")
        if url in _sitemap or f"({url})" in _llms:
            errors.append(f"solo-travel/{c['slug']}: is noindex but is in sitemap.xml or llms.txt")
    else:
        if not sourced:
            errors.append(f"solo-travel/{c['slug']}: no sourced hostels or meet spots, so it is a thin guide; add {c['slug']!r} to THIN_GUIDES in build.py or enrich it in cities.json")
        if url not in _sitemap:
            errors.append(f"solo-travel/{c['slug']}: indexable but missing from sitemap.xml")
# Held pages (build.py HELD_PAGES, owner decision of 11 Oct 2026): built and linked, but noindex until reviewed, so no sitemap or llms
# file may name them. A name in HELD_PAGES that is no longer a page in src/ is a stale entry.
_src = {f.name for f in (pathlib.Path(__file__).parent / "src").glob("*.html")}
for rel in sorted(HELD_REL):
    url = SITE + "/" + rel[:-5]
    if rel not in _src:
        errors.append(f"build.py HELD_PAGES: {rel!r} is not a page in src/")
    if url in _sitemap:
        errors.append(f"{rel}: is held (noindex) but is in sitemap.xml")
    for _llm in ("llms.txt", *LLMS_PARTS):
        _t = (DIST / _llm).read_text() if (DIST / _llm).is_file() else ""
        if f"({url})" in _t or f"URL: {url}\n" in _t:
            errors.append(f"{rel}: is held (noindex) but {_llm} names it")
for line in re.findall(r"\]\((https?://[^)]+)\)", (DIST / "llms.txt").read_text()):
    if not line[len(SITE):].startswith(EXTERNAL) and not resolves(line[len(SITE):] or "/"):
        errors.append(f"llms.txt: {line} has no built page")

# Click depth: breadth-first from the home page over internal <a> links.
depth, frontier = {"index.html": 0}, ["index.html"]
while frontier:
    nxt = []
    for page in frontier:
        for k in graph.get(page, ()):
            if k not in depth and (DIST / k).is_file():
                depth[k] = depth[page] + 1
                nxt.append(k)
    frontier = nxt
for loc in re.findall(r"<loc>(.*?)</loc>", (DIST / "sitemap.xml").read_text()):
    k = page_key(loc)
    if depth.get(k, 99) > MAX_CLICKS:
        errors.append(f"{k}: {depth.get(k, 'not reachable')} clicks from the home page (max {MAX_CLICKS})")
if not (DIST / "llms-full.txt").is_file():
    errors.append("llms-full.txt missing")
ico = DIST / "favicon.ico"
if not ico.is_file() or ico.read_bytes()[:4] != b"\x00\x00\x01\x00":
    errors.append("favicon.ico missing or not an ICO file (browsers and crawlers ask for it by that name)")
robots = (DIST / "robots.txt").read_text()
for bot in ("GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"):
    if bot not in robots or "Disallow: /\n" in robots:
        errors.append(f"robots.txt: {bot} not explicitly allowed")

# Claims the site must not make (audits of 3 and 4 Oct 2026): invented usage numbers, a Play listing that is "in review"
# when it is live, "verified" women, SOS alerts nobody receives, a tracking link that 404s, ads and prices for a product
# that does not exist, and privacy statements the code does not back (PRIVACY_CLAIMS_EVIDENCE.md lists the evidence).
BANNED = ["1,840", "hubs active", "Most Popular", "Happening right now", "N going", "Global Travel Hubs",
          "Hyper-Local Footfall", "in review", "once the listing is live", "once live", "not public yet",
          "verified female", "verified women", "verified woman", "women-only verified", "emergency contact notification",
          "Emergency Contact Alerted", "Alert Dispatched", "notifies your emergency contact", "alerts your emergency contact",
          "SOS broadcast", "Live meetup tracking", "/safe/", "Sponsored Partner",
          "Verified Partner Venue", "Real-Time Analytics", "conversion analytics", "Verified traveler safety badge",
          "2 km away", "Self-Service Ads", "Partnerships & Ads", "Local Ads", "Sponsorship Options", "Sponsored listing",
          "Sponsored meetup", "Promoted Map Pin", "Target Monthly Budget", "\u20b91,499", "\u20b94,999",
          "Cancel anytime in 1 tap", "No outside service sees",
          # absolute promises the code does not keep: live location is shared in chats, and the app is free to use with an optional paid Plus, not free forever
          "never shows your exact location", "never shown to anyone", "free, forever", "Free forever",
          "last point you shared", "last position you shared", "stays in that chat"]
# Feature claims for marketing pages only: features that are not in the Android app on Play must not be sold. The legal
# pages (privacy, terms, delete-account, child-safety) have to describe every practice of the service, so they are exempt.
LEGAL = {"privacy.html", "terms.html", "delete-account.html", "child-safety.html"}
BANNED_MARKETING = ["Geofenced", "Superhost", "Contact Shield", "Profile Boost", "incognito", "Dedicated women-only city chats",
                    "Hindi", "dark mode"]
# Marketing pages must not describe SOS or an emergency-contact feature at all. What SOS really does (it logs an alert, emails
# the user a copy and hands them ready-made WhatsApp/SMS messages to send themselves) is stated only in the privacy policy.
BANNED_MARKETING_RE = [r"\bSOS\b", r"(?i)emergency[- ]contact"]
# Legal pages: wording from earlier drafts that the code contradicts.
BANNED_LEGAL = ["never card or UPI details", "no person looks at it", "We never see your full card", "Moments: until you delete them",
                "still works with a city you choose", "We send only the city name", "ID-verification", "voice notes",
                "event tickets", "app version", "not tied to your account", "Cloudflare's image cache for up to 4 hours",
                # retention and backups as the code and the real backup script do them (see PRIVACY_CLAIMS_EVIDENCE.md)
                "We have not set automatic deletion periods for most data", "deleted after 7 days", "we back up our database regularly",
                "keeps its last position", "until a newer code replaces it"]
texts = {f.relative_to(DIST).as_posix(): f.read_text() for f in DIST.rglob("*") if f.suffix in (".html", ".txt")}
for rel, text in texts.items():
    if rel in STANDALONE:
        continue
    for phrase in BANNED + ([] if rel in LEGAL else BANNED_MARKETING):  # case-sensitive: press.html rightly asks writers not to say "most popular"
        if phrase in text:
            errors.append(f"{rel}: banned claim {phrase!r}")
    if rel not in LEGAL and rel.endswith((".html", ".txt")):
        for rx in BANNED_MARKETING_RE:
            m = re.search(rx, text)
            if m:
                errors.append(f"{rel}: marketing page mentions {m.group(0)!r} (SOS is described in the privacy policy only)")
    if rel in LEGAL:
        for phrase in BANNED_LEGAL:
            if phrase in text:
                errors.append(f"{rel}: statement the code contradicts {phrase!r}")

# The operator is "Hookstep" on every page and in llms.txt (audit F2): never the registered business name, which only a
# Razorpay-required policy page may carry, and Tablamigo has none. Schema adds "HookStep", the casing Google Play shows.
for rel, text in texts.items():
    if re.search(r"(?i)\bJR\.?\s*Consulting\b", text):
        errors.append(f"{rel}: names the registered business; the operator is Hookstep")
if '"name": "Hookstep", "alternateName": "HookStep"' not in texts.get("index.html", ""):
    errors.append("index.html: the Hookstep Organization must carry alternateName HookStep (Google Play and hookstep.in casing)")

# Entity signals (audit F1, 11 Oct 2026): Tablamigo's Organization node is sameAs the real Play listing, Hookstep's is sameAs its own
# site and Play developer page, and every page's footer says in plain words, with a link, that Tablamigo is made by Hookstep.
from build import ORG, TABLAMIGO_ORG, TABLAMIGO_PROFILES, PLAY, DEFINITION  # noqa: E402
if TABLAMIGO_ORG.get("sameAs") != [PLAY, *TABLAMIGO_PROFILES]:
    errors.append(f"build.py: the Tablamigo Organization must be sameAs the Play listing {PLAY} plus TABLAMIGO_PROFILES, nothing else")
for u in TABLAMIGO_PROFILES:
    if not u.startswith("https://") or "hookstep" in u or "play.google.com" in u:
        errors.append(f"build.py: TABLAMIGO_PROFILES holds Tablamigo's own social profiles only (https), not {u!r}")

# Brand entity (22 Oct 2026): Google India corrects "tablamigo" to "tab amigo" and labels the site "HookStep". The brand pages lead
# their <title> and <h1> with the name, the home page and About open with the same definition, and the home page's WebSite node
# (what Google reads for the site name) is called Tablamigo. Guides and comparisons keep keyword-first titles ending "| Tablamigo".
if not DEFINITION.startswith("Tablamigo is a solo-travel app"):
    errors.append("build.py: DEFINITION must open with 'Tablamigo is a solo-travel app'")
for rel in ("index.html", "about.html", "download.html", "press.html", "safety.html"):
    _t = re.search(r"<title>([^<]*)</title>", texts.get(rel, ""))
    _h = re.search(r"<h1[^>]*>(.*?)</h1>", texts.get(rel, ""), re.S)
    if not _t or not H.unescape(_t.group(1)).startswith("Tablamigo"):
        errors.append(f"{rel}: the title must start with 'Tablamigo'")
    if not _h or not re.sub(r"<[^>]+>", "", _h.group(1)).strip().startswith("Tablamigo"):
        errors.append(f"{rel}: the <h1> must start with 'Tablamigo'")
for rel in ("index.html", "about.html"):
    _lead = re.search(r'<p class="lead">(.*?)</p>', texts.get(rel, ""), re.S)
    if not _lead or not re.sub(r"<[^>]+>", "", _lead.group(1)).strip().startswith("Tablamigo is a solo-travel app"):
        errors.append(f"{rel}: the lead paragraph must open with 'Tablamigo is a solo-travel app'")
_site = next((n for b in re.findall(r'<script type="application/ld\+json">(.*?)</script>', texts.get("index.html", ""), re.S)
              for n in json.loads(b).get("@graph", []) if n.get("@type") == "WebSite"), {})
if _site.get("name") != "Tablamigo":
    errors.append("index.html: the WebSite node must be named Tablamigo (Google's site name)")
_llms = (DIST / "llms.txt").read_text()
if DEFINITION not in _llms or "written as one word" not in _llms:
    errors.append("llms.txt: must carry the definition and the one-word spelling of the name")
if "https://hookstep.in" not in ORG.get("sameAs", []) or not any(u.startswith("https://play.google.com/store/apps/developer?id=") for u in ORG.get("sameAs", [])):
    errors.append("build.py: the Hookstep Organization's sameAs must hold https://hookstep.in and its Google Play developer page")
for rel, text in texts.items():
    if rel.endswith(".html") and rel not in STANDALONE and 'Tablamigo is made by <a href="https://hookstep.in">Hookstep</a>' not in text:
        errors.append(f"{rel}: the footer must say Tablamigo is made by Hookstep, linking https://hookstep.in")

# The partnerships page is early-stage copy: no prices, no ad product, no audience numbers.
part = texts.get("partnerships.html", "")
if re.search(r"[\u20b9$]\s?\d", part):
    errors.append("partnerships.html: shows a price, but nothing on that page is for sale yet")
from build import ANDROID_ADS_LIVE  # noqa: E402
if not ANDROID_ADS_LIVE and "no ads or sponsored listings" not in part:
    errors.append("partnerships.html: must say there are no ads or sponsored listings in Tablamigo today")
if ANDROID_ADS_LIVE and "no sponsored listings" not in part:
    errors.append("partnerships.html: must say there are no sponsored listings in Tablamigo today")
if re.search(r"\d[\d,]*\+?\s*(travelers|users|downloads|hubs|cities|members)\b", re.sub(r"<[^>]+>", " ", part)):
    errors.append("partnerships.html: states an audience or traction number")

# Google Play badge and links: every Play link points at the real listing with an install referrer
# (utm_source=website, utm_medium=<placement>), and every badge is Google's own artwork.
from urllib.parse import urlsplit, parse_qs  # noqa: E402
from build import PLAY, PLAY_BADGE_IMG, PLAY_TM  # noqa: E402
placements = {}
for rel, text in texts.items():
    if not rel.endswith(".html") or rel in STANDALONE:
        continue
    for href in re.findall(r'href="(https://play\.google\.com/[^"]*)"', text):
        q = parse_qs(urlsplit(H.unescape(href)).query)
        ref = parse_qs(q.get("referrer", [""])[0])
        if q.get("id") != ["com.tablamigo.app"] or not H.unescape(href).startswith(PLAY + "&"):
            errors.append(f"{rel}: Play link to the wrong listing: {href}")
        elif ref.get("utm_source") != ["website"] or not ref.get("utm_medium") or ref.get("utm_campaign") != ["play_badge"]:
            errors.append(f"{rel}: Play link without a referrer: {href}")
        else:
            placements.setdefault(rel, []).append(ref["utm_medium"][0])
    badge_src = re.escape(PLAY_BADGE_IMG).replace(r"\.webp", r"(\.[0-9a-f]{10})?\.webp")  # the plain or content-hashed copy
    for img in re.findall(r'<a class="play-badge"[^>]*>(<img [^>]*>)</a>', text):
        if not re.search(f'src="{badge_src}"', img) or 'alt="Get it on Google Play"' not in img:
            errors.append(f"{rel}: Play badge is not Google's artwork with its alt text: {img}")
    if "footer" not in placements.get(rel, []) or PLAY_TM not in text:
        errors.append(f"{rel}: footer is missing the Play badge or Google's trademark line")
for rel, want in {"index.html": {"hero", "home_cta"}, "download.html": {"download"}}.items():
    if want - set(placements.get(rel, [])):
        errors.append(f"{rel}: missing Play badge placements {want - set(placements.get(rel, []))}")
home = texts["index.html"]
app = next((n for b in re.findall(r'<script type="application/ld\+json">(.*?)</script>', home, re.S)
            for n in json.loads(b).get("@graph", []) if n.get("@type") == "MobileApplication"), {})
if app.get("installUrl") != PLAY:
    errors.append(f"index.html: MobileApplication installUrl is {app.get('installUrl')!r}, want {PLAY}")

# Pricing (paid mode, 10 Oct 2026): Tablamigo is free to use with limits, and optional Plus is on sale again: on the website and web app
# through Razorpay, in the Android app through Google Play. build.py's PRICE_SHORT / PRICE_LINE / PRICE_NOTE are the wording and the only
# place Tablamigo's rupee prices are written, so a page that hard-codes a price fails. The 4 Oct "everything is free" wording and any
# launch-offer wording must not come back, nothing may promise "free forever", and no Google Play price may appear (none is recorded
# where we can verify it). The legal pages (terms, privacy, delete-account) are held to the same stale-wording list.
from build import PRICE_SHORT, PRICE_LINE, PRICE_NOTE, PRICE_MORE, PLUS_MONTH, PLUS_YEAR, TRIP_PASS, PLUS_MONTH_INR, PLUS_YEAR_INR  # noqa: E402
STALE = [  # the 4 Oct "free for everyone, nothing for sale" wording
         "nothing to buy", "Nothing to buy", "No passes to buy", "Nothing to cancel", "nothing in it is for sale", "sells nothing",
         "no paid features", "No paid features", "free right now", "Free right now", "may come back", "every feature, no ads",
         "Every feature included", "every feature included", "Plus currently means everyone", "Plus while Tablamigo is free",
         "in-app products from an earlier setup", "nothing is sold in the app",
         # the launch offer (Plus free for everyone until 31 December 2026) is over and its wording must not return
         "aunch offer", "31 Dec", "31 December 2026", "December 31, 2026", "2026-12-31", "free for everyone", "Free for everyone",
         "After that, Plus",
         # Tablamigo's Google Play prices (US) from before 4 Oct: not recorded anywhere we can verify, so never quoted (the yearly one,
         # $79.99, is also TripBFF's price, so it is not listed here)
         "$7.99 a week", "$17.99 a month", "$7.99/week", "$17.99/month"]
STALE_RE = [r"Tablamigo[^.<]{0,60}\bevery feature\b", r"(?i)\b(always free|free forever|free for life|free permanently|free, forever)\b",
            r"(?i)\bplus\b[^.<]{0,80}\bfree\b[^.<]{0,60}\b(forever|for life|permanently|always)\b"]
for rel, text in texts.items():
    if rel in STANDALONE:
        continue
    for phrase in STALE:
        if phrase in text:
            errors.append(f"{rel}: stale free-mode, launch-offer or Google Play price wording {phrase!r}")
    for rx in STALE_RE:
        m = re.search(rx, text)
        if m:
            errors.append(f"{rel}: stale or forever-free wording {m.group(0)!r}")
    if re.search(r"\{\{\w+\}\}", text):
        errors.append(f"{rel}: has an unreplaced {{{{token}}}}")
for f in sorted((pathlib.Path(__file__).parent / "src").glob("*.html")):
    raw = f.read_text()
    for price, token in ((PLUS_MONTH, "plus_month"), (PLUS_YEAR, "plus_year"), (TRIP_PASS, "trip_pass")):
        if price in raw:
            errors.append(f"src/{f.name}: hard-codes Tablamigo's price {price}; write {{{{{token}}}}} so build.py's constant is the only place")
    if re.search(r"\{\{(launch_\w+|free_line|free_note|play_iap_note)\}\}", raw):
        errors.append(f"src/{f.name}: uses a removed token (launch offer, free mode or play_iap_note); use {{{{price_line}}}} or {{{{price_note}}}}")
# The home page: the Free vs Plus section, the billing note and the cost FAQ carry build.py's wording, and the Plus card shows the prices.
if f'<p class="sub">{PRICE_LINE}</p>' not in home:
    errors.append("index.html: the Free vs Plus section is missing the pricing line")
if f'<p class="billing-note">{PRICE_MORE}</p>' not in home:
    errors.append("index.html: the billing note (Razorpay on the web, Google Play in the app) is missing from the Plus section")
if f"<summary>How much does Tablamigo cost?</summary><p>{PRICE_NOTE}</p>" not in home:
    errors.append("index.html: the cost FAQ is missing the pricing note")
if not re.search(r"<summary>How do I cancel Plus\?</summary><p>[^<]*Google Play[^<]*Razorpay", home):
    errors.append("index.html: the cancel FAQ doesn't say Google Play for the app and Razorpay for the web")
for need in (PLUS_MONTH, PLUS_YEAR, TRIP_PASS, 'href="/app/paywall"', 'id="plus"'):
    if need not in home:
        errors.append(f"index.html: the Plus section is missing {need!r}")
# The menu links to the web prices, except on the pages the Android app opens.
for rel, text in texts.items():
    if rel in STANDALONE or not rel.endswith(".html"):
        continue
    has = 'href="/#plus"' in text
    if rel in ("privacy.html", "terms.html", "delete-account.html"):
        if has:
            errors.append(f"{rel}: the menu links to the web price list; the Play app opens this page")
    elif not has:
        errors.append(f"{rel}: the menu has no Plus link")
# Pages that state the price carry the shared wording (the short cell, or the full note), so none drifts.
for rel, want in {"about.html": PRICE_NOTE, "press.html": PRICE_NOTE, "download.html": PRICE_NOTE, "nomadtable-alternative.html": PRICE_NOTE,
                  "travel-buddy-app-india.html": PRICE_NOTE, "best-apps-to-meet-travelers.html": PRICE_SHORT,
                  "solo-female-travel-app.html": PRICE_SHORT, "hostelworld-social-pass-alternative.html": PRICE_SHORT}.items():
    if want not in texts.get(rel, ""):
        errors.append(f"{rel}: missing the shared pricing wording {want[:50]!r}...")
# llms.txt and the full-text files (build.py LLMS_PARTS: llms-full.txt, llms-guides.txt, llms-india.txt): the fact sheet (before the first page in the full-text files) says what is free and
# what Plus adds. The full-text files stay small enough to be read whole (audit F8: the old single file was 348 KB, ~90k tokens).
LLMS_MAX = 120_000  # bytes, about 30k tokens
for rel in LLMS_PARTS:
    size = len(texts.get(rel, "").encode())
    if not size or size > LLMS_MAX:
        errors.append(f"{rel}: {size} bytes; it must exist and stay under {LLMS_MAX} so answer engines can read it whole")
    if "/solo-travel/" in "".join(re.findall(r"\nURL: (\S+)", texts.get(rel, ""))):
        errors.append(f"{rel}: holds a city guide; those are linked from llms.txt one by one")
    if f"{SITE}/{rel}" not in texts.get("llms.txt", ""):
        errors.append(f"llms.txt: doesn't link {rel}")
for rel in ("llms.txt", *LLMS_PARTS):
    facts = texts.get(rel, "").split("\n\n---\n\n")[0]
    if PRICE_NOTE not in facts:
        errors.append(f"{rel}: the fact sheet is missing the pricing note")
    for label in ("- Free account: ", "- Plus adds: "):
        if label not in facts:
            errors.append(f"{rel}: the fact sheet is missing the line {label.strip()!r}")
# Schema (audit F6, 11 Oct 2026): every offer is in rupees. The Android app is a free download (one Offer at 0; no Google Play price is
# recorded where we can verify it); the web app offers Free, the two Plus subscriptions and the Trip Pass at build.py's prices.
from build import TRIP_PASS_INR  # noqa: E402
for rel in ("index.html", "about.html", "download.html"):
    nodes = [n for b in re.findall(r'<script type="application/ld\+json">(.*?)</script>', texts[rel], re.S)
             for n in json.loads(b).get("@graph", []) if n.get("@type") in ("MobileApplication", "WebApplication")]
    if len(nodes) != 2:
        errors.append(f"{rel}: wants the MobileApplication and WebApplication nodes, found {len(nodes)}")
    for node in nodes:
        prices = sorted((o.get("price"), o.get("priceCurrency")) for o in node.get("offers", []))
        want = ([("0", "INR")] if node["@type"] == "MobileApplication"
                else sorted([("0", "INR"), (str(PLUS_MONTH_INR), "INR"), (str(PLUS_YEAR_INR), "INR"), (str(TRIP_PASS_INR), "INR")]))
        if prices != want:
            errors.append(f"{rel}: {node['@type']} offers must be {want}, got {prices}")

for rel, words in {"privacy.html": ["Razorpay", "Google Play", "Trusted contacts", "SOS", "live location", "usage events", "not signed in",
                                    "Comments and likes on moments", "City tips", "OpenAI", "Nominatim", "Photon", "OpenFreeMap",
                                    "Firebase Cloud Messaging", "push subscription", "Cloudflare", "Backups", "rounded to a grid of about 1 km",
                                    "UPI ID", "no automatic deletion", "Server logs", "Verification selfie", "Photos you upload",
                                    "every 6 hours", "10 most recent backups", "180 days", "30 days after they expire", "7 days after they end",
                                    "Profile Boost", "Here now", "Invite codes", "installation ID", "text of a chat search",
                                    "no coordinates are returned", "phone numbers, email addresses and social handles",
                                    "accounts.google.com", "Continue as", "never on a timer", "Cloudflare Web Analytics", "Android 9 and older", "wake lock"],
                   "terms.html": ["Razorpay", "Google Play", "Trip Pass", "web app"],
                   "delete-account.html": ["Razorpay", "trusted", "moments", "usage events", "support@hookstep.in", "Hookstep",
                                           "Delete account", "What is deleted", "What is kept", "What is anonymised", "Backups", "UPI ID",
                                           "Server logs", "every 6 hours", "10 most recent backups", "180 days"]}.items():
    if rel not in texts:
        errors.append(f"{rel}: page missing")
        continue
    for w in words:
        if w.lower() not in texts[rel].lower():
            errors.append(f"{rel}: doesn't mention {w!r}")
# Ads (build.py ANDROID_ADS_LIVE). Before a Play release shows ads, no page may mention AdMob or the advertising ID. Once one does,
# the privacy policy must name Google AdMob, the advertising ID and the in-app choice, and no page may still say there are no ads.
NO_ADS_WORDS = ["with no ads", "no ads or sponsored", "No ads or sponsored", "no advertising trackers", "use no advertising",
                "analytics or advertising SDKs"]
if ANDROID_ADS_LIVE:
    for w in ["Google AdMob", "advertising ID", "Ad privacy choices", "policies.google.com/technologies/ads"]:
        if w not in texts.get("privacy.html", ""):
            errors.append(f"privacy.html: doesn't mention {w!r}, but the Android app on Play shows ads (build.py ANDROID_ADS_LIVE)")
    for rel, text in texts.items():
        errors += [f"{rel}: says {w!r}, but the Android app on Play shows ads (build.py ANDROID_ADS_LIVE)" for w in NO_ADS_WORDS if w in text]
else:
    for rel, text in texts.items():
        errors += [f"{rel}: mentions {w!r}, but no Play release shows ads yet (build.py ANDROID_ADS_LIVE)"
                   for w in ("AdMob", "advertising ID", "Ad privacy choices") if w in text]
# Government ID is not offered, and the policy has to say so in as many words.
if not re.search(r"don't offer government ID verification", texts.get("privacy.html", "")):
    errors.append("privacy.html: must say that government ID verification is not offered")
# Nothing the pages say about money may promise more than the code does: no card or UPI detail claims beyond Razorpay's record.
if re.search(r"never (see|receive|store)[^.]{0,40}UPI", texts.get("privacy.html", "") + texts.get("delete-account.html", "")):
    errors.append("privacy/delete-account: claims no UPI detail is kept, but a Razorpay payment record can include the UPI ID")

# Google One Tap (11 Oct 2026): the loader is on every marketing page and on none of the legal pages or the 404, it never signs
# anyone in without a tap, and the privacy policy (words above) says Google's script loads and what Google sees.
from build import ONE_TAP_TAG, ONE_TAP_JS, NO_ONE_TAP  # noqa: E402
if "auto_select:false" not in ONE_TAP_JS or "use_fedcm_for_prompt:true" not in ONE_TAP_JS:
    errors.append("build.py: the One Tap loader must keep auto_select:false and use_fedcm_for_prompt:true")
# Google's script loads on the visitor's first interaction only (audit TM-04/F7, 11 Oct 2026): a timer fallback fires inside
# Lighthouse/PageSpeed runs, adds ~100 KB and logs Google's FedCM console error. The privacy policy says "never on a timer".
if re.search(r"setTimeout|setInterval|requestIdleCallback", ONE_TAP_JS):
    errors.append("build.py: the One Tap loader must load Google's script on interaction only, with no timer or idle callback")
if "E=['pointerdown','keydown','scroll','touchstart']" not in ONE_TAP_JS:
    errors.append("build.py: the One Tap loader's interaction triggers changed; update the privacy policy wording with them")
for rel, text in texts.items():
    if rel in STANDALONE or not rel.endswith(".html"):
        continue
    if rel in NO_ONE_TAP:
        if "accounts.google.com/gsi/client" in text:
            errors.append(f"{rel}: loads Google's sign-in script, but legal pages and the 404 must not")
    elif text.count(ONE_TAP_TAG) != 1:
        errors.append(f"{rel}: missing the Google One Tap loader (or has it twice)")
if "accounts.google.com" in texts.get("admin.html", ""):
    errors.append("admin.html: must not load Google's sign-in script")

# Cloudflare Web Analytics (audit TM-02, 11 Oct 2026): the beacon is loaded by BEACON_JS after the window's load event, never by a static
# <script src> (which would be in the critical path, as Cloudflare's own automatic injection was), once per page, and only when no beacon
# script is there already (no double counting while automatic injection is still on). Every page carries the loader except the standalone
# admin panel, and the privacy policy discloses it (its words are checked above).
from build import BEACON_TAG, BEACON_JS, CF_BEACON_TOKEN  # noqa: E402
if not re.fullmatch(r"[0-9a-f]{32}", CF_BEACON_TOKEN):
    errors.append("build.py: CF_BEACON_TOKEN is not a 32-character site token")
for need in ("addEventListener('load'", "requestIdleCallback", "cloudflareinsights.com/beacon\"]')"):
    if need not in BEACON_JS:
        errors.append(f"build.py: the beacon loader must keep {need!r} (load event, idle callback, already-there guard)")
for rel, text in texts.items():
    if rel in STANDALONE or not rel.endswith(".html"):
        continue
    if text.count(BEACON_TAG) != 1:
        errors.append(f"{rel}: missing the Cloudflare Web Analytics loader (or has it twice)")
    if re.search(r'<script[^>]+src="[^"]*cloudflareinsights\.com', text):
        errors.append(f"{rel}: has a static <script src> for Cloudflare's beacon; it must load through BEACON_JS after the load event")
mobile_index = (pathlib.Path(__file__).parent.parent / "mobile" / "public" / "index.html").read_text()
if CF_BEACON_TOKEN not in mobile_index or "addEventListener('load'" not in mobile_index or re.search(r'<script[^>]+src="[^"]*cloudflareinsights', mobile_index):
    errors.append("apps/mobile/public/index.html: the web app must load Cloudflare Web Analytics with the site token, after load, and never with a static tag")

# Ads and affiliate links (20 Oct 2026). Infolinks runs only on the city guides and the how-to guides (build.py infolinks_page), through
# INFOLINKS_JS after the load event and never from a static <script src>; Travelpayouts affiliate links are only on city guides, at most two
# a page, each rel="sponsored nofollow noopener", target="_blank" and labelled; /ads.txt carries Google's line plus the Infolinks lines;
# /app-ads.txt stays Google's line alone; and the privacy policy says exactly what is switched on, no more and no less.
from build import (INFOLINKS_PID, INFOLINKS_WSID, INFOLINKS_ADS_TXT, INFOLINKS_TAG, INFOLINKS_JS, INFOLINKS_GUIDES, infolinks_page,  # noqa: E402
                   GOOGLE_ADS_TXT, TRAVELPAYOUTS_MARKER, TP_JOINED, TP_PROGRAMMES, CITY_AFFILIATE, INFOLINKS_ON, AFFILIATE_ON, ANY_ADS,
                   load_cities)
if INFOLINKS_PID and not re.fullmatch(r"\d+", INFOLINKS_PID):
    errors.append(f"build.py: INFOLINKS_PID must be the numeric publisher ID, got {INFOLINKS_PID!r}")
if not re.fullmatch(r"\d+", INFOLINKS_WSID or ""):
    errors.append(f"build.py: INFOLINKS_WSID must be the numeric website ID (0 is Infolinks' default), got {INFOLINKS_WSID!r}")
for need in ("location.hostname!=='tablamigo.hookstep.in'", "addEventListener('load'", "requestIdleCallback", "s.async=true"):
    if need not in INFOLINKS_JS:
        errors.append(f"build.py: the Infolinks loader must keep {need!r} (production host only, after load and an idle moment, async)")
_NEVER_ADS = LEGAL | STANDALONE | {"index.html", "download.html", "404.html", "solo-travel.html", "about.html", "press.html", "safety.html", "partnerships.html", "partners.html"}
for rel in sorted(INFOLINKS_GUIDES):
    if rel in _NEVER_ADS or re.search(r"alternative|best-apps|-app(-|\.)", rel):
        errors.append(f"build.py: INFOLINKS_GUIDES lists {rel}, but ads never go on the home, download, app, comparison, legal or 404 pages")
    elif rel not in texts:
        errors.append(f"build.py: INFOLINKS_GUIDES lists {rel}, which is not a built page")
for rel, text in texts.items():
    if not rel.endswith(".html"):
        continue
    if re.search(r'<script[^>]+src="[^"]*infolinks\.com', text):
        errors.append(f"{rel}: has a static <script src> for Infolinks; it must load through INFOLINKS_JS after the load event")
    has = "infolinks.com/js/" in text or "infolinks_pid" in text
    if rel in STANDALONE or rel in _NEVER_ADS or not infolinks_page(rel):
        if has:
            errors.append(f"{rel}: carries Infolinks, but only the city guides and the how-to guides may")
    elif INFOLINKS_ON:
        if text.count(INFOLINKS_TAG) != 1:
            errors.append(f"{rel}: missing the Infolinks loader (or has it twice)")
        if "with no ads" in text:
            errors.append(f"{rel}: shows Infolinks ads but says 'with no ads' (PRICE_LINE); reword it before switching Infolinks on")
    elif has:
        errors.append(f"{rel}: carries Infolinks while INFOLINKS_PID is empty")
_ads_txt = (DIST / "ads.txt").read_text().splitlines() if (DIST / "ads.txt").is_file() else []
if GOOGLE_ADS_TXT not in _ads_txt:
    errors.append("ads.txt: missing, or without Google's publisher line")
for _line in INFOLINKS_ADS_TXT:
    if _line not in _ads_txt:
        errors.append(f"ads.txt: missing the Infolinks line {_line!r}")
if INFOLINKS_ON and not INFOLINKS_ADS_TXT:
    errors.append("build.py: Infolinks is on but INFOLINKS_ADS_TXT is empty; copy the account's ads.txt lines from the Infolinks dashboard")
if not INFOLINKS_ON and INFOLINKS_ADS_TXT:
    errors.append("build.py: INFOLINKS_ADS_TXT is set while INFOLINKS_PID is empty")
if (DIST / "app-ads.txt").read_text() != GOOGLE_ADS_TXT + "\n":
    errors.append("app-ads.txt: must hold Google's publisher line alone (AdMob verifies the Android app against it)")
if TRAVELPAYOUTS_MARKER and not re.fullmatch(r"\d+", TRAVELPAYOUTS_MARKER):
    errors.append(f"build.py: TRAVELPAYOUTS_MARKER must be the numeric partner marker, got {TRAVELPAYOUTS_MARKER!r}")
if TP_JOINED - set(TP_PROGRAMMES):
    errors.append(f"build.py: TP_JOINED has programmes build.py doesn't know: {sorted(TP_JOINED - set(TP_PROGRAMMES))}")
_slugs_all = {c["slug"] for c in load_cities()}
for _slug, _links in CITY_AFFILIATE.items():
    if _slug not in _slugs_all:
        errors.append(f"build.py: CITY_AFFILIATE names {_slug!r}, which has no city guide")
    if len(_links) > 2:
        errors.append(f"build.py: CITY_AFFILIATE gives {_slug} {len(_links)} links; two at most")
    for _p, _text, _url in _links:
        if _p not in TP_PROGRAMMES or not _url.startswith("https://") or not _text.strip():
            errors.append(f"build.py: CITY_AFFILIATE {_slug}: bad entry {(_p, _text, _url)!r}")
        if "marker=" in _url and f"marker={TRAVELPAYOUTS_MARKER}" not in _url:
            errors.append(f"build.py: CITY_AFFILIATE {_slug}: the link carries a marker other than TRAVELPAYOUTS_MARKER")
for rel, text in texts.items():
    if not rel.endswith(".html"):
        continue
    tags = re.findall(r"<a\s[^>]*>", text)
    sponsored = [t for t in tags if 'rel="sponsored' in t]
    for t in tags:
        if re.search(r'href="[^"]*(tp\.media/|tpo\.li/|[?&;]marker=)', t) and t not in sponsored:
            errors.append(f"{rel}: affiliate link without rel=\"sponsored nofollow noopener\": {t[:120]}")
    if not sponsored:
        continue
    if not AFFILIATE_ON:
        errors.append(f"{rel}: has sponsored links while Travelpayouts is off")
    if not rel.startswith("solo-travel/"):
        errors.append(f"{rel}: has affiliate links, but only city guides may")
    if len(sponsored) > 2:
        errors.append(f"{rel}: has {len(sponsored)} affiliate links; two at most")
    for t in sponsored:
        if 'rel="sponsored nofollow noopener"' not in t or 'target="_blank"' not in t:
            errors.append(f"{rel}: affiliate link must be rel=\"sponsored nofollow noopener\" target=\"_blank\": {t[:120]}")
    if "Affiliate link" not in text:
        errors.append(f"{rel}: affiliate links must be labelled as affiliate links next to them")
_priv = texts.get("privacy.html", "")
for rel in ("privacy.html", "partnerships.html"):
    if re.search(r"\{\{(ads|partner)_\w+\}\}|<!-- ads[-:]", texts.get(rel, "")):
        errors.append(f"{rel}: an ads token or marker was not replaced")
_no_trackers = ("We don't sell your data and use no advertising trackers.", "and we don't use advertising trackers.")
if INFOLINKS_ON:
    for w in ("Infolinks", "infolinks.com/privacy-policy", "cookies", "/solo-travel/"):
        if w not in _priv:
            errors.append(f"privacy.html: Infolinks is on, so the policy must mention {w!r}")
elif "Infolinks" in _priv:
    errors.append("privacy.html: mentions Infolinks while it is off")
for w in _no_trackers:
    if ANY_ADS and w in _priv:
        errors.append(f"privacy.html: says {w!r}, but ads are on (build.py ADSENSE_ON / INFOLINKS_ON / ANDROID_ADS_LIVE)")
    if not ANY_ADS and w not in _priv:
        errors.append(f"privacy.html: with ads off the policy keeps {w!r}")

# Google AdSense on the guides (build.py ADSENSE_*, 25 Oct 2026). The loader runs only on adsense_page() pages, exactly once, never from a
# static <script src>; it keeps the production-host guard, waits for the first interaction and an idle moment, and, until AdSense's
# certified consent message is published (ADSENSE_CMP), loads nothing for the EEA, the UK and Switzerland or an unknown country. The
# privacy policy carries what AdSense's required-content policy asks for (third-party vendors including Google use cookies, the Ads
# Settings opt-out, aboutads.info) and says the consent state as it is.
from build import (ADSENSE_ON, ADSENSE_CMP, ADSENSE_CLIENT, ADSENSE_JS, ADSENSE_TAG, ADSENSE_SRC, CONSENT_COUNTRIES, THIN_GUIDES,  # noqa: E402
                   adsense_page, adsense_js)
if ADSENSE_CLIENT != "ca-" + GOOGLE_ADS_TXT.split(", ")[1]:
    errors.append(f"build.py: ADSENSE_CLIENT {ADSENSE_CLIENT!r} is not the publisher in GOOGLE_ADS_TXT")
if ADSENSE_JS != adsense_js(ADSENSE_CMP) or f"var CMP={'true' if ADSENSE_CMP else 'false'}," not in ADSENSE_JS:
    errors.append("build.py: ADSENSE_JS must be adsense_js(ADSENSE_CMP)")
# Both consent states keep the same guards; the country gate is checked in the state that uses it, whichever ships.
for _state in (True, False):
    _js = adsense_js(_state)
    _needs = ["location.hostname!=='tablamigo.hookstep.in'", "s.async=true", "requestIdleCallback", "'scroll'", "'pointerdown'", "'keydown'",
              ADSENSE_SRC, "/cdn-cgi/trace", "NO.indexOf(c)<0", "c!=='XX'", "c!=='T1'", "if(CMP)return add()"]
    for need in _needs:
        if need not in _js:
            errors.append(f"build.py: the AdSense loader (CMP={_state}) must keep {need!r} (production host, first interaction then idle, async, consent gate)")
    if "addEventListener('load'" in _js or "readyState" in _js:
        errors.append("build.py: the AdSense loader must wait for the visitor's first interaction, not the load event")
for _cc in ("DE", "FR", "GB", "CH", "NO", "IS", "LI", "IE"):
    if _cc not in CONSENT_COUNTRIES:
        errors.append(f"build.py: CONSENT_COUNTRIES is missing {_cc}")
for rel in sorted(t for t in texts if t.endswith(".html") and adsense_page(t)):
    if rel in _NEVER_ADS or rel in STANDALONE or re.search(r"alternative|best-apps|-app(-|\.)", rel):
        errors.append(f"build.py: adsense_page() takes {rel}, but ads never go on the home, download, app, comparison, safety, legal or 404 pages")
for rel, text in texts.items():
    if not rel.endswith(".html"):
        continue
    if re.search(r'<script[^>]+src="[^"]*(googlesyndication|adsbygoogle)', text):
        errors.append(f"{rel}: has a static <script src> for AdSense; it must load through ADSENSE_JS after the first interaction")
    has = "adsbygoogle" in text or "pagead2.googlesyndication.com" in text  # the policy names googlesyndication.com in words
    if not (ADSENSE_ON and adsense_page(rel)):
        if has:
            errors.append(f"{rel}: carries Google's ad script, but only the how-to guides and the full city guides may")
        continue
    if text.count(ADSENSE_TAG) != 1:
        errors.append(f"{rel}: missing the AdSense loader (or has it twice)")
    if "with no ads" in text:
        errors.append(f"{rel}: shows Google ads but says 'with no ads'")
if ADSENSE_ON:
    _full = [r for r in texts if re.fullmatch(r"solo-travel/[a-z0-9-]+\.html", r) and r.split("/")[1][:-5] not in THIN_GUIDES]
    if not _full or not all(adsense_page(r) for r in _full):
        errors.append("build.py: every full city guide should carry AdSense while ADSENSE_ON")
    for w in ("Google AdSense", "Third-party vendors, including Google, use cookies", "google.com/settings/ads", "aboutads.info",
              "policies.google.com/technologies/partner-sites", "/solo-travel/", "first scroll, tap, click or key press"):
        if w not in _priv:
            errors.append(f"privacy.html: AdSense is on, so the policy must say {w!r}")
    _gate, _not = (("Google first shows its consent message", "the country can't be told") if ADSENSE_CMP else
                   ("the EEA, the UK or Switzerland, or the country can't be told", "Google first shows its consent message"))
    if _gate not in _priv:
        errors.append(f"privacy.html: must describe the AdSense consent state as it is ({_gate!r})")
    if _not in _priv:
        errors.append(f"privacy.html: describes the other AdSense consent state ({_not!r}); build.py ADSENSE_CMP is {ADSENSE_CMP}")
    if ADSENSE_CMP and _priv.count("Privacy and cookie settings") < 2:
        errors.append("privacy.html: with Google's consent message on, the vendor item and the choices list must name the 'Privacy and cookie settings' link")
elif "AdSense" in _priv:
    errors.append("privacy.html: mentions AdSense while it is off")
if AFFILIATE_ON:
    for w in ("Travelpayouts", "affiliate", "commission"):
        if w not in _priv:
            errors.append(f"privacy.html: Travelpayouts links are on, so the policy must mention {w!r}")
elif "Travelpayouts" in _priv:
    errors.append("privacy.html: mentions Travelpayouts while no affiliate link is on")

# Performance (audit TM-03, 11 Oct 2026): no font preload. The web font is font-display: optional, and Chrome holds the first
# paint for a preloaded optional font, which put the font's separate CORS connection in front of FCP and LCP on mobile.
for rel, text in texts.items():
    if rel.endswith(".html") and rel not in STANDALONE and re.search(r'<link[^>]*rel="preload"[^>]*as="font"', text):
        errors.append(f"{rel}: preloads a font; the web font is optional and must not hold the first paint")

# Google Play listing text (audit ASO-T1/T3/T4/T5, 11 Oct 2026): store/play-listing.md (en-US), .en-IN.md and .hi-IN.md are what
# infra/play/listing.mjs pushes. Play's limits are 30 / 80 / 4000 characters; the paid-mode and operator rules of the website apply to
# the store text too (never "completely free" or "nothing to buy", never the registered business name, and the maker line is
# "Hookstep, India", with no city or street); the promo video is the owner's YouTube watch URL.
_store = pathlib.Path(__file__).resolve().parents[2] / "store"
_LISTINGS = {"en-US": "play-listing.md", "en-IN": "play-listing.en-IN.md", "hi-IN": "play-listing.hi-IN.md"}
_LIMITS = {"App name (30 max)": 30, "Short description (80 max)": 80, "Full description (4000 max)": 4000, "What's new (500 max)": 500}
for _loc, _file in _LISTINGS.items():
    _md = (_store / _file).read_text()
    _all = ""
    for _h, _max in _LIMITS.items():
        _part = _md.split(f"## {_h}\n")[1].split("\n## ")[0].strip() if f"## {_h}\n" in _md else None
        if _part is None:
            if _h != "What's new (500 max)" or _loc == "en-US":
                errors.append(f"store/{_file}: no '## {_h}' section")
            continue
        _all += _part + "\n"
        if len(_part) > _max:
            errors.append(f"store/{_file}: '{_h}' is {len(_part)} characters, over Play's limit of {_max}")
    for _bad in ("completely free", "nothing to buy", "free forever", "JR Consulting", "Mumbai", "Ghatkopar", "github.com", "open source", "open-source"):
        if _bad.lower() in _all.lower():
            errors.append(f"store/{_file}: the store text must not contain {_bad!r}")
    if "Hookstep, India" not in _all:
        errors.append(f"store/{_file}: the maker line must read 'Hookstep, India'")
_video = (_store / "play-listing.md").read_text().split("## Promo video (YouTube URL)\n")[1].split("\n## ")[0].strip()
if not re.fullmatch(r"https://www\.youtube\.com/watch\?v=[\w-]{11}", _video):
    errors.append(f"store/play-listing.md: the promo video must be a https://www.youtube.com/watch?v=<id> URL, got {_video!r}")

# The home page demo video (build.py DEMO_CUTS, 25 Oct 2026). Nothing of it may load before the visitor presses play: preload="none",
# no autoplay, a lazy poster with fixed width and height, no YouTube or other iframe. Every source and poster points at a
# content-hashed file that exists in dist/ (nginx caches those for a year), the WebM type names AV1 at the level the file needs,
# VideoObject has what Google asks for and points at plain files that exist, and the figures the video states (DEMO_FACTS)
# still match the site's own constants: if one changed, the video is wrong and must be re-cut.
from build import DEMO_CUTS, DEMO_FACTS, DEMO_MEDIA, DEMO_SECONDS, PLUS_MONTH_INR, FACTS as FACTS_TEXT  # noqa: E402
_home = (DIST / "index.html").read_text()
_fig = re.search(r'<figure class="demo" id="demo">(.*?)</figure>', _home, re.S)
if not _fig or _home.count('<figure class="demo"') != 1:
    errors.append("index.html: the demo video (<!-- demo-video -->) must be on the home page exactly once")
else:
    _f = _fig.group(1)
    _video = re.search(r"<video([^>]*)>", _f).group(1)
    for _need in ('preload="none"', "playsinline", "aria-label="):
        if _need not in _video:
            errors.append(f"index.html: the demo <video> needs {_need}")
    if re.search(r"\bautoplay\b|\bposter=|\bcontrols\b", _video):
        errors.append("index.html: the demo <video> must not autoplay, carry a poster attribute (the poster is the lazy <picture>) "
                      "or have controls in the HTML (Chrome greys a frameless video with controls; the script adds them on play)")
    _nojs = re.search(r"<noscript>(.*?)</noscript>", _f, re.S)
    if not _nojs or sorted(re.findall(r'href="(/video/[^"]+\.mp4)"', _nojs.group(1))) != sorted(c["base"] + ".mp4" for c in DEMO_CUTS.values()):
        errors.append("index.html: without JS the demo needs a <noscript> link to each cut's MP4")
    _img = re.search(r"<img([^>]*)>", _f.split("<noscript>")[0]).group(1)
    for _need in ('loading="lazy"', 'decoding="async"', 'width="', 'height="', 'alt=""'):
        if _need not in _img:
            errors.append(f"index.html: the demo poster <img> needs {_need}")
    _urls = re.findall(r'(?:src|srcset)="(/video/[^"]+)"', _f.split("<noscript>")[0])
    if len(_urls) != 8:
        errors.append(f"index.html: the demo should have 4 video sources and 4 poster files, found {len(_urls)}")
    for _u in _urls:
        if not re.fullmatch(r"/video/[a-z0-9-]+\.[0-9a-f]{10}\.(webm|mp4|avif|webp)", _u):
            errors.append(f"index.html: demo file {_u} is not a content-hashed name")
        elif not (DIST / _u.lstrip("/")).exists():
            errors.append(f"index.html: demo file {_u} is not in dist/")
    for _c in DEMO_CUTS.values():
        _lvl = int(_c["av1"].split(".")[2][:2])
        if (_c["width"] * _c["height"] > 665_856) != (_lvl >= 5):
            errors.append(f"build.py DEMO_CUTS: {_c['av1']} is the wrong AV1 level for {_c['width']}x{_c['height']}")
    if _f.split("<noscript>")[0].count(f'media="{DEMO_MEDIA}"') != 4:
        errors.append("index.html: the wide cut's two poster and two video sources must carry the DEMO_MEDIA query")
if re.search(r"<iframe", _home):
    errors.append("index.html: no <iframe> on the home page (a YouTube embed would load before anyone asks for it)")
_vo = [n for b in re.findall(r'<script type="application/ld\+json">(.*?)</script>', _home, re.S)
       for n in json.loads(b).get("@graph", []) if n.get("@type") == "VideoObject"]
if len(_vo) != 1:
    errors.append(f"index.html: expected one VideoObject, found {len(_vo)}")
else:
    _vo = _vo[0]
    for _k in ("name", "description", "thumbnailUrl", "uploadDate", "contentUrl", "duration"):
        if not _vo.get(_k):
            errors.append(f"index.html: VideoObject has no {_k}")
    if _vo.get("duration") != f"PT{round(DEMO_SECONDS)}S":
        errors.append("index.html: VideoObject duration is malformed")
    # uploadDate must be a FULL ISO 8601 instant with a zone. It used to be
    # checked as a bare date, which is what Search Console rejected on 25 Oct
    # 2026 ("Datetime property 'uploadDate' is missing a time zone" and
    # "Invalid datetime value for 'uploadDate'"): Google reads uploadDate as a
    # DateTime and will not assume a zone. build.schema_datetime() produces it.
    if not re.fullmatch(SCHEMA_DATETIME_RE, _vo.get("uploadDate", "")):
        errors.append(f"index.html: VideoObject uploadDate {_vo.get('uploadDate')!r} is not an ISO 8601 datetime with a time zone")
    for _k in ("thumbnailUrl", "contentUrl"):
        _u = _vo.get(_k, "")
        if not _u.startswith(SITE + "/video/") or not (DIST / _u[len(SITE) + 1:]).exists():
            errors.append(f"index.html: VideoObject {_k} {_u} is not a file the site serves")
    if re.search(r"\bfree forever\b|completely free|jatinder|founder", json.dumps(_vo), re.I):
        errors.append("index.html: VideoObject text must not promise free forever or name a person")
_facts = {"plus_month_inr": PLUS_MONTH_INR, "min_age": 18, "distance_km": 0.5}
for _k, _v in DEMO_FACTS.items():
    if _facts[_k] != _v:
        errors.append(f"build.py DEMO_FACTS: the demo video says {_k} = {_v}, the site now says {_facts[_k]}; re-cut the video")
if "18+ only" not in FACTS_TEXT or "0.5 km" not in FACTS_TEXT:
    errors.append("build.py FACTS: the demo video says 18+ only and distances rounded to 0.5 km; FACTS no longer does, so re-cut it")

# The partner programme page (4 Nov 2026, src/partners.html; API lib/partner-signup.ts). What it promises is what the API does:
# 30% while they are a partner (never "lifetime" or "forever": the admin can end a partnership), paid monthly by bank or UPI,
# no paid promotion, and a real terms section whose version the API checks at sign-up. Sign-up happens in the web app, signed in.
_pp = DIST / "partners.html"
if not _pp.is_file():
    errors.append("partners.html: the partner programme page is missing")
else:
    _ph = _pp.read_text(encoding="utf-8")
    _pt = re.sub(r"\s+", " ", H.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"<script.*?</script>", " ", _ph, flags=re.S))))
    for _need, _why in ((r"\b30%", "the 30% share"), (r"\bmonthly\b", "monthly payouts"), (r"\bUPI\b", "UPI payouts"), (r"\bbank\b", "bank payouts"),
                        (r"no paid promotion", "the no-paid-promotion rule"), (r"as long as you are a partner|while you are a partner", "how long commission runs"),
                        (r"own (purchases|account)", "no commission on your own purchases")):
        if not re.search(_need, _pt, re.I):
            errors.append(f"partners.html: must state {_why}")
    for _bad in (r"\blifetime\b", r"\bforever\b", r"\bguarantee", r"\bpassive income\b"):
        if re.search(_bad, _pt, re.I):
            errors.append(f"partners.html: must not say {_bad!r}: commission runs while they are a partner, and the admin can end it")
    if not re.search(r'<section[^>]*\bid="terms"[^>]*\bdata-terms-version="\d{4}-\d{2}-\d{2}"', _ph):
        errors.append('partners.html: needs a <section id="terms" data-terms-version="YYYY-MM-DD"> with the partner terms')
    if 'href="/app/partner"' not in _ph:
        errors.append('partners.html: the sign-up button must go to the web app (href="/app/partner")')
    if "40%" in _pt:
        errors.append("partners.html: the 40% tier is admin-only and is not offered on the public page")
    if f"<loc>{SITE}/partners</loc>" not in (DIST / "sitemap.xml").read_text():
        errors.append("sitemap: /partners is not listed")
    if 'href="/partners"' not in (DIST / "index.html").read_text(encoding="utf-8"):
        errors.append("index.html: the footer does not link to /partners")

print(f"deepest page: {max(depth.values())} clicks from home")
print(f"{len(list(DIST.rglob('*.html')))} pages, {n_ld} JSON-LD blocks, {n_links} internal links checked")
print("\n".join(errors) if errors else "all good")
sys.exit(1 if errors else 0)
