# eventsheet.com

A complete, self-hosted copy of the eventsheet.com Framer site, served by a small
dependency-free Node server so it can run on Railway (or anywhere Node 22 runs).

Every page, script, image, font, video and Rive animation is stored in `site/`.
Nothing is loaded from Framer when the site runs.

## Run locally

```sh
npm start            # http://localhost:3000
PORT=8080 npm start
```

## Layout

| Path | What it is |
| --- | --- |
| `site/pages/` | Rendered HTML for each route (`/blog/foo` → `blog/foo.html`), plus `robots.txt`, `sitemap.xml` and `_not-found.html` |
| `site/_fuc/` | Everything from `framerusercontent.com`: site JS, images (with resized and WebP variants), fonts, videos, downloads |
| `site/_gfonts/` | Google font files |
| `site/_rive/`, `site/_unpkg/` | Rive animation files and the Rive player runtime |
| `site/_framer/m/` | Framer icon library modules (Hero and Phosphor icons) |
| `server.js` | The web server |
| `scripts/mirror.py` | Re-downloads the site from eventsheet.com while it is still on Framer |
| `scripts/browser-check.mjs` | Loads every page in Chromium to find runtime assets and to verify the copy |
| `scripts/compare-shots.py` | Pixel-compares live vs local screenshots |

The saved files are untouched copies of what Framer served. `server.js` rewrites
the Framer, Google Fonts, Rive and icon URLs to the local copies when it serves a
response, drops Framer's analytics beacon and stubs out the Framer on-page editor
bar. It also reproduces Framer's behaviour for trailing slashes (308 redirect), the
404 page, image resizing (`?scale-down-to=`), WebP negotiation, video range
requests and CMS data requests (`.framercms?range=`).

CMS collections (blog, docs, updates, use cases, industries) are binary
`.framercms` files read by byte offset, so they can't be edited on disk. The image
URLs inside them are rewritten as Framer's CMS reader decodes each string (see
`CMS_READ_STRING` in `server.js`).

## Hosting

Railway project `eventsheet-website`, service `website`, deploys this branch on
every push and runs `node server.js` (see `railway.json`). It is reachable at
https://website-production-b094.up.railway.app until eventsheet.com is pointed at it.

To move the domain: add `eventsheet.com` (and `www`) as custom domains on the
service in Railway, create the DNS records Railway shows, then unpublish the Framer
site. Page canonical URLs already point at https://eventsheet.com.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on (Railway sets this) |
| `PUBLIC_ORIGIN` | request host | Pin the origin used in rewritten asset URLs, e.g. `https://eventsheet.com` |

## Forms

Two forms are native Framer forms that post to `api.framer.com` and need a new
backend once the Framer site is gone:

| Framer form id | Where |
| --- | --- |
| `55f4c20d-354d-41c9-bdb2-3fea0a28ecae` | `/contact-us`, `/partners/50pros`, `/partners/ticketsauce` |
| `e6090b99-df84-4f99-9297-b430550f320f` | the form on blog posts |

The two HubSpot embedded forms (portal `44731152`) load from HubSpot and keep
working as they are.

## Refreshing the copy

While the Framer site is still live, changes made in Framer can be pulled in again:

```sh
python3 scripts/mirror.py                                    # pages + everything they reference
node scripts/browser-check.mjs live --base https://eventsheet.com --out .check/live
python3 scripts/mirror.py --assets-only --extra-urls .check/live/urls.txt
npm start &
node scripts/browser-check.mjs local --base http://localhost:3000 --out .check/local
python3 scripts/compare-shots.py .check/live/shots .check/local/shots --diff-dir .check/diff
```

`browser-check.mjs local` blocks every Framer host and lists any request that still
tried to reach one in `.check/local/report.json` (`leaks` should be empty).
