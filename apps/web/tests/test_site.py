#!/usr/bin/env python3
"""Website build outputs that check.py doesn't cover: the sideload APK facts on /download, sitemap and robots shape, ads.txt,
the 404 page, and that every page builds from source. Standard library only (CI runs it on a bare Python).

    python3 apps/web/build.py && python3 -m unittest discover -s apps/web/tests -v

check.py stays the main guard (links, JSON-LD, titles, noindex rules, stale wording, hard-coded prices); this file adds facts.
"""
import json
import pathlib
import re
import unittest
import xml.etree.ElementTree as ET

WEB = pathlib.Path(__file__).resolve().parent.parent
DIST = WEB / "dist"
SITE = "https://tablamigo.hookstep.in"
NS = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}


def page(name):
    return (DIST / name).read_text(encoding="utf-8")


class Built(unittest.TestCase):
    def test_every_source_page_was_built(self):
        self.assertTrue(DIST.exists(), "run python3 apps/web/build.py first")
        for src in (WEB / "src").glob("*.html"):
            self.assertTrue((DIST / src.name).exists(), f"{src.name} was not built")


class AssetLinks(unittest.TestCase):
    """Android App Links: /.well-known/assetlinks.json lets Android open this site's /app/<plan|chat|user|...> links in the
    installed app (app.json lists them as autoVerify intent filters). Without it Android shows the browser, as it did until
    1 Nov 2026 (the URL answered with the 404 page). Fingerprints: Play Console, App integrity, App signing (app signing key
    for Play installs, upload key for the sideload APK on /download)."""

    APP_SIGNING = "E6:FD:57:77:7B:31:96:E5:79:DA:13:64:7E:90:6B:45:51:20:60:D4:00:FA:34:71:6B:85:DF:7B:C5:EB:4A:CE"
    UPLOAD = "69:5B:AC:EC:90:93:9F:CA:55:D1:3B:7C:B1:B0:D0:2D:18:C7:C4:E3:47:1A:63:28:A8:7A:EC:7D:D8:B5:9B:DD"

    def test_built_and_valid(self):
        f = DIST / ".well-known" / "assetlinks.json"
        self.assertTrue(f.exists(), "build.py must copy .well-known/ into dist/")
        data = json.loads(f.read_text())
        self.assertEqual(len(data), 1)
        s = data[0]
        self.assertEqual(s["relation"], ["delegate_permission/common.handle_all_urls"])
        self.assertEqual(s["target"]["namespace"], "android_app")
        self.assertEqual(s["target"]["package_name"], "com.tablamigo.app")
        fps = s["target"]["sha256_cert_fingerprints"]
        self.assertIn(self.APP_SIGNING, fps)
        self.assertIn(self.UPLOAD, fps)
        for fp in fps:
            self.assertRegex(fp, r"^([0-9A-F]{2}:){31}[0-9A-F]{2}$")

    def test_app_json_claims_only_this_host_under_app(self):
        app = json.loads((WEB.parent / "mobile" / "app.json").read_text())
        filters = [f for f in app["expo"]["android"]["intentFilters"] if f.get("autoVerify")]
        self.assertEqual(len(filters), 1)
        for d in filters[0]["data"]:
            self.assertEqual(d["scheme"], "https")
            self.assertEqual(d["host"], SITE.removeprefix("https://"))
            self.assertRegex(d["pathPrefix"], r"^/app/[a-z]+/$")


class Apk(unittest.TestCase):
    """apk.json is a build input (it is not served: /apk.json is a 404 live), so /download must carry its facts."""

    @classmethod
    def setUpClass(cls):
        cls.apk = json.loads((WEB / "apk.json").read_text())
        cls.download = page("download.html")

    def test_apk_json_shape(self):
        a = self.apk
        self.assertEqual(sorted(a), ["code", "date", "sha256", "size", "version"])
        self.assertRegex(a["version"], r"^\d+\.\d+\.\d+$")
        self.assertIsInstance(a["code"], int)
        self.assertGreater(a["code"], 0)
        self.assertRegex(a["size"], r"^\d+ MB$")
        self.assertRegex(a["sha256"], r"^[0-9a-f]{64}$")
        self.assertRegex(a["date"], r"^[A-Z][a-z]{2} \d{1,2}, \d{4}$")

    def test_download_page_shows_the_same_version_size_and_hash(self):
        self.assertIn(self.apk["sha256"], self.download)
        self.assertIn(f"version {self.apk['version']}", self.download)
        self.assertIn(f"({self.apk['size']}", self.download)
        self.assertNotIn("{{apk_", self.download, "an apk token was left unreplaced")

    def test_download_links_the_apk_file_served_by_nginx(self):
        self.assertIn('href="/apk/tablamigo.apk"', self.download)

    def test_no_page_leaves_a_build_token(self):
        for f in DIST.rglob("*.html"):
            body = f.read_text(encoding="utf-8")
            self.assertIsNone(re.search(r"\{\{\s*\w+\s*\}\}", body), f"{f.relative_to(DIST)} has an unreplaced {{token}}")


class Sitemap(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = ET.parse(DIST / "sitemap.xml").getroot()
        cls.urls = [(u.find("s:loc", NS).text, u.find("s:lastmod", NS)) for u in cls.root.findall("s:url", NS)]

    def test_well_formed_and_on_this_site(self):
        self.assertGreaterEqual(len(self.urls), 40)
        locs = [u for u, _ in self.urls]
        self.assertEqual(len(locs), len(set(locs)), "a URL is listed twice")
        for loc, _ in self.urls:
            self.assertTrue(loc == SITE + "/" or loc.startswith(SITE + "/"), loc)
            self.assertNotRegex(loc, r"\.html$", f"{loc}: clean URLs only")

    def test_lastmod_is_a_plain_date(self):
        for loc, lastmod in self.urls:
            if lastmod is not None:
                self.assertRegex(lastmod.text, r"^\d{4}-\d{2}-\d{2}$", loc)

    def test_no_listed_page_is_noindex(self):
        for loc, _ in self.urls:
            rel = loc[len(SITE) + 1:] or "index"
            f = DIST / (rel + ".html") if not (DIST / rel).is_dir() else DIST / rel / "index.html"
            if not f.exists():
                f = DIST / (rel + ".html")
            self.assertTrue(f.exists(), f"{loc} has no built file")
            self.assertNotRegex(f.read_text(encoding="utf-8"), r'<meta name="robots" content="[^"]*noindex', loc)

    def test_robots_allows_everyone_and_names_the_sitemap(self):
        robots = page("robots.txt")
        self.assertIn(f"Sitemap: {SITE}/sitemap.xml", robots)
        self.assertNotRegex(robots, r"(?m)^Disallow:\s*/\s*$")


class Misc(unittest.TestCase):
    def test_ads_txt_and_app_ads_txt_name_the_adsense_publisher(self):
        build = (WEB / "build.py").read_text()
        line = re.search(r'^GOOGLE_ADS_TXT = "([^"]+)"', build, re.M).group(1)
        for f in ("ads.txt", "app-ads.txt"):
            self.assertIn(line, page(f).splitlines(), f)

    def test_404_page_is_noindex(self):
        self.assertRegex(page("404.html"), r'<meta name="robots" content="[^"]*noindex')

    def test_indexnow_key_file_matches_build_py(self):
        key = re.search(r'^INDEXNOW_KEY = "([0-9a-f]+)"', (WEB / "build.py").read_text(), re.M).group(1)
        self.assertEqual((DIST / f"{key}.txt").read_text().strip(), key)

    def test_llms_files_exist_and_open_with_the_definition(self):
        for f in ("llms.txt", "llms-full.txt", "llms-guides.txt", "llms-india.txt"):
            self.assertGreater(len(page(f)), 200, f)
        self.assertIn("Tablamigo is a solo-travel app", page("llms.txt"))


class Ads(unittest.TestCase):
    """Google AdSense on the guides (build.py ADSENSE_*, 25 Oct 2026): which pages carry the loader, that the web app and the
    sensitive pages never do, that /ads.txt ships and is purged on deploy, and that the privacy policy says what is on."""

    @classmethod
    def setUpClass(cls):
        import sys
        sys.path.insert(0, str(WEB))
        import build
        cls.b = build
        cls.pages = {f.relative_to(DIST).as_posix(): f.read_text(encoding="utf-8") for f in DIST.rglob("*.html")}
        cls.loader = "adsbygoogle.js?client=" + build.ADSENSE_CLIENT

    def carries(self, rel):
        return self.loader in self.pages[rel]

    def test_loader_exactly_on_the_how_to_guides_and_the_full_city_guides(self):
        self.assertTrue(self.b.ADSENSE_ON)
        want = sorted(r for r in self.pages if r in self.b.INFOLINKS_GUIDES
                      or (re.fullmatch(r"solo-travel/[a-z0-9-]+\.html", r) and r[12:-5] not in self.b.THIN_GUIDES))
        self.assertGreaterEqual(len(want), 15)
        self.assertEqual(sorted(r for r in self.pages if self.carries(r)), want)
        for r in want:
            self.assertEqual(self.pages[r].count(self.b.ADSENSE_TAG), 1, r)

    def test_never_on_home_download_app_pages_comparisons_safety_legal_404_admin_or_thin_guides(self):
        never = ["index.html", "download.html", "privacy.html", "terms.html", "delete-account.html", "child-safety.html", "safety.html",
                 "about.html", "press.html", "partnerships.html", "404.html", "admin.html", "solo-travel.html", "solo-female-travel-india.html",
                 "solo-female-travel-app.html", "nomadtable-alternative.html", "best-apps-to-meet-travelers.html", "travel-buddy-app.html"]
        never += [f"solo-travel/{s}.html" for s in self.b.THIN_GUIDES]
        for r in never:
            self.assertIn(r, self.pages, r)
            self.assertNotIn("adsbygoogle", self.pages[r], r)
            self.assertNotIn("pagead2.googlesyndication.com", self.pages[r], r)

    def test_the_web_app_at_app_has_no_ad_code(self):
        """/app/ is the Expo web export, built from apps/mobile; its HTML shell and its source never load an ad network."""
        mobile = WEB.parent / "mobile"
        shell = (mobile / "public" / "index.html").read_text()
        self.assertNotIn("adsbygoogle", shell)
        self.assertNotIn("googlesyndication", shell)
        for f in (mobile / "src").rglob("*.ts*"):
            text = f.read_text(encoding="utf-8")
            self.assertNotIn("adsbygoogle", text, f)
            self.assertNotIn("googlesyndication", text, f)
        # The only ads code in the app is AdMob, and its web stubs render nothing.
        self.assertIn("return null", (mobile / "src" / "components" / "ExploreAd.web.tsx").read_text())
        self.assertIn("enabled: false", (mobile / "src" / "lib" / "ads.web.ts").read_text())
        # The website build has no /app/ pages of its own to put a loader on (nginx serves the export there).
        self.assertFalse((DIST / "app").exists())

    def test_loader_waits_for_interaction_and_gates_on_consent_in_both_states(self):
        self.assertEqual(self.b.ADSENSE_JS, self.b.adsense_js(self.b.ADSENSE_CMP))
        self.assertIn(f"var CMP={'true' if self.b.ADSENSE_CMP else 'false'},", self.b.ADSENSE_JS)
        for state in (True, False):
            js = self.b.adsense_js(state)
            self.assertIn(f"var CMP={'true' if state else 'false'},", js)
            self.assertIn("location.hostname!=='tablamigo.hookstep.in'", js)
            for ev in ("'scroll'", "'pointerdown'", "'keydown'", "'touchstart'"):
                self.assertIn(ev, js)
            self.assertNotIn("addEventListener('load'", js)
            self.assertIn("s.async=true", js)
            self.assertIn(self.b.ADSENSE_SRC, js)
            self.assertIn("if(CMP)return add()", js)  # with the message on, no country lookup
            self.assertIn("/cdn-cgi/trace", js)       # without it, the country gate
            for cc in ("DE", "FR", "IT", "ES", "NL", "IE", "PL", "SE", "NO", "IS", "LI", "GB", "CH"):
                self.assertIn(f'"{cc}"', js)

    def test_consent_switch_says_what_must_be_seen_before_it_goes_on(self):
        """The evidence for ADSENSE_CMP and the live check that has to pass before True sit next to the switch."""
        src = (WEB / "build.py").read_text()
        block = src[src.index("# Consent. Google needs"):src.index("ADSENSE_CMP = ")]
        for w in ("European regulations message - hookstep.in", "answer/14113511", "fc=alwaysshow", "EEA connection",
                  "fresh browser profile", "gdpr=1&gdpr_consent=", "Privacy and cookie settings"):
            self.assertIn(w, block)

    def test_ads_txt_is_built(self):
        self.assertEqual(page("ads.txt").splitlines()[0], self.b.GOOGLE_ADS_TXT)
        self.assertEqual(self.b.ADSENSE_CLIENT, "ca-" + self.b.GOOGLE_ADS_TXT.split(", ")[1])  # the same AdSense publisher

    def test_privacy_policy_names_adsense_cookies_and_the_opt_outs(self):
        priv = page("privacy.html")
        for w in ("Google AdSense", "Third-party vendors, including Google, use cookies to serve ads based on your prior visits",
                  "https://www.google.com/settings/ads", "aboutads.info", "youronlinechoices.eu",
                  "https://policies.google.com/technologies/partner-sites", "/solo-travel/", "Last updated: 1 November 2026"):
            self.assertIn(w, priv)
        self.assertNotIn("use no advertising trackers.", priv.split("The short version.")[1].split("</div>")[0])
        gate_off = "If it is in the EEA, the UK or Switzerland, or the country can't be told, the script isn't loaded"
        gate_on = "In the EEA, the UK and Switzerland, Google first shows its consent message"
        if self.b.ADSENSE_CMP:
            self.assertIn(gate_on, priv)
            self.assertNotIn(gate_off, priv)
            self.assertEqual(priv.count("Privacy and cookie settings"), 2)  # the vendor item and the choices list
            self.assertIn("cookies for the ads on this website's travel guides, which you accept or refuse in Google's consent message", priv)
        else:
            self.assertIn(gate_off, priv)
            self.assertNotIn(gate_on, priv)
            self.assertNotIn("Privacy and cookie settings", priv)
        if self.b.ANDROID_ADS_LIVE:  # a Play release shows the AdMob banner: the policy says so
            for w in ("Ads in the Android app (Google AdMob)", "Ad privacy choices", "Plus members see no ads"):
                self.assertIn(w, priv)
            self.assertNotIn("The Android app and the web app have no ads", priv)
        else:  # no Play release shows ads: the apps themselves have none
            self.assertIn("The Android app and the web app have no ads and no advertising trackers.", priv)
            self.assertNotIn("AdMob", priv)

    def test_pages_with_ads_never_claim_there_are_no_ads(self):
        for r, text in self.pages.items():
            if self.carries(r):
                self.assertNotIn("with no ads", text, r)
                self.assertNotIn("no ads or sponsored listings in Tablamigo today", text, r)



class DemoVideo(unittest.TestCase):
    """The home page demo video (build.py DEMO_CUTS): what ships in dist/, read from the files themselves. check.py holds the
    markup and the schema; this holds the encodes: AV1/Opus WebM at the level its type names, faststart H.264 MP4, posters at
    the size of the video, content-hashed names that match the bytes, and sizes within budget."""

    BUDGET = {"720p": {"webm": 2_500_000, "mp4": 3_000_000}, "540p": {"webm": 2_000_000, "mp4": 2_200_000}}

    @classmethod
    def setUpClass(cls):
        import sys
        sys.path.insert(0, str(WEB))
        import build
        cls.b = build
        cls.home = page("index.html")
        cls.fig = re.search(r'<figure class="demo" id="demo">(.*?)</figure>', cls.home, re.S).group(1)

    def files(self):
        return re.findall(r'(?:src|srcset)="/video/([^"]+)"', self.fig.split("<noscript>")[0])

    def test_without_js_the_poster_sits_on_top_with_a_link_to_each_mp4(self):
        # Chrome shows a video's native controls when JS is off, whatever its attributes say; their grey panel would cover the
        # poster behind it, so <noscript> repeats the poster after the <video> (on top), then a link to each cut's MP4.
        nojs = re.search(r"<noscript>(.*?)</noscript>", self.fig, re.S).group(1)
        self.assertLess(self.fig.index("<video"), self.fig.index("<noscript>"))
        self.assertEqual(re.findall(r'(?:src|srcset)="/video/([^"]+)"', nojs), self.files()[:4])
        self.assertEqual(re.findall(r'href="(/video/[^"]+)"', nojs), ["/video/tablamigo-demo-540p.mp4", "/video/tablamigo-demo-720p.mp4"])
        for name in re.findall(r'href="/video/([^"]+)"', nojs):
            self.assertTrue((DIST / "video" / name).exists(), name)

    def test_every_file_is_named_after_its_own_sha256(self):
        import hashlib
        names = self.files()
        self.assertEqual(len(names), 8)
        for name in names:
            stem, digest, ext = name.rsplit(".", 2)
            data = (DIST / "video" / name).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest()[:10], digest, name)
            self.assertEqual((DIST / "video" / f"{stem}.{ext}").read_bytes(), data, f"{name} differs from its plain copy")

    def test_webm_is_av1_and_opus_at_the_level_its_type_names(self):
        for cut in self.b.DEMO_CUTS.values():
            name = next(f for f in self.files() if f.startswith(cut["base"].split("/")[-1] + ".") and f.endswith(".webm"))
            head = (DIST / "video" / name).read_bytes()[:4096]
            self.assertEqual(head[:4], bytes([0x1A, 0x45, 0xDF, 0xA3]), "not EBML")
            self.assertIn(b"webm", head)
            self.assertIn(b"V_AV1", head)
            self.assertIn(b"A_OPUS", head)
            av1c = head.index(bytes([0x63, 0xA2]), head.index(b"V_AV1")) + 3   # CodecPrivate, one-byte size, then av1C
            level = head[av1c + 1] & 0x1F
            self.assertEqual(f"av01.0.{level:02d}M.08", cut["av1"], name)
            self.assertIn(f'codecs=&quot;{cut["av1"]}, opus&quot;', self.fig)

    def test_mp4_is_faststart_h264_aac_at_the_cut_size(self):
        for cut in self.b.DEMO_CUTS.values():
            stem = cut["base"].split("/")[-1]
            name = next(f for f in self.files() if f.startswith(stem + ".") and f.endswith(".mp4"))
            data = (DIST / "video" / name).read_bytes()
            self.assertEqual(data[4:8], b"ftyp")
            self.assertLess(data.index(b"moov"), data.index(b"mdat"), f"{name}: moov after mdat, so playback waits for the whole file")
            at = data.index(b"avc1", data.index(b"stsd"))
            self.assertEqual((int.from_bytes(data[at + 28:at + 30], "big"), int.from_bytes(data[at + 30:at + 32], "big")),
                             (cut["width"], cut["height"]))
            self.assertIn(b"mp4a", data[:200_000])

    def test_posters_are_small_and_the_size_of_the_video(self):
        for cut in self.b.DEMO_CUTS.values():
            stem = cut["base"].split("/")[-1]
            avif = (DIST / "video" / next(f for f in self.files() if f.startswith(stem + ".") and f.endswith(".avif"))).read_bytes()
            self.assertEqual(avif[8:12], b"avif")
            at = avif.index(b"ispe")
            self.assertEqual((int.from_bytes(avif[at + 8:at + 12], "big"), int.from_bytes(avif[at + 12:at + 16], "big")),
                             (cut["width"], cut["height"]))
            self.assertLess(len(avif), 20 * 1024)
            webp = (DIST / "video" / next(f for f in self.files() if f.startswith(stem + ".") and f.endswith(".webp"))).read_bytes()
            self.assertEqual(webp[:4] + webp[8:12], b"RIFFWEBP")
            self.assertEqual((int.from_bytes(webp[26:28], "little") & 0x3FFF, int.from_bytes(webp[28:30], "little") & 0x3FFF),
                             (cut["width"], cut["height"]))
            self.assertLess(len(webp), 30 * 1024)

    def test_sizes_within_budget(self):
        for res, limits in self.BUDGET.items():
            for ext, limit in limits.items():
                name = next(f for f in self.files() if f"-{res}." in f and f.endswith("." + ext))
                self.assertLessEqual((DIST / "video" / name).stat().st_size, limit, name)

    def test_nothing_loads_before_play(self):
        video = re.search(r"<video([^>]*)>", self.fig).group(1)
        self.assertIn('preload="none"', video)
        self.assertNotIn("autoplay", video)
        self.assertNotIn("poster=", video)
        img = re.search(r"<img([^>]*)>", self.fig).group(1)
        self.assertIn('loading="lazy"', img)
        self.assertIn('fetchpriority="low"', img)
        self.assertNotIn("<iframe", self.home)
        # Nothing about the demo in <head>: no preload or prefetch of its files.
        head = self.home.split("</head>")[0]
        self.assertNotIn("/video/", head.split("application/ld+json")[0])

    def test_transcript_is_every_caption_line_in_order(self):
        import html
        shown = [html.unescape(re.sub(r"<br>.*", "", li)) for li in re.findall(r"<li>(.*?)</li>", self.home.split('class="demo-transcript"')[1].split("</details>")[0])]
        self.assertEqual(shown, [said for said, _ in self.b.DEMO_TRANSCRIPT])
        self.assertNotIn("{{", self.home.split('class="demo-transcript"')[1].split("</details>")[0])

    def test_video_object_names_the_wide_cut_and_its_length(self):
        import json as j
        nodes = [n for b in re.findall(r'<script type="application/ld\+json">(.*?)</script>', self.home, re.S) for n in j.loads(b)["@graph"]]
        vo = next(n for n in nodes if n["@type"] == "VideoObject")
        self.assertEqual(vo["contentUrl"], SITE + "/video/tablamigo-demo-720p.mp4")
        self.assertEqual(vo["thumbnailUrl"], SITE + "/video/tablamigo-demo-720p.webp")
        self.assertEqual(vo["duration"], "PT50S")
        # uploadDate is the authored date as a full ISO 8601 instant with the
        # IST offset (build.schema_datetime). A bare "2026-10-25" is what
        # Search Console rejected on 25 Oct 2026 - "Datetime property
        # 'uploadDate' is missing a time zone" and "Invalid datetime value for
        # 'uploadDate'" - because Google reads uploadDate as a DateTime.
        self.assertEqual(vo["uploadDate"], self.b.schema_datetime(self.b.DEMO_UPLOADED))
        self.assertEqual(vo["uploadDate"], self.b.DEMO_UPLOADED + "T00:00:00+05:30")
        self.assertRegex(vo["uploadDate"], r"^" + self.b.SCHEMA_DATETIME_RE + r"$")
        self.assertEqual(vo["transcript"], " ".join(said for said, _ in self.b.DEMO_TRANSCRIPT))
        self.assertTrue(any(n["@type"] == "VideoObject" for n in nodes))
        self.assertEqual(sum(n["@type"] == "VideoObject" for n in nodes), 1)

    def test_only_the_home_page_has_it(self):
        for f in DIST.rglob("*.html"):
            if f.name != "index.html" or f.parent != DIST:
                self.assertNotIn('class="demo-box"', f.read_text(encoding="utf-8"), f)
                self.assertNotIn("VideoObject", f.read_text(encoding="utf-8"), f)

    def test_build_copies_the_video_files(self):
        # video/ is copied into dist/ by build.py.
        self.assertTrue((DIST / "video").is_dir())


class SearchSnippets(unittest.TestCase):
    """Titles and descriptions rewritten for a query that had impressions and no clicks (Search Console)."""

    def snippet(self, name):
        html = page(name)
        title = re.search(r"<title>([^<]*)</title>", html).group(1)
        desc = re.search(r'<meta name="description" content="([^"]*)"', html).group(1)
        return title, desc

    def test_strangers_page_leads_with_the_query(self):
        # "solo travel with strangers in india": 32 impressions, 0 clicks, 21-27 Oct 2026. Title and description both open
        # with it, and the operator price quoted is the cheapest one in the page's own operators table.
        title, desc = self.snippet("solo-trip-with-strangers-india.html")
        query = "solo travel with strangers in india"
        self.assertTrue(title.lower().startswith(query), title)
        self.assertTrue(desc.lower().startswith(query), desc)
        body = page("solo-trip-with-strangers-india.html")
        table = body[body.index("<h3>Operators compared</h3>"):body.index("</table>", body.index("<h3>Operators compared</h3>"))]
        cheapest = min(int(p.replace(",", "")) for p in re.findall(r"₹([\d,]+)", table))
        self.assertIn(f"day treks from ₹{cheapest:,}", desc)
        # "3 ways" and "how to vet an operator" are promises the body has to keep.
        self.assertIn("3 ways", title)
        self.assertEqual(body.count("<h2>Option "), 3)
        self.assertIn('id="vet"', body)


class BrandEntity(unittest.TestCase):
    """One Hookstep and one Tablamigo across both sites (25 Oct 2026): hookstep.in's Organization is
    https://hookstep.in/#organization and lists https://tablamigo.hookstep.in/#tablamigo as a subOrganization, so every page here
    must name that same Hookstep node, and Tablamigo's parentOrganization must point at it."""

    HOOKSTEP = "https://hookstep.in/#organization"

    def graph(self, name):
        nodes = []
        for m in re.finditer(r'<script type="application/ld\+json">(.*?)</script>', page(name), re.S):
            doc = json.loads(m.group(1))
            nodes += doc.get("@graph", [doc])
        return nodes

    def test_every_page_names_hookstep_by_the_hookstep_in_id(self):
        for f in sorted(DIST.glob("*.html")) + sorted((DIST / "solo-travel").glob("*.html")):
            text = f.read_text(encoding="utf-8")
            self.assertNotIn(SITE + "/#org\"", text, f"{f.name} still uses the old local Hookstep @id")
            if "application/ld+json" not in text:
                continue
            nodes = self.graph(str(f.relative_to(DIST)))
            orgs = [n for n in nodes if n.get("@type") == "Organization" and n.get("name") == "Hookstep"]
            for o in orgs:
                self.assertEqual(o["@id"], self.HOOKSTEP, f.name)

    def test_tablamigo_entity_on_the_home_page(self):
        nodes = self.graph("index.html")
        by_id = {n.get("@id"): n for n in nodes if n.get("@id")}
        t = by_id[SITE + "/#tablamigo"]
        self.assertEqual(t["name"], "Tablamigo")
        self.assertEqual(t["url"], SITE + "/")
        self.assertEqual(t["logo"], SITE + "/icon.png")
        self.assertEqual(t["parentOrganization"], {"@id": self.HOOKSTEP})
        self.assertIn("https://play.google.com/store/apps/details?id=com.tablamigo.app", t["sameAs"])
        self.assertIn("https://www.producthunt.com/products/tablamigo", t["sameAs"])
        self.assertEqual(by_id[self.HOOKSTEP]["brand"], {"@id": SITE + "/#tablamigo"})
        site = by_id[SITE + "/#website"]
        self.assertEqual(site["name"], "Tablamigo")
        self.assertEqual(site["publisher"], {"@id": SITE + "/#tablamigo"})
        app = by_id[SITE + "/#app"]
        self.assertEqual(app["@type"], "MobileApplication")
        self.assertEqual(app["name"], "Tablamigo")

    def test_brand_pages_lead_with_the_name(self):
        for name in ("index.html", "about.html", "download.html"):
            html = page(name)
            title = re.search(r"<title>(.*?)</title>", html, re.S).group(1)
            h1 = re.sub(r"<[^>]+>", "", re.search(r"<h1[^>]*>(.*?)</h1>", html, re.S).group(1))
            self.assertTrue(title.startswith("Tablamigo"), f"{name} title: {title}")
            self.assertTrue(h1.strip().startswith("Tablamigo"), f"{name} H1: {h1}")
            self.assertIn('<meta property="og:site_name" content="Tablamigo">', html, name)


class SchemaDateTimes(unittest.TestCase):
    """Every JSON-LD datetime this site publishes carries a time zone.

    Search Console rejected the home page's VideoObject on 25 Oct 2026 with
    "Datetime property 'uploadDate' is missing a time zone" and "Invalid
    datetime value for 'uploadDate'", because the value was the bare date
    "2026-10-25". Google reads datePublished, dateModified and uploadDate as
    DateTime and will not assume a zone. Dates stay authored as plain dates
    (DEMO_UPLOADED, LAUNCHED, lastmod.json), which is right for a <time
    datetime> attribute and for a sitemap <lastmod>; build.schema_datetime()
    converts them on the way into the graph.
    """

    @classmethod
    def setUpClass(cls):
        import sys
        sys.path.insert(0, str(WEB))
        import build
        cls.b = build
        # check.py runs its whole audit at import, so its walker is taken from
        # the source rather than by importing the module.
        source = (WEB / "check.py").read_text(encoding="utf-8")
        chunk = source[source.index("DATETIME_PROPERTIES = ("):source.index("def page_key(")]
        ns = {"re": re, "SCHEMA_DATETIME_RE": build.SCHEMA_DATETIME_RE}
        exec(compile(chunk, "check.py", "exec"), ns)  # noqa: S102
        cls.violations = staticmethod(ns["datetime_violations"])
        cls.properties = ns["DATETIME_PROPERTIES"]

    def test_schema_datetime_converts_a_date_and_passes_an_instant_through(self):
        self.assertEqual(self.b.schema_datetime("2026-10-25"), "2026-10-25T00:00:00+05:30")
        self.assertEqual(self.b.schema_datetime("2026-10-25T04:30:00Z"), "2026-10-25T04:30:00Z")
        self.assertEqual(self.b.schema_datetime(""), "")
        for authored in (self.b.DEMO_UPLOADED, self.b.LAUNCHED):
            self.assertRegex(self.b.schema_datetime(authored), r"^" + self.b.SCHEMA_DATETIME_RE + r"$")

    def test_the_walker_rejects_what_search_console_rejected(self):
        self.assertEqual(
            self.violations({"@type": "VideoObject", "uploadDate": "2026-10-25"}),
            ["VideoObject.uploadDate is '2026-10-25', not an ISO 8601 datetime with a time zone"],
        )
        # A local time with no offset, ISO 8601 basic format (XSD dateTime
        # wants the colon), and values that are not strings at all.
        for bad in ("2026-10-25T00:00:00", "2026-10-25T00:00:00+0530", "", None, 20261025):
            self.assertEqual(len(self.violations({"@type": "Article", "dateModified": bad})), 1, bad)
        # It finds every violation, not only the first, and walks into @graph.
        found = self.violations({"@graph": [
            {"@type": "Article", "datePublished": "2026-10-01", "dateModified": "2026-10-02"},
            {"@type": "VideoObject", "uploadDate": "2026-10-25T00:00:00+05:30"},
        ]})
        self.assertEqual(len(found), 2)

    def test_every_datetime_property_the_build_emits_is_on_the_list(self):
        """A property emitted by build.py but missing from DATETIME_PROPERTIES would never be checked."""
        source = (WEB / "build.py").read_text(encoding="utf-8")
        emitted = set(re.findall(r'"(datePublished|dateModified|dateCreated|uploadDate|datePosted|validFrom|validThrough|startDate|endDate)":', source))
        self.assertTrue(emitted)
        for prop in emitted:
            self.assertIn(prop, self.properties)

    def test_no_built_page_publishes_a_bare_date(self):
        checked = 0
        for f in sorted(DIST.rglob("*.html")):
            for block in re.findall(r'<script type="application/ld\+json">(.*?)</script>', f.read_text(encoding="utf-8"), re.S):
                checked += 1
                self.assertEqual(self.violations(json.loads(block)), [], f.relative_to(DIST))
        self.assertGreater(checked, 50, "no JSON-LD blocks were read")


class IphonePath(unittest.TestCase):
    """Tablamigo has no iOS app: iPhone users get the web app, installed from Safari (Share, Add to Home Screen)."""

    def test_download_page_has_install_on_iphone_for_ios_only(self):
        html = page("download.html")
        self.assertRegex(html, r'<section id="iphone-install"[^>]*\bhidden\b')
        self.assertIn("Add to Home Screen", html)
        self.assertIn("#iphone-install", html)
        self.assertIn('class="qr"', html)  # on a Mac or PC, the iPhone badge leads to a QR code for the phone
        for needle in ("Open the web app", "Add to Dock", "Install Tablamigo"):
            self.assertIn(needle, html)

    def test_iphone_never_offered_google_play(self):
        """Owner's rule (4 Nov 2026, "like Google, OpenAI"): a phone or tablet sees only its own platform, every computer (Mac included)
        sees both. <head> tags the device before the CSS; both badges are hidden until it has. Every Play badge sits with the
        iPhone badge in one .store-badges row."""
        css = (WEB / "style.css").read_text(encoding="utf-8")
        self.assertRegex(css, r"\n\.play-badge, \.ios-badge \{ display: none; \}")
        self.assertRegex(css, r"\.os-android \.play-badge, \.os-desktop \.play-badge \{ display: inline-block; \}")
        self.assertRegex(css, r"\.os-ios \.ios-badge, \.os-desktop \.ios-badge \{ display: inline-flex; \}")
        self.assertNotRegex(css, r"os-apple|os-mac")
        build = (WEB / "build.py").read_text(encoding="utf-8")
        for needle in ("iPhone|iPad|iPod", "maxTouchPoints", "os-ios", "os-android", "os-desktop"):
            self.assertIn(needle, build)
        with_badge = 0
        for f in DIST.rglob("*.html"):
            text = f.read_text(encoding="utf-8")
            if 'class="play-badge"' not in text:
                continue
            with_badge += 1
            self.assertEqual(text.count('class="play-badge"'), text.count('class="ios-badge"'), f.name)
            self.assertEqual(text.count('class="play-badge"'), len(re.findall(r'<span class="store-badges"><a class="play-badge"[^>]*>.*?</a><a class="ios-badge"', text)), f.name)
            self.assertIn("<noscript><style>", text, f.name)
            head = text.split("</head>")[0]
            self.assertIn("os-ios", head, f.name)
            self.assertLess(head.index("os-ios"), head.index("<style>"), f"{f.name}: the device class must be set before the CSS")
            self.assertRegex(text, r'class="ios-badge" href="/download#iphone-install"', f.name)
            # Play buttons that aren't the badge are hidden on iOS too.
            for btn in re.findall(r'<p class="([^"]*)"><a [^>]*class="btn primary big" href="https://play\.google\.com', text):
                self.assertIn("play-cta", btn, f.name)
        self.assertGreater(with_badge, 50)

    def test_no_page_claims_a_tablamigo_app_store_listing(self):
        # Links to other companies' App Store pages (comparisons) are fine; a Tablamigo one or an App Store badge is not.
        for f in DIST.glob("*.html"):
            text = f.read_text(encoding="utf-8")
            self.assertNotRegex(text, r'href="https?://(?:apps|itunes)\.apple\.com/[^"]*tablamigo', f.name)
            self.assertNotRegex(text, r"(?i)download on the app store|app-store-badge", f.name)

    def test_web_app_installs_on_ios(self):
        app = WEB.parent / "mobile" / "public"
        index = (app / "index.html").read_text(encoding="utf-8")
        for needle in ('rel="manifest"', 'rel="apple-touch-icon"', 'name="apple-mobile-web-app-capable" content="yes"'):
            self.assertIn(needle, index)
        manifest = json.loads((app / "manifest.webmanifest").read_text())
        self.assertTrue(manifest["start_url"].startswith("/app/"))
        self.assertEqual(manifest["display"], "standalone")
        self.assertTrue((app / "icons" / "apple-touch-icon.png").exists())
        for size in (32, 48):  # the tab icon is the Tablamigo logo (not Expo's default caret), at sizes browsers pick
            self.assertIn(f'sizes="{size}x{size}" href="/app/icons/favicon-{size}.png"', index)
            self.assertTrue((app / "icons" / f"favicon-{size}.png").exists())


class AdminUsers(unittest.TestCase):
    """A click on a user's picture opens it full size; only the Impersonate button (or the row's own drawer) does anything else."""

    @classmethod
    def setUpClass(cls):
        cls.admin = page("admin.html")

    def test_avatar_click_opens_lightbox_before_the_row_handler(self):
        m = re.search(r"tr\[data-id\]'\)\.forEach\(tr => tr\.addEventListener\('click', e => \{(.*?)\n    \}\)\);", self.admin, re.S)
        self.assertTrue(m, "users row click handler not found")
        body = m.group(1)
        self.assertLess(body.index("openPhoto("), body.index("openUser("))
        self.assertNotIn("impersonate", body)

    def test_lightbox_closes_on_escape_and_outside_click_and_has_a_fallback(self):
        fn = re.search(r"function openPhoto\(.*?\n\}\n", self.admin, re.S).group(0)
        self.assertIn("'Escape'", fn)
        self.assertIn("lb.addEventListener('click'", fn)
        self.assertIn("No photo", fn)
        self.assertNotIn("impersonate", fn)

    def test_impersonation_only_from_explicit_buttons(self):
        self.assertEqual(len(re.findall(r"/impersonate`", self.admin)), 2)


class AdminDrillDown(unittest.TestCase):
    """Every number on the admin Overview links to the list it counts; deleted accounts are never shown as active or impersonable;
    every person, plan and email reference opens its drawer."""

    @classmethod
    def setUpClass(cls):
        cls.admin = page("admin.html")
        cls.overview = re.search(r"VIEWS\.overview = async \(\) => \{(.*?)\n\};", cls.admin, re.S).group(1)

    def test_no_bare_number_on_the_overview(self):
        # A count rendered straight into a <b> or a KPI value would be a number you can't click.
        self.assertNotRegex(self.overview, r"<b>\$\{n\(")
        self.assertNotRegex(self.overview, r'class="v">\$\{(n|inr)\(')

    def test_queue_rows_link_to_filtered_lists(self):
        for label, href in [("Plans posted, 7 days", "#plans?created=7d&host=people&status=all&when=all"), ("Upcoming trips", "#trips"),
                            ("Emails sent, 7 days", "#emails?status=sent&days=7"), ("Selfies being checked", "#verifications?status=pending"),
                            ("Upcoming plans", "#plans?host=people")]:
            row = next(l for l in self.overview.splitlines() if label in l)
            self.assertIn(f"drill('{href}'", row, label)

    def test_kpis_link_to_user_filters(self):
        for f in ["people", "onboarded", "verified", "signup_today", "signup_7d", "signup_30d", "active_1d", "active_7d", "active_30d", "plus"]:
            self.assertIn(f"#users?filter={f}'", self.overview, f)
            self.assertIn(f"['{f}',", self.admin, f"users filter select lacks {f}")

    def test_trips_tab_and_plan_drawer_exist(self):
        self.assertIn("['trips', 'Trips']", self.admin)
        self.assertIn("VIEWS.trips = async", self.admin)
        self.assertIn("async function openPlan(id)", self.admin)
        self.assertIn("api('/admin/plans/' + encodeURIComponent(id))", self.admin)

    def test_deleted_accounts_are_never_active_or_impersonable(self):
        status = re.search(r"const userStatus = u => (.*?);\n", self.admin, re.S).group(1)
        self.assertLess(status.index("u.deletedAt"), status.index("'Active'"))
        drawer = re.search(r"async function openUser\(.*?\n\}\n", self.admin, re.S).group(0)
        actions = drawer[drawer.index('<div class="actions">'):drawer.index("<!-- User Journey")]
        self.assertLess(actions.index("u.deletedAt ?"), actions.index('id="imp-btn"'))
        self.assertIn("${u.deletedAt ? '<span class=\"muted small\">—</span>' : `<button class=\"btn sm teal\" data-quick-imp", self.admin)

    def test_people_plans_and_emails_open_their_drawers(self):
        self.assertIn("document.addEventListener('click', e => {\n  const u = e.target.closest('[data-open-user]')", self.admin)
        for snippet in ["uLink(r.reporterId", "pLink(r.targetType === 'activity'", "uLink(m.userId, esc(m.toEmail", "uLink(t.userId, person(t.name, t.email))",
                        "uLink(s.userId, person(s.name, s.email))", "uLink(r.userId, person(r.name, r.email))", "uLink(p.hostId, person(p.hostName, p.hostEmail))"]:
            self.assertIn(snippet, self.admin, snippet)

    def test_verifications_lede_wraps_and_summary_counts_submissions_and_nudges(self):
        self.assertIn('<p class="muted lede">', self.admin)
        self.assertRegex(self.admin, r"\.lede\{[^}]*white-space:normal")
        self.assertIn("selfies submitted", self.admin)
        self.assertIn('"verify your profile" emails sent', self.admin)


class BrandSpellings(unittest.TestCase):
    """People search 'tabl amigo', 'table amigo' and 'tablamigo app'. The home page, served as plain HTML, must name them."""
    ALT = ["Tabl Amigo", "Table Amigo", "Tablamigo app"]

    @classmethod
    def setUpClass(cls):
        cls.html = page("index.html")
        cls.graph = []
        for blob in re.findall(r'<script type="application/ld\+json">(.*?)</script>', cls.html, re.S):
            data = json.loads(blob)
            cls.graph += data.get("@graph", [data])

    def test_title_description_h1_and_lead_carry_the_spelling(self):
        self.assertRegex(self.html, r"<title>Tablamigo \(Tabl Amigo\)[^<]*</title>")
        desc = re.search(r'<meta name="description" content="([^"]*)"', self.html).group(1)
        self.assertIn("Tabl Amigo", desc)
        self.assertIn("Table Amigo", desc)
        self.assertLessEqual(len(desc), 155)
        self.assertRegex(self.html, r"<h1>Tablamigo \(Tabl Amigo\)")
        self.assertRegex(self.html, r'<p class="lead">Tablamigo is a solo-travel app[^<]*Tabl Amigo')

    def test_json_ld_declares_the_alternate_names(self):
        for t in ("Organization", "MobileApplication", "WebSite"):
            nodes = [n for n in self.graph if n.get("@type") == t and n.get("name") == "Tablamigo"]
            self.assertTrue(nodes, t)
            for n in nodes:
                alt = n["alternateName"]
                alt = [alt] if isinstance(alt, str) else alt
                for a in self.ALT:
                    self.assertIn(a, alt, f"{t} alternateName")

    def test_faq_answers_tablamigo_or_table_amigo_in_page_and_schema(self):
        self.assertIn("<summary>Is it Tablamigo or Table Amigo?</summary>", self.html)
        qs = [q["name"] for n in self.graph if n.get("@type") == "FAQPage" for q in n["mainEntity"]]
        self.assertIn("Is it Tablamigo or Table Amigo?", qs)

    def test_canonical_robots_and_sitemap_for_home(self):
        self.assertIn(f'<link rel="canonical" href="{SITE}/">', self.html)
        self.assertNotIn("noindex", re.search(r'<meta name="robots" content="([^"]*)"', self.html).group(1))
        locs = [e.text for e in ET.fromstring(page("sitemap.xml")).findall("s:url/s:loc", NS)]
        self.assertIn(f"{SITE}/", locs)
        self.assertFalse([l for l in locs if "index.html" in l])


class FormFieldsNoZoom(unittest.TestCase):
    """The partnerships form's fields are 16px: iOS Safari zooms into smaller ones on focus (live audit 1 Nov: 15px)."""

    def test_form_fields_are_16px(self):
        css = (WEB / "style.css").read_text(encoding="utf-8")
        rule = re.search(r"\.form-field input, \.form-field select, \.form-field textarea \{([^}]*)\}", css)
        self.assertTrue(rule, "form-field rule not found")
        size = float(re.search(r"font-size:\s*([\d.]+)px", rule.group(1)).group(1))
        self.assertGreaterEqual(size, 16)


class AdminOnPhones(unittest.TestCase):
    """The admin panel on a phone (31 Oct 2026): no Safari focus zoom in the filters, tables as labelled cards, not sideways scroll."""

    @classmethod
    def setUpClass(cls):
        cls.admin = page("admin.html")

    def test_fields_are_16px_on_touch_screens(self):
        self.assertIn("@media (pointer:coarse){input,select,textarea{font-size:16px}", self.admin)
        # An inline font (font:inherit = the page's 14px) beats that rule: the Host's plan description and the reply boxes
        # were 14px on phones until 2 Nov 2026. Textareas take the font from the base rule instead.
        self.assertIn("button,input,select,textarea{font:inherit;color:inherit}", self.admin)
        for tag in re.findall(r"<textarea[^>]*>", self.admin):
            self.assertNotRegex(tag, r"font(-size)?:", tag[:60])

    def test_buttons_are_44px_tall_on_touch_screens(self):
        coarse = re.search(r"@media \(pointer:coarse\)\{(.*?)\}\n", self.admin).group(1)
        self.assertIn(".btn,.btn.sm{min-height:44px}", coarse)

    def test_tabs_and_fields_are_44px_tall_on_touch_screens(self):
        # 2 Nov 2026 sweep, part 2: the section tabs were 41px and the filters 36px on a phone.
        coarse = re.search(r"@media \(pointer:coarse\)\{(.*?)\}\n", self.admin).group(1)
        self.assertIn("nav.tabs a,input[type],select,.login .btn{min-height:44px}", coarse)

    def test_tables_stack_into_labelled_cards_under_640px(self):
        phone = self.admin[self.admin.index("@media (max-width:640px){"):]
        self.assertIn("table.stack thead{display:none}", phone)
        self.assertIn("content:attr(data-label)", phone)
        fn = re.search(r"function labelTables\(root\) \{.*?\n\}\n", self.admin, re.S).group(0)
        self.assertIn("thead th", fn)
        self.assertIn("setAttribute('data-label'", fn)
        self.assertIn("new MutationObserver", self.admin[self.admin.index("function labelTables"):])


class SiteHeaderOnTouch(unittest.TestCase):
    """The public header's logo link (34px) and "Get the app" (40px) are 44px on touch screens (2 Nov 2026 sweep)."""

    def test_header_targets_are_44px_on_touch_screens(self):
        css = (WEB / "style.css").read_text(encoding="utf-8")
        rule = re.search(r"@media \(pointer: coarse\) \{(.*?)\}\s*\n", css)
        self.assertTrue(rule, "touch rule not found")
        self.assertIn(".nav .brand { min-height: 44px; }", rule.group(1))
        self.assertIn(".btn.small { height: 44px; }", rule.group(1))
        # Built pages inline the stylesheet.
        self.assertIn(".btn.small{height:44px;}", page("index.html").replace(" ", ""))


class AdminUserSourceFilter(unittest.TestCase):
    """Users > acquisition source (2 Nov 2026): filtered by the API, so the count and the pages are the filtered ones. It used
    to filter one page of 50 in the browser ("1–0 of 26", matches on later pages never shown) and offered "Founder", a source
    sign-up never records, while Meta / Instagram and Reddit were missing."""

    @classmethod
    def setUpClass(cls):
        cls.admin = page("admin.html")

    def test_source_goes_to_the_api(self):
        self.assertIn("qs.set('source', state.source)", self.admin)
        self.assertNotIn("r.users.filter(u => u.attribution?.source", self.admin)

    def test_options_are_the_sources_the_api_knows(self):
        api = (WEB.parent / "api" / "src" / "routes" / "admin.ts").read_text()
        known = re.findall(r"'([^']+)'", re.search(r"ATTRIBUTION_SOURCES = \[(.*?)\]", api).group(1))
        opts = re.search(r"const USER_SOURCES = \[(.*?)\];", self.admin, re.S).group(1)
        values = re.findall(r"\['([^']*)', '[^']*'\]", opts)
        self.assertEqual(values, [""] + known + ["other"])
        self.assertNotIn("Founder / Admin", self.admin)
        self.assertNotIn("'Founder'", self.admin)

    def test_a_source_from_the_link_is_checked_against_the_list(self):
        # An old #users?source=Founder bookmark must fall back to all sources, not send an unknown value (the API answers 400).
        self.assertIn("source: USER_SOURCES.some(([v]) => v === hp.get('source')) ? hp.get('source') : ''", self.admin)


if __name__ == "__main__":
    unittest.main()


class InvitePage(unittest.TestCase):
    """A friend's invite link (API lib/referral.ts inviteLink) lands on /invite?code=…; until 1 Nov 2026 it was /r/<code>, a 404."""

    @classmethod
    def setUpClass(cls):
        cls.html = page("invite.html")
        import sys
        sys.path.insert(0, str(WEB))
        import build
        cls.build = build

    def test_noindex_and_out_of_sitemap_and_llms(self):
        self.assertIn('name="robots" content="noindex, follow"', self.html)
        self.assertNotIn(f"{SITE}/invite", (DIST / "sitemap.xml").read_text())
        for f in ("llms.txt", "llms-full.txt", "llms-guides.txt"):
            if (DIST / f).exists():
                self.assertNotIn(f"{SITE}/invite", (DIST / f).read_text(), f)

    def test_reward_days_come_from_the_constant(self):
        self.assertIn(f"{self.build.INVITE_DAYS} days of Tablamigo Plus", self.html)
        self.assertIn(f"within {self.build.INVITE_REDEEM_DAYS} days of signing up", self.html)
        self.assertNotIn("{{", self.html)

    def test_buttons_and_code_script(self):
        self.assertRegex(self.html, r'id="invite-play"[^>]*href="https://play\.google\.com/store/apps/details\?id=com\.tablamigo\.app&amp;referrer=')
        self.assertIn('id="invite-web" class="btn" href="/app/"', self.html)
        # The script only takes 4-16 letters/digits, so a crafted ?code= can't inject markup or a URL.
        self.assertIn("[?&]code=([A-Za-z0-9]{4,16})(?:&|$)", self.html)
        self.assertIn("ref='+c", self.html)
        self.assertIn("textContent=c", self.html)
