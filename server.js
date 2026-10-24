// Serves the mirrored Framer site in ./site (see scripts/mirror.py) with no dependencies.
//
// Saved files are untouched snapshots of what Framer served. On the way out, text
// responses get the mirrored hosts (MIRRORS below) rewritten to this server, Framer's
// analytics tag is removed and the Framer on-page editor bar is stubbed out.
// URLs stay absolute because Framer's runtime parses them with `new URL()`.

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { handleForm, logFormsSetup, FORMS_API } = require("./forms");

const SITE = path.join(__dirname, "site");
const PAGES = path.join(SITE, "pages");
const PORT = Number(process.env.PORT) || 3000;
// Set to e.g. https://eventsheet.com to pin asset URLs; otherwise the request host is used.
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || "").replace(/\/+$/, "");

// Mirrored URL prefix -> local path under site/. Keep in sync with MIRRORS in scripts/mirror.py.
const MIRRORS = {
  "https://framerusercontent.com": "/_fuc",
  "https://fonts.gstatic.com": "/_gfonts",
  "https://public.rive.app": "/_rive",
  "https://unpkg.com": "/_unpkg",
  "https://framer.com/m/": "/_framer/m/", // Framer icon library modules
};
const ASSET_PREFIXES = Object.values(MIRRORS).map((p) => p.replace(/\/?$/, "/"));
// Framer CMS data files are binary with fixed offsets, so asset URLs inside them can't be
// rewritten on disk. Instead the CMS reader's readString() is patched to rewrite each
// decoded string.
const CMS_READ_STRING =
  /(readString\(\)\{let \w+=this\.readUint32\(\),(\w+)=this\.read(?:Bytes|Buffer)\(\w+\);return this\.decoder\.decode\(\2\))\}/g;
// Framer's on-page editor bar loads for every visitor and only works on Framer hosting.
const EDITOR_BAR_IMPORT = "import(`https://framer.com/edit/init.mjs`)";
const EDITOR_BAR_STUB = "Promise.resolve({createEditorBar:()=>()=>null})";
const IMAGE_VARIANT_PARAMS = ["scale-down-to", "lossless"];
const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "public, max-age=0, must-revalidate";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".wasm": "application/wasm",
  ".riv": "application/octet-stream",
  ".framercms": "application/octet-stream",
  ".csv": "text/csv; charset=utf-8",
};
const REWRITE_EXT = new Set([".html", ".mjs", ".js", ".json", ".css", ".svg"]);
const COMPRESS_EXT = new Set([...REWRITE_EXT, ".xml", ".txt", ".csv"]);

// Route path -> page file, built once from site/pages.
const routes = new Map();
(function indexPages(dir, prefix) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) indexPages(full, `${prefix}/${entry.name}`);
    else if (entry.name.endsWith(".html") && !entry.name.startsWith("_")) {
      const name = entry.name.slice(0, -".html".length);
      routes.set(name === "index" && prefix === "" ? "/" : `${prefix}/${name}`, full);
    }
  }
})(PAGES, "");
const NOT_FOUND_PAGE = path.join(PAGES, "_not-found.html");

function originFor(req) {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (!HOST_RE.test(host)) return null;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

function rewrite(text, origin, ext) {
  for (const [from, to] of Object.entries(MIRRORS)) text = text.replaceAll(from, origin + to);
  text = text.replaceAll(EDITOR_BAR_IMPORT, EDITOR_BAR_STUB);
  // Framer forms post here instead of to Framer (see forms.js).
  text = text.replaceAll(FORMS_API, `${origin}/_forms/`);
  if (ext === ".mjs" || ext === ".js") {
    // Split so the host rewrite above can't touch the search string.
    const search = JSON.stringify("https://framerusercontent" + ".com/");
    const target = JSON.stringify(`${origin}/_fuc/`);
    text = text.replace(CMS_READ_STRING, (_, decode) => `${decode}.replaceAll(${search},${target})}`);
  }
  if (ext === ".html") {
    // Framer's analytics beacon only reports to Framer, so drop it off-platform.
    text = text.replace(/<script[^>]*src="https:\/\/events\.framer\.com\/[^"]*"[^>]*><\/script>\s*/g, "");
  }
  return text;
}

// Rendered (rewritten + compressed) text bodies, keyed by origin then file.
// Only a few origins are cached so an arbitrary Host header can't grow memory.
const renderCache = new Map();
const MAX_CACHED_ORIGINS = 4;

function render(file, ext, origin) {
  let byFile = renderCache.get(origin);
  if (byFile && byFile.has(file)) return byFile.get(file);
  const raw = fs.readFileSync(file);
  const body = REWRITE_EXT.has(ext) ? Buffer.from(rewrite(raw.toString("utf8"), origin, ext)) : raw;
  const entry = {
    body,
    etag: `"${crypto.createHash("sha1").update(body).digest("base64url").slice(0, 27)}"`,
    br: null,
    gzip: null,
  };
  if (!byFile) {
    if (renderCache.size >= MAX_CACHED_ORIGINS) return entry;
    byFile = new Map();
    renderCache.set(origin, byFile);
  }
  byFile.set(file, entry);
  return entry;
}

function encodedBody(entry, req) {
  const accept = String(req.headers["accept-encoding"] || "");
  if (entry.body.length < 1024) return [entry.body, null];
  if (/\bbr\b/.test(accept)) {
    entry.br ||= zlib.brotliCompressSync(entry.body, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: entry.body.length },
    });
    return [entry.br, "br"];
  }
  if (/\bgzip\b/.test(accept)) {
    entry.gzip ||= zlib.gzipSync(entry.body, { level: 9 });
    return [entry.gzip, "gzip"];
  }
  return [entry.body, null];
}

function sendText(req, res, status, file, ext, origin, headers) {
  const entry = render(file, ext, origin);
  const common = { ...headers, ETag: entry.etag, Vary: "Accept-Encoding", "Content-Type": TYPES[ext] };
  if (req.headers["if-none-match"] === entry.etag && status === 200) {
    res.writeHead(304, common);
    return res.end();
  }
  const [body, encoding] = encodedBody(entry, req);
  if (encoding) common["Content-Encoding"] = encoding;
  res.writeHead(status, { ...common, "Content-Length": body.length });
  res.end(req.method === "HEAD" ? undefined : body);
}

function sendFile(req, res, file, type, headers) {
  const stat = fs.statSync(file);
  const etag = `"${stat.size.toString(36)}-${stat.mtimeMs.toString(36)}"`;
  const common = { ...headers, ETag: etag, "Accept-Ranges": "bytes", "Content-Type": type };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, common);
    return res.end();
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, stat.size - 1);
    if (start > end) {
      res.writeHead(416, { ...common, "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { ...common, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...common, "Content-Length": stat.size });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Resolve a mirrored asset path (e.g. /_fuc/...) to a file inside site/, refusing traversal.
function assetFile(pathname) {
  const file = path.normalize(path.join(SITE, pathname));
  return file.startsWith(SITE + path.sep) ? file : null;
}

function serveAsset(req, res, pathname, params, origin) {
  const base = assetFile(pathname);
  if (!base) return notFound(req, res, origin);
  const headers = { "Cache-Control": IMMUTABLE, "Access-Control-Allow-Origin": "*" };
  // Icon modules are named like XCircle.js@0.0.28.
  const ext = pathname.startsWith("/_framer/m/") ? ".js" : path.extname(pathname).toLowerCase();

  if (pathname.startsWith("/_fuc/images/")) {
    // Same variant naming as scripts/mirror.py; fall back to the full-size original.
    const parts = IMAGE_VARIANT_PARAMS.filter((k) => params.has(k)).map((k) => `${k}-${params.get(k)}`);
    const variant = parts.length ? `${base}.v-${parts.join(",")}` : base;
    const file = isFile(variant) ? variant : base;
    if (!isFile(file)) return notFound(req, res, origin);
    headers.Vary = "Accept";
    if (/image\/webp/.test(String(req.headers.accept || "")) && isFile(`${file}.webp`)) {
      return sendFile(req, res, `${file}.webp`, "image/webp", headers);
    }
    if (ext === ".svg") return sendText(req, res, 200, file, ext, origin, headers);
    return sendFile(req, res, file, TYPES[ext] || "application/octet-stream", headers);
  }

  if (!isFile(base)) return notFound(req, res, origin);
  if (ext === ".framercms" && params.has("range")) return sendCmsRanges(req, res, base, params.get("range"), headers);
  if (REWRITE_EXT.has(ext) || COMPRESS_EXT.has(ext)) return sendText(req, res, 200, base, ext, origin, headers);
  return sendFile(req, res, base, TYPES[ext] || "application/octet-stream", headers);
}

// Framer's CMS client fetches `?range=a-b,c-d` (inclusive byte ranges) and expects the
// slices concatenated in a 200 response.
const cmsFiles = new Map();
function sendCmsRanges(req, res, file, spec, headers) {
  let data = cmsFiles.get(file);
  if (!data) cmsFiles.set(file, (data = fs.readFileSync(file)));
  const parts = spec.split(",");
  const slices = [];
  for (const part of parts) {
    const m = /^(\d+)-(\d+)$/.exec(part);
    const start = m && Number(m[1]);
    const end = m && Number(m[2]);
    if (!m || parts.length > 1000 || start > end || end >= data.length) {
      res.writeHead(416, headers);
      return res.end();
    }
    slices.push(data.subarray(start, end + 1));
  }
  const body = Buffer.concat(slices);
  res.writeHead(200, { ...headers, "Content-Type": TYPES[".framercms"], "Content-Length": body.length });
  res.end(req.method === "HEAD" ? undefined : body);
}

function notFound(req, res, origin) {
  sendText(req, res, 404, NOT_FOUND_PAGE, ".html", origin, { "Cache-Control": REVALIDATE });
}

const server = http.createServer((req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Strict-Transport-Security", "max-age=31536000");
  const form = /^\/_forms\/([0-9a-f-]{36})\/submit$/.exec(req.url.split("?")[0]);
  if (form) {
    return handleForm(req, res, form[1]).catch((err) => {
      console.error("[forms]", err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    return res.end();
  }
  const origin = originFor(req);
  if (!origin) {
    res.writeHead(400);
    return res.end("Bad Host header");
  }

  let url, pathname;
  try {
    url = new URL(req.url, "http://localhost");
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }

  try {
    if (ASSET_PREFIXES.some((p) => pathname.startsWith(p))) return serveAsset(req, res, pathname, url.searchParams, origin);
    if (pathname === "/robots.txt" || pathname === "/sitemap.xml") {
      return sendText(req, res, 200, path.join(PAGES, pathname), path.extname(pathname), origin, { "Cache-Control": REVALIDATE });
    }
    // Framer redirects trailing slashes with a 308 and keeps the query string.
    if (pathname.length > 1 && pathname.endsWith("/")) {
      res.writeHead(308, { Location: encodeURI(pathname.replace(/\/+$/, "")) + url.search });
      return res.end();
    }
    const page = routes.get(pathname);
    if (page) return sendText(req, res, 200, page, ".html", origin, { "Cache-Control": REVALIDATE });
    return notFound(req, res, origin);
  } catch (err) {
    console.error(req.url, err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Serving ${routes.size} pages on :${PORT}`);
  logFormsSetup();
});
