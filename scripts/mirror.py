#!/usr/bin/env python3
"""Mirror the published Framer site into ./site so it can be served without Framer.

What it saves:
  site/pages/<route>.html   rendered HTML for every route (sitemap + crawled links)
  site/_fuc/<path>          everything from framerusercontent.com (JS, images, fonts, video, CMS data)
  site/_gfonts/<path>       Google font files from fonts.gstatic.com
  site/_rive/<path>         Rive animation files from public.rive.app
  site/_unpkg/<path>        the Rive player runtime (rive.wasm) from unpkg.com
  site/_framer/m/<path>     Framer icon library modules (framer.com/m/...)

Files are saved byte-for-byte. server.js rewrites these hosts to the local
copies when it serves them, so the saved files stay a faithful snapshot.

Image variants: Framer resizes images by the `scale-down-to` (and `lossless`)
query params and converts to WebP when the browser accepts it. Each variant is
saved as `<path>.v-<variant>` and the WebP version as `<file>.webp`; server.js
picks the right one per request.

Usage:
  python3 scripts/mirror.py                      # full mirror
  python3 scripts/mirror.py --extra-urls f.txt   # also fetch URLs listed in f.txt (e.g. from a browser pass)

Pages are always re-fetched; assets already on disk are skipped unless --refresh.
"""

import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import re
import sys
import threading
import time
import xml.etree.ElementTree as ET
from html import unescape
from urllib.parse import urljoin, urlsplit, parse_qsl

import requests

ORIGIN = "https://eventsheet.com"
FUC = "framerusercontent.com"
# URL prefix -> local directory under site/. Keep in sync with MIRRORS in server.js.
MIRRORS = {
    "https://framerusercontent.com/": "_fuc/",
    "https://fonts.gstatic.com/": "_gfonts/",
    "https://public.rive.app/": "_rive/",
    "https://unpkg.com/": "_unpkg/",
    "https://framer.com/m/": "_framer/m/",
}
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)
WEBP_ACCEPT = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
IMAGE_VARIANT_PARAMS = ("scale-down-to", "lossless")
TEXT_EXT = (".mjs", ".js", ".json", ".css", ".svg", ".html", ".txt", ".xml")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")

ABS_URL_RE = re.compile(
    "(?:" + "|".join(re.escape(p) for p in MIRRORS) + r")[^\s\"'`<>()\\,{}|^$]+"
)
REL_MODULE_RE = re.compile(r"[\"'`](\.\.?/[A-Za-z0-9_@.\-/]+\.(?:mjs|js|json))[\"'`]")
HREF_RE = re.compile(r"href=\"([^\"#]*)\"")

lock = threading.Lock()
session = requests.Session()
session.headers["User-Agent"] = UA
adapter = requests.adapters.HTTPAdapter(pool_connections=32, pool_maxsize=32, max_retries=3)
session.mount("https://", adapter)


def log(*a):
    with lock:
        print(*a, flush=True)


def get(url, accept="*/*"):
    for attempt in range(4):
        try:
            r = session.get(url, headers={"Accept": accept}, timeout=60)
            if r.status_code >= 500:
                raise requests.HTTPError(f"{r.status_code}")
            return r
        except requests.RequestException as e:
            if attempt == 3:
                raise
            time.sleep(2 ** (attempt + 1))
            log(f"  retry {url}: {e}")


def route_file(route):
    route = route.rstrip("/") or "/"
    if route == "/":
        return os.path.join(SITE, "pages", "index.html")
    return os.path.join(SITE, "pages", route.lstrip("/") + ".html")


def variant_suffix(query):
    params = dict(parse_qsl(query))
    parts = [f"{k}={params[k]}" for k in IMAGE_VARIANT_PARAMS if k in params]
    return ("." + "v-" + ",".join(parts).replace("=", "-")) if parts else ""


def asset_path(url):
    """Local file path (without .webp) for a mirrored URL."""
    u = urlsplit(url)
    path = u.path
    if path.endswith("/") or not path:
        return None
    full = f"https://{u.netloc}{path}"
    prefix = next((p for p in MIRRORS if full.startswith(p)), None)
    if not prefix:
        return None
    local = os.path.join(SITE, MIRRORS[prefix], full[len(prefix):])
    if u.netloc == FUC and path.startswith("/images/"):
        local += variant_suffix(u.query)
    return local


def asset_key(url):
    u = urlsplit(url)
    if u.netloc == FUC and u.path.startswith("/images/"):
        params = dict(parse_qsl(u.query))
        q = "&".join(f"{k}={params[k]}" for k in IMAGE_VARIANT_PARAMS if k in params)
        return f"https://{u.netloc}{u.path}" + (f"?{q}" if q else "")
    return f"https://{u.netloc}{u.path}"


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def extract_refs(text, base_url):
    refs = set()
    for m in ABS_URL_RE.finditer(unescape(text)):
        refs.add(m.group(0).rstrip(".;:"))
    if urlsplit(base_url).netloc == FUC:
        for m in REL_MODULE_RE.finditer(text):
            refs.add(urljoin(base_url, m.group(1)))
    # Bundled module ids like ../node_modules/x/index.js look like paths but are never fetched.
    return {r for r in refs if "/node_modules/" not in r}


class Mirror:
    def __init__(self, workers, refresh):
        self.workers = workers
        self.refresh = refresh
        self.seen_assets = set()
        self.failed = []
        self.missing = []  # 404 upstream too, so the live site is missing them as well
        self.stats = {"pages": 0, "assets": 0, "bytes": 0}

    # ---------- pages ----------
    def sitemap_routes(self):
        r = get(ORIGIN + "/sitemap.xml")
        write(os.path.join(SITE, "pages", "sitemap.xml"), r.content)
        tree = ET.fromstring(r.content)
        ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        return [urlsplit(loc.text.strip()).path or "/" for loc in tree.findall(".//s:loc", ns)]

    def crawl_pages(self):
        r = get(ORIGIN + "/robots.txt")
        write(os.path.join(SITE, "pages", "robots.txt"), r.content)

        todo = list(dict.fromkeys(self.sitemap_routes()))
        seen = set(todo)
        refs = set()
        while todo:
            batch, todo = todo, []
            with cf.ThreadPoolExecutor(self.workers) as ex:
                for route, html, links in ex.map(self.fetch_page, batch):
                    if html is None:
                        continue
                    refs |= extract_refs(html, ORIGIN + route)
                    for link in links:
                        if link not in seen:
                            seen.add(link)
                            todo.append(link)

        # The not-found page Framer serves for unknown paths (status 404).
        r = get(ORIGIN + "/__mirror-not-found__", accept="text/html")
        write(os.path.join(SITE, "pages", "_not-found.html"), r.content)
        refs |= extract_refs(r.text, ORIGIN)
        return sorted(seen), refs

    def fetch_page(self, route):
        url = ORIGIN + route
        r = get(url, accept="text/html,application/xhtml+xml")
        if r.status_code != 200 or "text/html" not in r.headers.get("content-type", ""):
            log(f"  skip page {route}: {r.status_code} {r.headers.get('content-type')}")
            if r.status_code != 404:
                self.failed.append((url, r.status_code))
            return route, None, []
        final = urlsplit(r.url)
        if final.netloc != urlsplit(ORIGIN).netloc or (final.path.rstrip("/") or "/") != (route.rstrip("/") or "/"):
            log(f"  redirect {route} -> {r.url}")
        write(route_file(route), r.content)
        self.stats["pages"] += 1
        links = set()
        for href in HREF_RE.findall(r.text):
            href = unescape(href)
            full = urljoin(url, href)
            u = urlsplit(full)
            if u.scheme in ("http", "https") and u.netloc == urlsplit(ORIGIN).netloc:
                links.add(u.path.rstrip("/") or "/")
        log(f"page {route}")
        return route, r.text, links

    # ---------- assets ----------
    def crawl_assets(self, refs):
        todo = set(refs)
        while todo:
            batch = []
            for url in todo:
                key = asset_key(url)
                if key not in self.seen_assets:
                    self.seen_assets.add(key)
                    batch.append(key)
            todo = set()
            with cf.ThreadPoolExecutor(self.workers) as ex:
                for found in ex.map(self.fetch_asset, batch):
                    todo |= found

    def fetch_asset(self, url):
        local = asset_path(url)
        if not local:
            return set()
        u = urlsplit(url)
        is_image = u.netloc == FUC and u.path.startswith("/images/")
        try:
            if os.path.exists(local) and not self.refresh:
                # Framer asset URLs are content-hashed, so a saved copy never goes stale.
                with open(local, "rb") as f:
                    data = f.read()
            else:
                r = get(url)
                if r.status_code == 404:
                    log(f"  missing upstream {url}")
                    self.missing.append(url)
                    return set()
                if r.status_code != 200:
                    log(f"  FAIL {r.status_code} {url}")
                    self.failed.append((url, r.status_code))
                    return set()
                data = r.content
                write(local, data)
                self.stats["assets"] += 1
                self.stats["bytes"] += len(data)
                if is_image:
                    self.fetch_webp(url, local, data)
        except requests.RequestException as e:
            log(f"  ERROR {url}: {e}")
            self.failed.append((url, str(e)))
            return set()

        # Icon modules are named like XCircle.js@0.0.28.
        if u.path.endswith(TEXT_EXT) or ".js@" in u.path:
            try:
                return extract_refs(data.decode("utf-8"), url)
            except UnicodeDecodeError:
                return set()
        return set()

    def fetch_webp(self, url, local, original):
        r = get(url, accept=WEBP_ACCEPT)
        if r.status_code != 200:
            return
        ctype = r.headers.get("content-type", "")
        if ctype.startswith("image/webp") and r.content != original:
            write(local + ".webp", r.content)
            self.stats["bytes"] += len(r.content)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--extra-urls", help="file with extra asset URLs (one per line)")
    ap.add_argument("--assets-only", action="store_true", help="skip page crawl, only fetch --extra-urls")
    ap.add_argument("--refresh", action="store_true", help="re-download assets that are already saved")
    args = ap.parse_args()

    m = Mirror(args.workers, args.refresh)
    refs = set()
    if not args.assets_only:
        routes, refs = m.crawl_pages()
        write(os.path.join(SITE, "routes.json"), json.dumps(routes, indent=1).encode())
        log(f"{len(routes)} routes")
    if args.extra_urls:
        with open(args.extra_urls) as f:
            refs |= {line.strip() for line in f if line.strip()}
    m.crawl_assets(refs)

    log(f"done: {m.stats}")
    for url in m.missing:
        log(f"  404 on the live site too (not mirrored): {url}")
    if m.failed:
        log(f"{len(m.failed)} failures:")
        for url, why in m.failed:
            log(f"  {why} {url}")
        sys.exit(1)


if __name__ == "__main__":
    main()
