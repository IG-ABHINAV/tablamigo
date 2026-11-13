#!/usr/bin/env python3
"""Tells IndexNow (Bing, Yandex, Seznam, Naver and others) about every URL in the sitemap.

Run it after a deploy:
  python3 apps/web/indexnow.py            # reads the live sitemap, checks the live key file, pings
  python3 apps/web/indexnow.py --dry-run  # shows what would be sent, sends nothing
  python3 apps/web/indexnow.py --local    # uses dist/sitemap.xml instead of the live one

It refuses to ping until https://<site>/<key>.txt is live and returns the key, because IndexNow
rejects (403) submissions whose key file it can't fetch.
"""
import json, pathlib, sys, urllib.request, urllib.error, xml.etree.ElementTree as ET

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from build import SITE, INDEXNOW_KEY, DIST  # noqa: E402

ENDPOINT = "https://api.indexnow.org/indexnow"
HOST = SITE.split("://", 1)[1]
KEY_URL = f"{SITE}/{INDEXNOW_KEY}.txt"
UA = {"User-Agent": "tablamigo-indexnow/1.0"}


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
        return r.read().decode()


def sitemap_urls(local):
    xml = (DIST / "sitemap.xml").read_text() if local else fetch(f"{SITE}/sitemap.xml")
    ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    return [loc.text.strip() for loc in ET.fromstring(xml).findall("s:url/s:loc", ns)]


def main():
    dry, local = "--dry-run" in sys.argv, "--local" in sys.argv
    urls = sitemap_urls(local)
    foreign = [u for u in urls if u.split("/")[2] != HOST]
    if foreign:
        sys.exit(f"sitemap has URLs outside {HOST}: {foreign[:3]}")
    print(f"{len(urls)} URLs from {'dist/' if local else SITE + '/'}sitemap.xml")
    if dry:
        print(json.dumps({"host": HOST, "key": INDEXNOW_KEY, "keyLocation": KEY_URL, "urlList": urls}, indent=1))
        return
    try:
        live_key = fetch(KEY_URL).strip()
    except urllib.error.URLError as e:
        sys.exit(f"key file not reachable at {KEY_URL} ({e}). Deploy first.")
    if live_key != INDEXNOW_KEY:
        sys.exit(f"{KEY_URL} does not contain the key. Deploy first.")
    body = json.dumps({"host": HOST, "key": INDEXNOW_KEY, "keyLocation": KEY_URL, "urlList": urls}).encode()
    req = urllib.request.Request(ENDPOINT, data=body, method="POST",
                                 headers={**UA, "Content-Type": "application/json; charset=utf-8"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            code = r.status
    except urllib.error.HTTPError as e:
        code = e.code
    meaning = {200: "OK, URLs submitted", 202: "Accepted; key validation pending",
               400: "Bad request", 403: "Key not valid (key file missing or wrong)",
               422: "URLs don't belong to the host, or key mismatch", 429: "Too many requests, try later"}
    print(f"IndexNow: HTTP {code} ({meaning.get(code, 'unexpected')})")
    sys.exit(0 if code in (200, 202) else 1)


if __name__ == "__main__":
    main()
