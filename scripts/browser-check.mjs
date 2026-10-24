// Loads every route in Chromium at desktop/tablet/phone sizes, scrolls the whole page,
// and records what the browser fetched.
//
//   live mode:  node scripts/browser-check.mjs live  --base https://eventsheet.com --out <dir>
//     Writes <dir>/urls.txt (every URL requested from a mirrored host, to feed
//     back into `mirror.py --extra-urls`) plus screenshots.
//   local mode: node scripts/browser-check.mjs local --base http://localhost:3000 --out <dir>
//     Blocks Framer and mirrored hosts and reports any request that tried to reach them,
//     any failing local request, and page errors. Writes screenshots and report.json.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const [mode, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.join(" ").split("--").filter(Boolean).map((s) => s.trim().split(/\s+/)));
const BASE = (opt.base || "").replace(/\/+$/, "");
const OUT = opt.out;
const CONCURRENCY = Number(opt.concurrency || 6);
const ONLY = opt.routes ? opt.routes.split(",") : null;
if (!["live", "local"].includes(mode) || !BASE || !OUT) {
  console.error("usage: browser-check.mjs live|local --base <url> --out <dir> [--concurrency n] [--routes /a,/b]");
  process.exit(2);
}

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const routes = (ONLY || JSON.parse(fs.readFileSync(path.join(ROOT, "site/routes.json"), "utf8"))).filter(
  (r) => r !== "/404" && !r.includes(":"),
);
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, dpr: 2 },
  { name: "tablet", width: 810, height: 1080, dpr: 2 },
  { name: "phone", width: 390, height: 844, dpr: 3, mobile: true },
];
const MIRRORED_HOSTS = ["framerusercontent.com", "fonts.gstatic.com", "public.rive.app", "unpkg.com"];
const MIRRORED_PREFIXES = ["https://framer.com/m/"];
// In local mode these must never be contacted: everything they served is mirrored.
const FRAMER_HOSTS = [
  ...MIRRORED_HOSTS,
  "framer.com",
  "www.framer.com",
  "events.framer.com",
  "api.framer.com",
  "app.framerstatic.com",
];

fs.mkdirSync(path.join(OUT, "shots"), { recursive: true });
const assetUrls = new Set();
const report = { leaks: [], failures: [], errors: [], hosts: {} };

async function autoScroll(page) {
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.7);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  });
}

async function visit(context, vp, route) {
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push({ route, vp: vp.name, error: String(e).slice(0, 300) }));
  try {
    await page.goto(BASE + route, { waitUntil: "load", timeout: 60000 });
    await autoScroll(page);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    const slug = (route === "/" ? "index" : route.slice(1).replaceAll("/", "__")) + `.${vp.name}.jpg`;
    await page.screenshot({ path: path.join(OUT, "shots", slug), fullPage: true, scale: "css", type: "jpeg", quality: 85 });
  } catch (e) {
    report.errors.push({ route, vp: vp.name, error: `visit: ${String(e).slice(0, 300)}` });
  } finally {
    await page.close();
  }
}

async function runViewport(browser, vp) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    isMobile: !!vp.mobile,
    hasTouch: !!vp.mobile,
    reducedMotion: "reduce",
  });
  if (mode === "local") {
    await context.route("**/*", (r) => {
      const host = new URL(r.request().url()).hostname;
      // Third-party embeds (reCAPTCHA, YouTube) load their own fonts; only check our own frames.
      const fromOwnFrame = (r.request().frame()?.url() || BASE).startsWith(BASE);
      if (FRAMER_HOSTS.includes(host) && fromOwnFrame) {
        report.leaks.push({ vp: vp.name, url: r.request().url(), from: r.request().frame()?.url() });
        return r.abort();
      }
      return r.continue();
    });
  }
  context.on("request", (req) => {
    const u = new URL(req.url());
    report.hosts[u.hostname] = (report.hosts[u.hostname] || 0) + 1;
    const mirrored = MIRRORED_HOSTS.includes(u.hostname) || MIRRORED_PREFIXES.some((p) => req.url().startsWith(p));
    if (mode === "live" && mirrored) assetUrls.add(req.url());
  });
  context.on("response", (res) => {
    if (mode === "local" && res.url().startsWith(BASE) && res.status() >= 400) {
      report.failures.push({ vp: vp.name, status: res.status(), url: res.url(), from: res.frame()?.url() });
    }
  });

  const queue = [...routes];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) await visit(context, vp, queue.shift());
    }),
  );
  await context.close();
  console.log(`${vp.name}: ${routes.length} routes done`);
}

const browser = await chromium.launch();
for (const vp of VIEWPORTS) await runViewport(browser, vp);
await browser.close();

if (mode === "live") fs.writeFileSync(path.join(OUT, "urls.txt"), [...assetUrls].sort().join("\n") + "\n");
const dedupe = (list) => [...new Map(list.map((x) => [JSON.stringify([x.url, x.status, x.error]), x])).values()];
report.leaks = dedupe(report.leaks);
report.failures = dedupe(report.failures);
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
console.log(
  JSON.stringify(
    { mode, assetUrls: assetUrls.size, leaks: report.leaks.length, failures: report.failures.length, errors: report.errors.length, hosts: report.hosts },
    null,
    1,
  ),
);
