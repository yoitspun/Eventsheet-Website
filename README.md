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
| `forms.js` | Receives the Framer forms and emails submissions |
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
| `RESEND_API_KEY` | | Resend API key for form emails |
| `MAIL_FROM` | | Sender on a domain verified in Resend, e.g. `Eventsheet <forms@eventsheet.com>` |
| `FORMS_TO` | `pun@eventsheet.com` | Where form submissions are emailed |
| `RECAPTCHA_SECRET` | | Optional reCAPTCHA secret to verify form tokens server-side |

## Forms

The two native Framer forms post to this server instead of Framer
(`/_forms/<id>/submit`, handled by `forms.js`), and each submission is emailed to
`FORMS_TO` through [Resend](https://resend.com). Replying to the email replies to
the visitor.

| Framer form id | Form | Where |
| --- | --- | --- |
| `55f4c20d-354d-41c9-bdb2-3fea0a28ecae` | Contact form | `/contact-us`, `/partners/50pros`, `/partners/ticketsauce` |
| `e6090b99-df84-4f99-9297-b430550f320f` | Blog signup form | blog posts |

Spam protection: Framer's proof-of-work token is checked (and can't be reused),
each IP can send 5 forms per 10 minutes, and the site's reCAPTCHA must be solved in
the browser. Setting `RECAPTCHA_SECRET` also verifies the reCAPTCHA token with Google.

The reCAPTCHA keys only allow eventsheet.com, so the forms can't be submitted from
the railway.app address or localhost until the domain moves (or those domains are
added to the keys in the reCAPTCHA admin).

Without `RESEND_API_KEY` and `MAIL_FROM`, submissions are written to the server log
instead of emailed, so nothing is lost.

The two HubSpot embedded forms (portal `44731152`, on `/ad/music-artists` and
`/events/pollstarlive25`) load from HubSpot and keep working as they are.

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
