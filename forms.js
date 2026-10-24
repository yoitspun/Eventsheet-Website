// Receives the site's Framer forms and emails each submission through Resend.
//
// server.js rewrites the forms' Framer endpoint (api.framer.com/forms/v1/forms/<id>/submit)
// to /_forms/<id>/submit on this server. Framer's form code posts multipart form data with
// a proof-of-work token in the Framer-POW header, which is checked here the way Framer does.
//
// Settings:
//   RESEND_API_KEY    Resend API key
//   MAIL_FROM         sender on a domain verified in Resend, e.g. "Eventsheet <forms@eventsheet.com>"
//   FORMS_TO          where submissions go (default pun@eventsheet.com)
//   RECAPTCHA_SECRET  optional; when set, the reCAPTCHA token on the form is verified with Google
// Without RESEND_API_KEY and MAIL_FROM, submissions are written to the server log instead.

const crypto = require("crypto");

const FORMS = {
  "55f4c20d-354d-41c9-bdb2-3fea0a28ecae": "Contact form",
  "e6090b99-df84-4f99-9297-b430550f320f": "Blog signup form",
};

// A setting as typed into a host's dashboard: surrounding spaces and quotes are not part of it.
const setting = (v) => (typeof v === "string" ? v.trim().replace(/^(["'])(.*)\1$/, "$2").trim() : "");
const RESEND_API_KEY = setting(process.env.RESEND_API_KEY);
const MAIL_FROM = setting(process.env.MAIL_FROM);
const FORMS_TO = setting(process.env.FORMS_TO) || "pun@eventsheet.com";
const RECAPTCHA_SECRET = setting(process.env.RECAPTCHA_SECRET);
const EMAIL_ENABLED = !!(RESEND_API_KEY && MAIL_FROM);

const MAX_BODY = 64 * 1024;
const MAX_FIELDS = 50;
const MAX_VALUE = 5000;
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
// Framer-internal and reCAPTCHA fields that are not part of the message.
const HIDDEN_FIELD = (name) => name.startsWith("__framer") || name === "g-recaptcha-response";

// Framer's client finds "<ms>:<30 chars>" such that sha256("framer" + it) starts with "000".
const POW_RE = /^(\d{13}):[A-Za-z0-9]{30}$/;
const POW_MAX_AGE_MS = 15 * 60 * 1000;
const usedPow = new Map();

function validPow(secret) {
  const m = POW_RE.exec(secret);
  if (!m) return false;
  const age = Date.now() - Number(m[1]);
  if (age < -60 * 1000 || age > POW_MAX_AGE_MS) return false;
  if (!crypto.createHash("sha256").update(`framer${secret}`).digest("hex").startsWith("000")) return false;
  const now = Date.now();
  for (const [s, expires] of usedPow) if (expires < now) usedPow.delete(s);
  if (usedPow.has(secret)) return false;
  usedPow.set(secret, now + POW_MAX_AGE_MS);
  return true;
}

// At most 5 submissions per IP per 10 minutes.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const recent = new Map();

function rateLimited(ip) {
  const now = Date.now();
  for (const [k, times] of recent) if (times[times.length - 1] < now - RATE_WINDOW_MS) recent.delete(k);
  const times = (recent.get(ip) || []).filter((t) => t > now - RATE_WINDOW_MS);
  times.push(now);
  recent.set(ip, times);
  return times.length > RATE_MAX;
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return String(req.headers["x-real-ip"] || "").trim() || forwarded || req.socket.remoteAddress || "";
}

function reply(res, status, message) {
  const body = JSON.stringify(status < 400 ? { success: true } : { error: { message } });
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
}

// Keeps reading past the limit (without buffering) so the 413 reply reaches the client.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on("end", () =>
      size > MAX_BODY ? reject(Object.assign(new Error("Form is too large"), { status: 413 })) : resolve(Buffer.concat(chunks)),
    );
    req.on("error", reject);
  });
}

// Field names in the order the form shows them (Framer sends them in Framer-Form-Fields).
function fieldOrder(header, data) {
  let order = [];
  try {
    order = String(header || "").split(",").filter(Boolean).map(decodeURIComponent);
  } catch {}
  return [...new Set([...order, ...data.keys()])].filter((name) => data.has(name) && !HIDDEN_FIELD(name));
}

async function verifyRecaptcha(token, ip) {
  if (!RECAPTCHA_SECRET) return true;
  if (!token) return false;
  const res = await fetch("https://www.google.com/recaptcha/api/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret: RECAPTCHA_SECRET, response: token, remoteip: ip }),
  });
  return res.ok && (await res.json()).success === true;
}

function composeEmail(formName, fields, page) {
  const get = (re) => fields.find(([name]) => re.test(name))?.[1] || "";
  const who = [get(/^first\s*name$/i), get(/^last\s*name$/i)].filter(Boolean).join(" ") || get(/e-?mail/i);
  const email = get(/e-?mail/i);
  const subject = `${formName}${who ? `: ${who}` : ""}`.replace(/[\r\n]+/g, " ").slice(0, 200);
  const lines = fields.map(([name, value]) => (value.includes("\n") ? `${name}:\n${value}\n` : `${name}: ${value}`));
  const text = [
    `New ${formName.toLowerCase()} submission on the Eventsheet website.`,
    "",
    ...lines,
    "",
    `Page: ${page || "unknown"}`,
    `Sent: ${new Date().toISOString()}`,
  ].join("\n");
  return { subject, text, replyTo: EMAIL_RE.test(email) ? email : null };
}

async function sendEmail({ subject, text, replyTo }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: MAIL_FROM, to: [FORMS_TO], subject, text, ...(replyTo && { reply_to: replyTo }) }),
  });
  if (!res.ok) throw new Error(`Resend responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function handleForm(req, res, formId) {
  const formName = FORMS[formId];
  if (!formName) return reply(res, 404, "Unknown form");
  if (req.method !== "POST") return reply(res, 405, "Method not allowed");

  if (Number(req.headers["content-length"]) > MAX_BODY) {
    res.setHeader("Connection", "close");
    return reply(res, 413, "Form is too large");
  }
  const ip = clientIp(req);
  if (rateLimited(ip)) return reply(res, 429, "Too many submissions, please try again later");
  if (!validPow(String(req.headers["framer-pow"] || ""))) return reply(res, 400, "Invalid submission");

  let data;
  try {
    const body = await readBody(req);
    data = await new Request("http://form.local/", {
      method: "POST",
      headers: { "content-type": String(req.headers["content-type"] || "") },
      body,
    }).formData();
  } catch (err) {
    return reply(res, err.status || 400, err.status === 413 ? "Form is too large" : "Could not read the form");
  }

  try {
    if (!(await verifyRecaptcha(String(data.get("g-recaptcha-response") || ""), ip))) {
      return reply(res, 400, "Please complete the reCAPTCHA verification");
    }
  } catch (err) {
    console.error(`[forms] reCAPTCHA check failed: ${err.message}`);
    return reply(res, 502, "Could not verify reCAPTCHA, please try again");
  }

  const fields = fieldOrder(req.headers["framer-form-fields"], data)
    .slice(0, MAX_FIELDS)
    .map((name) => [name.slice(0, 200), String(data.get(name) ?? "").trim().slice(0, MAX_VALUE)]);
  if (!fields.some(([, value]) => value)) return reply(res, 400, "The form is empty");

  let page = "";
  try {
    const referer = new URL(String(req.headers.referer || ""));
    if (referer.protocol === "https:" || referer.protocol === "http:") page = referer.href;
  } catch {}
  const email = composeEmail(formName, fields, page);

  if (!EMAIL_ENABLED) {
    console.log(`[forms] ${formName} (email not set up, logged instead)\n${email.text}`);
    return reply(res, 200);
  }
  try {
    await sendEmail(email);
    console.log(`[forms] ${formName} emailed to ${FORMS_TO}`);
    return reply(res, 200);
  } catch (err) {
    console.error(`[forms] ${formName} could not be emailed: ${err.message}\n${email.text}`);
    return reply(res, 502, "Your message could not be sent, please try again");
  }
}

function logFormsSetup() {
  if (EMAIL_ENABLED) console.log(`Form submissions are emailed to ${FORMS_TO}`);
  else console.log("Form email is not set up (RESEND_API_KEY and MAIL_FROM); submissions are logged instead");
}

module.exports = { handleForm, logFormsSetup, FORMS_API: "https://api.framer.com/forms/v1/forms/" };
