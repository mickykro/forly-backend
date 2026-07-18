/*
 * Forly intake + pages server — standalone replacement for the Firebase
 * Functions path (upload URLs, property creation, page builder, page serving).
 *
 * Routes (matching the existing frontends and n8n, so nothing else changes):
 *   INTAKE (public-agent forms)
 *     POST /api/upload-urls            → direct-to-disk upload slots
 *     PUT  /api/upload/:fname          → raw upload to disk
 *     POST /api/properties/demo-create → create listing + kick n8n WW1
 *     GET  /api/listing-status         → building-screen polling
 *   PAGE BUILDER (called by n8n instead of the createPropertyPage function)
 *     POST /createPropertyPage         → re-host assets, write page, return page_url
 *   LANDING PAGE (public-nadlan /p/ frontend)
 *     GET  /api/property-page?id=      → public page payload
 *     POST /api/property-lead          → capture a lead, notify agent
 *     POST /api/property-event         → beacon metrics
 *     GET  /p/:id                      → serve the landing page shell
 *
 * Storage: uploads + re-hosted page assets live under UPLOAD_DIR and are
 * served at BASE_URL/files/… . Listings/pages go to Firestore when a service
 * account is provided (required for the n8n Page Builder's Firestore reads),
 * otherwise to an in-memory store (single-process demo only).
 *
 * Env: see server/.env.example
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const auth = require("./auth");

// Load server/.env if present so config lives in a file, not fragile inline
// env vars. Inline `KEY=val node index.js` still works and overrides the file.
(function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith("#")) continue;
    const key = m[1];
    const val = m[2].trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = val;
  }
  console.log(`Loaded config from ${envPath}`);
})();

const PORT = Number(process.env.PORT || 8787);
const BASE_URL = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "data", "uploads");
// Where landing pages are served — defaults to this server (pages live at /p/).
const PAGE_BASE_URL = (process.env.PAGE_BASE_URL || BASE_URL).replace(/\/+$/, "");
// Local-dev convenience: when set, uploads are proxied to this host and the
// returned public_url points there, so images from local testing carry the same
// (production) URL and are fetchable by the real pipeline. Unset = local disk.
const REMOTE_UPLOAD_BASE = (process.env.REMOTE_UPLOAD_BASE || "").replace(/\/+$/, "");
const UPLOAD_PUBLIC_BASE = REMOTE_UPLOAD_BASE || BASE_URL;
const N8N_WW1_WEBHOOK_URL = process.env.N8N_WW1_WEBHOOK_URL || "";
const N8N_PIPELINE_WEBHOOK_URL = process.env.N8N_PIPELINE_WEBHOOK_URL || "";
const N8N_LEAD_WEBHOOK_URL = process.env.N8N_LEAD_WEBHOOK_URL || "";
const GREENAPI_INSTANCE = process.env.GREENAPI_INSTANCE || "";
const GREENAPI_TOKEN = process.env.GREENAPI_TOKEN || "";
// Secret for agent session cookies + one-tap action links (was NADLAN_JWT_SECRET
// in the Cloud Functions path). Without it the auth/dashboard routes refuse to
// run rather than issue forgeable sessions.
const NADLAN_JWT_SECRET = process.env.NADLAN_JWT_SECRET || "";

const MAX_UPLOAD_FILES = 12;
const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const VIDEO_TYPES = { "video/mp4": "mp4", "video/quicktime": "mp4" };
// Custom landing-page fonts. Browsers send inconsistent MIME for fonts (often
// empty or application/octet-stream), so upload-urls also falls back to the
// file extension — see FONT_EXTS.
const FONT_TYPES = { "font/woff2": "woff2", "font/woff": "woff", "font/ttf": "ttf", "font/otf": "otf" };
const FONT_EXTS = { woff2: "woff2", woff: "woff", ttf: "ttf", otf: "otf" };
const MAX_IMAGE_MB = 10;
const MAX_VIDEO_MB = 120;
const MAX_FONT_MB = 5;
const PAGE_LIFESPAN_DAYS = 30;
const REMINDER_BEFORE_DAYS = 5;
const LEAD_MAX_PER_HOUR = 3;
// OTP policy (mirrors the Cloud Functions auth path).
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_GAP_MS = 60 * 1000;
const OTP_MAX_SENDS_PER_DAY = 5;
const OTP_MAX_ATTEMPTS = 5;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── storage: Firestore (optional) or in-memory ──
let db = null;
let FieldValue = null;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const admin = require("firebase-admin");
  admin.initializeApp();
  db = admin.firestore();
  FieldValue = admin.firestore.FieldValue;
  console.log("Firestore enabled (service account credentials found)");
} else {
  console.warn("No GOOGLE_APPLICATION_CREDENTIALS — using in-memory store. " +
    "The n8n Page Builder reads listings from real Firestore, so set the SA " +
    "key for the full pipeline; in-memory is single-process demo only.");
}
const mem = {
  listings: new Map(), pages: new Map(), leads: new Map(), throttle: new Map(),
  businesses: new Map(), otps: new Map(), lead_submissions: [],
};

// Millis from a Firestore Timestamp or a JS Date (in-memory mode stores Dates).
function toMillis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  return new Date(v).getTime();
}

async function saveListing(l) {
  if (db) await db.collection("listings").doc(l.listing_id).set(l);
  else mem.listings.set(l.listing_id, l);
}
async function getListing(id) {
  if (db) { const d = await db.collection("listings").doc(id).get(); return d.exists ? d.data() : null; }
  return mem.listings.get(id) || null;
}
async function setListingPageId(id, pageId) {
  if (db) await db.collection("listings").doc(id).set({ page_id: pageId }, { merge: true });
  else { const l = mem.listings.get(id); if (l) l.page_id = pageId; }
}
async function savePage(p) {
  if (db) await db.collection("property_pages").doc(p.page_id).set(p);
  else mem.pages.set(p.page_id, p);
}
async function getPage(id) {
  if (db) { const d = await db.collection("property_pages").doc(id).get(); return d.exists ? d.data() : null; }
  return mem.pages.get(id) || null;
}
async function findActivePageByListing(listingId) {
  if (db) {
    const snap = await db.collection("property_pages").where("listing_id", "==", listingId).limit(5).get();
    const doc = snap.docs.find((d) => d.get("status") !== "archived");
    return doc ? doc.data() : null;
  }
  for (const p of mem.pages.values()) {
    if (p.listing_id === listingId && p.status !== "archived") return p;
  }
  return null;
}
async function incrPageCounter(pageId, field, by) {
  if (db) await db.collection("property_pages").doc(pageId).update({ [field]: FieldValue.increment(by) });
  else { const p = mem.pages.get(pageId); if (p) p[field] = (p[field] || 0) + by; }
}

// ── businesses (agent accounts) ──
async function getBusiness(phone) {
  if (db) { const d = await db.collection("businesses").doc(phone).get(); return d.exists ? d.data() : null; }
  return mem.businesses.get(phone) || null;
}
async function setBusiness(phone, data, merge) {
  if (db) { await db.collection("businesses").doc(phone).set(data, { merge: !!merge }); return; }
  mem.businesses.set(phone, merge ? { ...(mem.businesses.get(phone) || {}), ...data } : data);
}

// ── otp_codes (login/signup codes) ──
async function getOtp(phone) {
  if (db) { const d = await db.collection("otp_codes").doc(phone).get(); return d.exists ? d.data() : null; }
  return mem.otps.get(phone) || null;
}
async function setOtp(phone, data) {
  if (db) { await db.collection("otp_codes").doc(phone).set(data); return; }
  mem.otps.set(phone, data);
}
async function updateOtp(phone, patch) {
  if (db) { await db.collection("otp_codes").doc(phone).update(patch); return; }
  const o = mem.otps.get(phone); if (o) Object.assign(o, patch);
}
async function deleteOtp(phone) {
  if (db) { await db.collection("otp_codes").doc(phone).delete(); return; }
  mem.otps.delete(phone);
}

// ── dashboard queries (by owner phone) ──
async function listListingsByPhone(phone, statuses) {
  if (db) {
    const snap = await db.collection("listings")
      .where("business_phone", "==", phone)
      .where("status", "in", statuses).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.listings.values()].filter((l) => l.business_phone === phone && statuses.includes(l.status));
}
async function listPagesByPhone(phone) {
  if (db) {
    const snap = await db.collection("property_pages").where("business_phone", "==", phone).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.pages.values()].filter((p) => p.business_phone === phone);
}
async function updateListing(id, patch) {
  if (db) { await db.collection("listings").doc(id).update(patch); return; }
  const l = mem.listings.get(id); if (l) Object.assign(l, patch);
}
// Partial page update from a { "dot.path": value } patch (both storage modes).
async function patchPage(pageId, patch) {
  if (db) { await db.collection("property_pages").doc(pageId).update(patch); return; }
  const p = mem.pages.get(pageId);
  if (!p) return;
  for (const [key, val] of Object.entries(patch)) {
    const parts = key.split(".");
    let o = p;
    while (parts.length > 1) { const k = parts.shift(); o[k] = o[k] || {}; o = o[k]; }
    o[parts[0]] = val;
  }
}
async function addLeadSubmission(rec) {
  if (db) { await db.collection("lead_submissions").add(rec); return; }
  mem.lead_submissions.push(rec);
}
async function bumpPageMetric(pageId, event) {
  const day = new Date().toISOString().slice(0, 10);
  if (db) {
    await db.collection("property_pages").doc(pageId).collection("metrics").doc(day)
      .set({ [event]: FieldValue.increment(1) }, { merge: true });
  }
  // in-memory mode skips the metrics subcollection (demo only)
}
// Pages that may need a reminder or expiry sweep (active/expiring, expiring soon).
async function listPagesForExpiry(soonMs) {
  if (db) {
    const snap = await db.collection("property_pages")
      .where("status", "in", ["active", "expiring"])
      .where("expires_at", "<=", new Date(soonMs))
      .limit(100).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.pages.values()].filter((p) =>
    (p.status === "active" || p.status === "expiring") && toMillis(p.expires_at) <= soonMs).slice(0, 100);
}

// ── helpers ──
const pad = (n) => String(n).padStart(2, "0");
const daysFromNow = (d) => new Date(Date.now() + d * 86400000);

// ── pretty page ids: {agent-slug}-{shortcode} instead of a raw UUID ──
// Content is Hebrew, so the agent part is transliterated to Latin (Hebrew in a
// URL percent-encodes into something uglier than a UUID); the random suffix
// guarantees uniqueness and keeps pages from being trivially enumerable.
const HE_LATIN = {
  "א": "a", "ב": "b", "ג": "g", "ד": "d", "ה": "h", "ו": "v", "ז": "z",
  "ח": "ch", "ט": "t", "י": "y", "כ": "k", "ך": "k", "ל": "l", "מ": "m",
  "ם": "m", "נ": "n", "ן": "n", "ס": "s", "ע": "a", "פ": "p", "ף": "f",
  "צ": "tz", "ץ": "tz", "ק": "k", "ר": "r", "ש": "sh", "ת": "t",
};
function translit(s) {
  return String(s || "").split("").map((c) => (c in HE_LATIN ? HE_LATIN[c] : c)).join("");
}
function agentSlug(agent) {
  const raw = (agent && (agent.brand_name || agent.name)) || "";
  const s = translit(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/g, "");
  return s || "nadlan";
}
// Unambiguous base32 (no 0/1/o/i/l) so shared/typed links don't get mangled.
const SHORT_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
function shortCode(n) {
  const bytes = crypto.randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += SHORT_ALPHABET[bytes[i] % SHORT_ALPHABET.length];
  return out;
}
// {agentSlug}-{shortCode}, collision-checked against existing pages. 30^5 ≈ 24M
// suffixes per agent prefix, so the loop effectively never repeats.
async function uniquePageId(agent) {
  const base = agentSlug(agent);
  for (let i = 0; i < 6; i++) {
    const cand = `${base}-${shortCode(5)}`;
    if (!(await getPage(cand))) return cand;
  }
  return `${base}-${shortCode(8)}`;
}

// Landing-page theme: only whitelist a hex color, a short font family/token, and
// an optional custom-font URL. Returns null when nothing usable was provided.
const HEX = /^#[0-9a-fA-F]{6}$/;
function sanitizeTheme(t) {
  if (!t || typeof t !== "object") return null;
  const hex = (v) => (typeof v === "string" && HEX.test(v.trim()) ? v.trim() : null);
  const str = (v) => (typeof v === "string" ? v.slice(0, 60) : null);
  const TEMPLATES = { original: 1, nocturne: 1, galerie: 1, reel: 1 };
  const clean = {
    template: TEMPLATES[t.template] ? t.template : null,
    font_title: str(t.font_title),
    font_body: str(t.font_body),
    font_url: typeof t.font_url === "string" && /^https?:\/\//.test(t.font_url) ? t.font_url : null,
    primary: hex(t.primary),
    accent: hex(t.accent),
  };
  return (clean.template || clean.font_title || clean.font_body || clean.font_url || clean.primary || clean.accent) ? clean : null;
}

// Landing-page language. Whitelist the supported codes; default to Hebrew.
const LANGUAGES = { he: 1, en: 1, ar: 1, ru: 1, es: 1, fr: 1 };
function sanitizeLang(v) {
  return (typeof v === "string" && LANGUAGES[v]) ? v : "he";
}

function normalizePhone(raw) {
  const digits = String(raw).replace(/\D/g, "");
  if (/^05\d{8}$/.test(digits)) return "972" + digits.slice(1);
  if (/^9725\d{8}$/.test(digits)) return digits;
  if (/^5\d{8}$/.test(digits)) return "972" + digits;
  return null;
}

function guessImageExt(url) {
  const m = url.split("?")[0].match(/\.(png|webp|jpe?g)$/i);
  if (!m) return "jpg";
  const e = m[1].toLowerCase();
  return e === "png" ? "png" : e === "webp" ? "webp" : "jpg";
}

// Download a remote asset to local disk under UPLOAD_DIR, return its public URL.
// Mirrors the Cloud Function's downloadAndUpload so page assets never expire.
async function rehost(url, destRel) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`fetch ${url} → ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const full = path.join(UPLOAD_DIR, destRel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buf);
  return `${BASE_URL}/files/${destRel}`;
}

async function sendWhatsApp(phone, message) {
  if (!GREENAPI_INSTANCE || !GREENAPI_TOKEN) return;
  await fetch(`https://api.green-api.com/waInstance${GREENAPI_INSTANCE}/sendMessage/${GREENAPI_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: `${phone}@c.us`, message }),
    signal: AbortSignal.timeout(20000),
  });
}

const app = express();
app.use(express.json({ limit: "2mb" }));

// static: agent forms, nadlan landing-page frontend, and uploaded/re-hosted files
app.use(express.static(path.join(__dirname, "..", "public-agent"), { index: "index.html" }));
app.use(express.static(path.join(__dirname, "..", "public-nadlan")));
app.use("/files", express.static(UPLOAD_DIR, { maxAge: "1d", immutable: true }));
// Template assets + previews: serving a template HTML here (no __PAGE__ injected)
// renders it with its demo data — exactly what the intake form's iframes show.
const TEMPLATES_DIR = path.join(__dirname, "..", "public-nadlan", "templates");
app.use("/tpl", express.static(TEMPLATES_DIR));

// ════════════════════════════ INTAKE ════════════════════════════

app.post("/api/upload-urls", (req, res) => {
  // Accept an authenticated agent session OR the operator-driven demo header.
  if (!sessionPhone(req) && !("x-demo-key" in req.headers)) {
    return res.status(401).json({ error: "unauthenticated" });
  }
  const files = req.body && req.body.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_UPLOAD_FILES) {
    return res.status(400).json({ error: `1-${MAX_UPLOAD_FILES} files` });
  }
  const slots = [];
  for (const f of files) {
    const ct = String((f && f.contentType) || "");
    const nameExt = String((f && f.name) || "").split(".").pop().toLowerCase();
    // Fonts often arrive with empty/octet-stream MIME → fall back to extension.
    const ext = IMAGE_TYPES[ct] || VIDEO_TYPES[ct] || FONT_TYPES[ct] || FONT_EXTS[nameExt];
    if (!ext) return res.status(400).json({ error: `unsupported type: ${ct}` });
    const isVideo = ext === "mp4";
    const isFont = ext in FONT_EXTS;
    const fname = `${crypto.randomUUID()}.${ext}`;
    slots.push({
      name: (f && f.name) || fname,
      upload_url: `/api/upload/${fname}`,
      method: "PUT",
      content_type: ct,
      public_url: `${UPLOAD_PUBLIC_BASE}/files/${fname}`,
      max_mb: isVideo ? MAX_VIDEO_MB : isFont ? MAX_FONT_MB : MAX_IMAGE_MB,
    });
  }
  res.json({ files: slots });
});

const rawBody = express.raw({ type: () => true, limit: `${MAX_VIDEO_MB}mb` });
app.put("/api/upload/:fname", rawBody, async (req, res) => {
  const fname = req.params.fname;
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp|mp4|woff2|woff|ttf|otf)$/.test(fname)) {
    return res.status(400).json({ error: "bad filename" });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: "empty body" });
  }
  const isVideo = fname.endsWith(".mp4");
  const isFont = /\.(woff2|woff|ttf|otf)$/.test(fname);
  const maxMb = isVideo ? MAX_VIDEO_MB : isFont ? MAX_FONT_MB : MAX_IMAGE_MB;
  if (req.body.length > maxMb * 1024 * 1024) {
    return res.status(413).json({ error: "too large" });
  }
  // Local-dev remote mode: proxy the bytes to the production host so the file is
  // reachable at the same URL we returned in public_url. (Production never sets
  // REMOTE_UPLOAD_BASE, so the forwarded request just writes to disk there — no loop.)
  if (REMOTE_UPLOAD_BASE) {
    try {
      const r = await fetch(`${REMOTE_UPLOAD_BASE}/api/upload/${fname}`, {
        method: "PUT",
        headers: { "Content-Type": req.headers["content-type"] || "application/octet-stream" },
        body: req.body,
        signal: AbortSignal.timeout(120000),
      });
      if (!r.ok) return res.status(502).json({ error: `remote upload failed: ${r.status}` });
      return res.json({ ok: true, remote: true });
    } catch (err) {
      return res.status(502).json({ error: `remote upload failed: ${err.message}` });
    }
  }
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), req.body);
  res.json({ ok: true });
});

async function createListing(phone, body, agentOverride) {
  if (!body.address || !body.city || !body.price || !body.rooms) {
    return { error: "address, city, price, rooms are required", code: 400 };
  }
  if (!Array.isArray(body.photos_urls) || body.photos_urls.length < 3) {
    return { error: "at least 3 photos required", code: 400 };
  }
  const listingId = crypto.randomUUID();
  const listing = {
    listing_id: listingId, business_phone: phone, source: "dashboard",
    address: String(body.address).slice(0, 120),
    neighborhood: String(body.neighborhood || "").slice(0, 60),
    city: String(body.city).slice(0, 60),
    listing_type: body.listing_type === "rent" ? "rent" : "sale",
    price: Number(body.price) || 0, rooms: Number(body.rooms) || 0,
    size_sqm: Number(body.size_sqm) || 0, floor: Number(body.floor) || 0,
    parking: Number(body.parking) || 0,
    description: String(body.description || "").slice(0, 2000),
    photos_urls: body.photos_urls.slice(0, MAX_UPLOAD_FILES),
    own_video_url: body.own_video_url || null,
    status: "active", page_id: null,
    agent: agentOverride ? {
      name: String(agentOverride.name || ""),
      brand_name: String(agentOverride.brand_name || agentOverride.name || ""),
      logo_url: agentOverride.logo_url || null,
      tagline: String(agentOverride.tagline || ""),
      phone: String(agentOverride.phone || phone),
      license: String(agentOverride.license || ""),
    } : null,
    theme: sanitizeTheme(body.theme),
    language: sanitizeLang(body.language),
    created_at: new Date(),
  };
  await saveListing(listing);

  const webhook = listing.own_video_url ? N8N_PIPELINE_WEBHOOK_URL : N8N_WW1_WEBHOOK_URL;
  const payload = listing.own_video_url ? {
    listing_id: listingId, business_phone: phone, video_url: listing.own_video_url,
    language: listing.language,
  } : {
    phone, image_urls: listing.photos_urls, listing_id: listingId, trigger_source: "dashboard",
    language: listing.language,
    property_details: {
      listing_type: listing.listing_type,
      address: listing.address, neighborhood: listing.neighborhood, city: listing.city,
      price: listing.price, rooms: listing.rooms, size_sqm: listing.size_sqm,
      floor: listing.floor, parking: listing.parking, description: listing.description,
    },
  };
  if (webhook) {
    fetch(webhook, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
    }).then((r) => console.log(`pipeline webhook → ${r.status}`))
      .catch((err) => console.error("pipeline webhook failed:", err.message));
  } else {
    console.warn("no pipeline webhook configured; listing created without page build");
  }
  return { listing_id: listingId };
}

app.post("/api/properties/demo-create", async (req, res) => {
  const body = req.body || {};
  const agentPhone = body.agent && body.agent.phone ? String(body.agent.phone) : "";
  if (!agentPhone) return res.status(400).json({ error: "agent.phone required" });
  const result = await createListing(agentPhone, body, body.agent || {});
  if (result.error) return res.status(result.code).json({ error: result.error });
  res.json({ ...result, status: "building" });
});

app.get("/api/listing-status", async (req, res) => {
  const id = typeof req.query.id === "string" ? req.query.id : "";
  if (!id) return res.status(400).json({ error: "missing id" });
  const listing = await getListing(id);
  if (!listing) return res.status(404).json({ error: "not found" });
  res.json({
    listing_id: id,
    page_id: listing.page_id || null,
    page_url: listing.page_id ? `${PAGE_BASE_URL}/p/${listing.page_id}` : null,
    // "building" until a page exists; the pipeline may set "failed" so the
    // building screen can surface an error instead of polling indefinitely.
    status: listing.page_id ? "ready" : (listing.status === "failed" ? "failed" : "building"),
  });
});

// ════════════════════════ AGENT AUTH + DASHBOARD ════════════════════════
// Ported from the Cloud Functions nadlan path so the whole agent app runs on
// this server. Session = HMAC cookie (server/auth.js). All owner-scoped routes
// check business_phone === session.sub.

const todayKey = () => new Date().toISOString().slice(0, 10);
const sessionPhone = (req) => auth.requireAuth(req, NADLAN_JWT_SECRET);
// Guard: refuse auth routes if the signing secret isn't configured.
function requireSecret(res) {
  if (NADLAN_JWT_SECRET) return true;
  res.status(503).json({ error: "auth_not_configured" });
  return false;
}

// POST /api/auth/otp — { phone, mode?: "login" | "signup" }
app.post("/api/auth/otp", async (req, res) => {
  if (!requireSecret(res)) return;
  const phone = normalizePhone((req.body && req.body.phone) || "");
  if (!phone) return res.status(400).json({ error: "invalid_phone" });
  const mode = (req.body && req.body.mode) === "signup" ? "signup" : "login";

  const business = await getBusiness(phone);
  if (mode === "login" && !business) return res.status(404).json({ error: "unknown_agent" });
  if (mode === "signup" && business) return res.status(409).json({ error: "already_registered" });

  const now = Date.now();
  const prev = (await getOtp(phone)) || {};
  const lastSent = prev.last_sent_at ? toMillis(prev.last_sent_at) : 0;
  if (now - lastSent < OTP_RESEND_GAP_MS) {
    return res.status(429).json({ error: "too_soon", retry_in_s: Math.ceil((OTP_RESEND_GAP_MS - (now - lastSent)) / 1000) });
  }
  const sendsToday = prev.sends_day === todayKey() ? (prev.sends_today || 0) : 0;
  if (sendsToday >= OTP_MAX_SENDS_PER_DAY) return res.status(429).json({ error: "daily_limit" });

  const code = String(crypto.randomInt(100000, 1000000));
  await setOtp(phone, {
    code_hash: auth.hashCode(code, NADLAN_JWT_SECRET),
    expires_at: new Date(now + OTP_TTL_MS),
    attempts: 0, mode,
    last_sent_at: new Date(now),
    sends_today: sendsToday + 1, sends_day: todayKey(),
  });

  try {
    if (!GREENAPI_INSTANCE || !GREENAPI_TOKEN) throw new Error("greenapi_not_configured");
    await sendWhatsApp(phone, `🔐 קוד הכניסה שלך לפורלי: ${code}\nהקוד תקף ל-5 דקות.`);
  } catch (err) {
    console.error("OTP WhatsApp send failed:", err.message);
    return res.status(502).json({ error: "whatsapp_send_failed" });
  }
  res.json({ ok: true });
});

// POST /api/auth/verify — { phone, code } → session cookie
app.post("/api/auth/verify", async (req, res) => {
  if (!requireSecret(res)) return;
  const phone = normalizePhone((req.body && req.body.phone) || "");
  const code = String((req.body && req.body.code) || "").trim();
  if (!phone || !/^\d{6}$/.test(code)) return res.status(400).json({ error: "invalid_input" });

  const otp = await getOtp(phone);
  if (!otp) return res.status(400).json({ error: "no_code" });
  if (toMillis(otp.expires_at) < Date.now()) { await deleteOtp(phone); return res.status(400).json({ error: "expired" }); }
  if ((otp.attempts || 0) >= OTP_MAX_ATTEMPTS) { await deleteOtp(phone); return res.status(429).json({ error: "too_many_attempts" }); }
  if (otp.code_hash !== auth.hashCode(code, NADLAN_JWT_SECRET)) {
    await updateOtp(phone, { attempts: (otp.attempts || 0) + 1 });
    return res.status(401).json({ error: "wrong_code", attempts_left: OTP_MAX_ATTEMPTS - (otp.attempts || 0) - 1 });
  }

  await deleteOtp(phone);
  res.set("Set-Cookie", auth.sessionCookie(auth.signSession(phone, NADLAN_JWT_SECRET)));
  const b = (await getBusiness(phone)) || {};
  res.json({
    ok: true, is_new: !Object.keys(b).length, mode: otp.mode || "login",
    agent: { name: b.full_name || "", brand_name: b.business_name || "", logo_url: b.logo_url || null },
  });
});

// GET /api/properties — list mine (session)
app.get("/api/properties", async (req, res) => {
  const phone = sessionPhone(req);
  if (!phone) return res.status(401).json({ error: "unauthenticated" });
  const [listings, pages] = await Promise.all([
    listListingsByPhone(phone, ["active", "archived"]),
    listPagesByPhone(phone),
  ]);
  const pageById = new Map(pages.map((p) => [p.page_id, p]));
  const items = listings.map((d) => {
    const page = d.page_id ? pageById.get(d.page_id) : null;
    const expiresAt = page && page.expires_at ? toMillis(page.expires_at) : null;
    return {
      listing_id: d.listing_id, page_id: d.page_id,
      title: (page && page.property && page.property.title) || d.address,
      address: d.address, listing_status: d.status,
      page_status: (page && page.status) || "building",
      days_left: expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 86400000)) : null,
      view_count: (page && page.view_count) || 0,
      lead_count: (page && page.lead_count) || 0,
      page_url: d.page_id ? `${PAGE_BASE_URL}/p/${d.page_id}` : null,
      thumb_url: (page && page.gallery && page.gallery.images[0] && page.gallery.images[0].url) || d.photos_urls[0] || null,
      created_at: d.created_at,
    };
  }).sort((a, b) => toMillis(b.created_at) - toMillis(a.created_at));
  res.json({ properties: items });
});

// POST /api/properties/create — create a real listing (session)
app.post("/api/properties/create", async (req, res) => {
  const phone = sessionPhone(req);
  if (!phone) return res.status(401).json({ error: "unauthenticated" });
  const result = await createListing(phone, req.body || {}, null);
  if (result.error) return res.status(result.code).json({ error: result.error });
  res.json({ ...result, status: "building" });
});

// POST /api/properties/delete — { listing_id, mode: "archive" | "delete" } (session, owner)
app.post("/api/properties/delete", async (req, res) => {
  const phone = sessionPhone(req);
  if (!phone) return res.status(401).json({ error: "unauthenticated" });
  const { listing_id: listingId, mode } = req.body || {};
  if (!listingId || (mode !== "archive" && mode !== "delete")) {
    return res.status(400).json({ error: "listing_id and mode(archive|delete) required" });
  }
  const listing = await getListing(listingId);
  if (!listing) return res.status(404).json({ error: "not found" });
  if (listing.business_phone !== phone) return res.status(403).json({ error: "not_owner" });
  const pageId = listing.page_id || null;
  try {
    if (mode === "archive") {
      await updateListing(listingId, { status: "archived" });
      if (pageId) await patchPage(pageId, { status: "archived" });
    } else {
      await updateListing(listingId, { status: "deleted" });
      if (pageId) {
        await patchPage(pageId, { status: "archived" });
        fs.rm(path.join(UPLOAD_DIR, "pages", pageId), { recursive: true, force: true }, () => {});
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("deleteProperty failed:", err);
    res.status(500).json({ error: "internal" });
  }
});

// POST /api/page/update — structured editor save (session, owner). Whitelist merge.
app.post("/api/page/update", async (req, res) => {
  const phone = sessionPhone(req);
  if (!phone) return res.status(401).json({ error: "unauthenticated" });
  const body = req.body || {};
  if (!body.page_id) return res.status(400).json({ error: "missing page_id" });
  const d = await getPage(body.page_id);
  if (!d) return res.status(404).json({ error: "not found" });
  if (d.business_phone !== phone) return res.status(403).json({ error: "not_owner" });

  const patch = { updated_at: new Date(), edit_count: (d.edit_count || 0) + 1 };
  if (typeof body.hero_phrase === "string") patch["hero.phrase"] = body.hero_phrase.slice(0, 80);
  if (body.property && typeof body.property === "object") {
    for (const k of ["title", "address", "neighborhood", "city", "price", "rooms", "size_sqm", "floor", "parking"]) {
      if (body.property[k] !== undefined) patch[`property.${k}`] = body.property[k];
    }
  }
  if (Array.isArray(body.gallery_images)) {
    const current = new Set((d.gallery.images || []).map((i) => i.url));
    const next = body.gallery_images
      .filter((i) => i && current.has(i.url))
      .map((i) => ({ url: i.url, caption: String(i.caption || "").slice(0, 60) }));
    if (next.length >= 1) patch["gallery.images"] = next;
  }
  if (Array.isArray(body.carousel_slides)) {
    patch["carousel.slides"] = (d.carousel.slides || []).map((s, i) => {
      const p = body.carousel_slides[i] || {};
      return {
        num: s.num,
        title: String(p.title != null ? p.title : s.title).slice(0, 60),
        body: String(p.body != null ? p.body : s.body).slice(0, 300),
        tag: String(p.tag != null ? p.tag : s.tag).slice(0, 30),
      };
    });
  }
  if (body.cta && typeof body.cta === "object") {
    if (typeof body.cta.headline === "string") patch["cta.headline"] = body.cta.headline.slice(0, 80);
    if (typeof body.cta.sub === "string") patch["cta.sub"] = body.cta.sub.slice(0, 200);
    if (typeof body.cta.button_label === "string") patch["cta.button_label"] = body.cta.button_label.slice(0, 30);
  }
  if (body.sections && typeof body.sections === "object") {
    for (const k of ["gallery", "carousel", "area"]) {
      if (typeof body.sections[k] === "boolean") patch[`sections.${k}`] = body.sections[k];
    }
  }
  await patchPage(body.page_id, patch);
  res.json({ ok: true, edit_count: patch.edit_count });
});

// Extend helpers + routes (dual auth: session POST, one-tap signed GET).
async function applyExtension(pageId) {
  const d = await getPage(pageId);
  const base = Math.max(Date.now(), toMillis(d.expires_at));
  const newExpiry = new Date(base + PAGE_LIFESPAN_DAYS * 86400000);
  await patchPage(pageId, {
    expires_at: newExpiry, status: "active",
    extension_count: (d.extension_count || 0) + 1,
    reminder_sent_at: null, updated_at: new Date(),
  });
  return newExpiry;
}
function buildExtendLink(pageId, expiresAtMs) {
  const t = auth.signActionToken([pageId, String(expiresAtMs)], NADLAN_JWT_SECRET);
  return `${PAGE_BASE_URL}/api/extend?id=${pageId}&e=${expiresAtMs}&t=${t}`;
}
function confirmHtml(title, sub) {
  return `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title>` +
    `<style>body{font-family:-apple-system,'Segoe UI',sans-serif;background:#F7F3EC;color:#17140F;` +
    `display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center}` +
    `.card{background:#FFFDF9;border:1px solid rgba(185,138,47,.3);border-radius:22px;padding:48px 36px;` +
    `max-width:340px;box-shadow:0 20px 60px rgba(23,20,15,.08)}h1{font-size:1.5rem;margin:0 0 10px}` +
    `p{color:#5A5348;margin:0}</style></head>` +
    `<body><div class="card"><h1>${title}</h1><p>${sub}</p></div></body></html>`;
}
const expiredLinkHtml = () => confirmHtml("הקישור אינו תקף", "ייתכן שהדף כבר הוארך. ניתן להאריך גם דרך agent.call4li.com");

// POST /api/page/extend — dashboard (session, owner)
app.post("/api/page/extend", async (req, res) => {
  const phone = sessionPhone(req);
  if (!phone) return res.status(401).json({ error: "unauthenticated" });
  const pageId = String((req.body && req.body.page_id) || "");
  const d = await getPage(pageId);
  if (!d) return res.status(404).json({ error: "not found" });
  if (d.business_phone !== phone) return res.status(403).json({ error: "not_owner" });
  const newExpiry = await applyExtension(pageId);
  res.json({ ok: true, expires_at: newExpiry.toISOString() });
});

// GET /api/extend?id=&e=&t= — one-tap WhatsApp link (signed, single-use)
app.get("/api/extend", async (req, res) => {
  if (!requireSecret(res)) return;
  const pageId = String(req.query.id || "");
  const e = String(req.query.e || "");
  const t = String(req.query.t || "");
  if (!pageId || !e || !t || !auth.verifyActionToken([pageId, e], t, NADLAN_JWT_SECRET)) {
    return res.status(401).type("html").send(expiredLinkHtml());
  }
  const d = await getPage(pageId);
  if (!d || toMillis(d.expires_at) !== Number(e)) {
    return res.status(401).type("html").send(expiredLinkHtml());
  }
  const newExpiry = await applyExtension(pageId);
  const dateStr = newExpiry.toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" });
  res.type("html").send(confirmHtml("✅ הדף הוארך בהצלחה", `הדף פעיל עד ${dateStr}.`));
});

// POST /api/signup — complete web signup (session from signup-mode OTP)
app.post("/api/signup", async (req, res) => {
  const phone = sessionPhone(req);
  if (!phone) return res.status(401).json({ error: "unauthenticated" });
  const body = req.body || {};
  const fullName = String(body.full_name || "").trim().slice(0, 60);
  const businessName = String(body.business_name || "").trim().slice(0, 60);
  if (fullName.length < 2 || businessName.length < 2) {
    return res.status(400).json({ error: "full_name and business_name required" });
  }
  const existing = await getBusiness(phone);
  if (existing && existing.signup_completed_at) return res.status(409).json({ error: "already_registered" });
  try {
    await setBusiness(phone, {
      phone, full_name: fullName, business_name: businessName,
      city: String(body.city || "").slice(0, 60),
      niche: String(body.niche || "nadlan").slice(0, 40),
      logo_url: body.logo_url || null,
      logo_requested: body.wants_generated_logo === true && !body.logo_url,
      source: "web_signup", signup_completed_at: new Date(),
      total_inquiries_reported: 0, total_deals_closed: 0,
      created_at: existing ? existing.created_at : new Date(),
    }, true);
    try {
      await sendWhatsApp(phone,
        `ברוכים הבאים לפורלי 🦉\n${fullName}, החשבון של ${businessName} מוכן!\n\n` +
        `מה עכשיו? נכנסים ל-agent.call4li.com, פותחים נכס ראשון — ` +
        `ותוך דקות יש לו דף נחיתה עם וידאו, גלריה ומידע על השכונה.`);
    } catch (err) { console.error("welcome send failed (signup still ok):", err.message); }
    res.json({ ok: true });
  } catch (err) {
    console.error("submitWebSignup failed:", err);
    res.status(500).json({ error: "internal" });
  }
});

// ════════════════════════ PAGE BUILDER ════════════════════════
// POST /createPropertyPage — n8n Property Page Builder posts the assembled
// payload here. Idempotent per listing; re-hosts every asset locally.

app.post("/createPropertyPage", async (req, res) => {
  const body = req.body || {};
  if (!body.listing_id || !body.business_phone || !body.video_url ||
      !Array.isArray(body.photos) || body.photos.length < 1) {
    return res.status(400).json({ error: "listing_id, business_phone, video_url and photos are required" });
  }
  try {
    const reusable = await findActivePageByListing(body.listing_id);
    const pageId = reusable ? reusable.page_id : await uniquePageId(body.agent);
    const base = `pages/${pageId}`;

    // Theme is chosen on the intake form and stored on the listing; the n8n page
    // builder doesn't forward it, so read it here. A custom font is re-hosted
    // under the page assets so it never expires.
    const listing = await getListing(body.listing_id).catch(() => null);
    const theme = sanitizeTheme(body.theme || (listing && listing.theme));
    if (theme && theme.font_url) {
      const fext = (theme.font_url.split("?")[0].match(/\.(woff2|woff|ttf|otf)$/i) || [, "woff2"])[1].toLowerCase();
      theme.font_url = await rehost(theme.font_url, `${base}/font.${fext}`).catch(() => theme.font_url);
    }

    const videoP = rehost(body.video_url, `${base}/walkthrough.mp4`);
    const posterP = rehost(body.poster_url || body.photos[0].url, `${base}/poster.jpg`);
    const photoPs = body.photos.slice(0, 12).map((p, i) =>
      rehost(p.url, `${base}/photo-${pad(i + 1)}.${guessImageExt(p.url)}`));
    const mapP = body.area && body.area.map_image_url ? rehost(body.area.map_image_url, `${base}/map.png`) : null;
    const logoP = body.agent && body.agent.logo_url ? rehost(body.agent.logo_url, `${base}/logo.png`) : null;

    const [videoUrl, posterUrl, ...rest] = await Promise.all([
      videoP, posterP, ...photoPs, ...(mapP ? [mapP] : []), ...(logoP ? [logoP] : []),
    ]);
    const photoUrls = rest.slice(0, photoPs.length);
    let cursor = photoPs.length;
    const mapUrl = mapP ? rest[cursor++] : null;
    const logoUrl = logoP ? rest[cursor++] : null;

    const galleryImages = photoUrls.map((u, i) => ({ url: u, caption: (body.photos[i] && body.photos[i].caption) || "" }));
    const now = new Date();
    const doc = {
      page_id: pageId, listing_id: body.listing_id, business_phone: body.business_phone,
      status: "active",
      created_at: reusable ? reusable.created_at : now,
      updated_at: now,
      expires_at: reusable ? reusable.expires_at : daysFromNow(PAGE_LIFESPAN_DAYS),
      extension_count: reusable ? (reusable.extension_count || 0) : 0,
      edit_count: reusable ? (reusable.edit_count || 0) : 0,
      agent: {
        name: (body.agent && body.agent.name) || "",
        brand_name: (body.agent && (body.agent.brand_name || body.agent.name)) || "",
        logo_url: logoUrl,
        tagline: (body.agent && body.agent.tagline) || "",
        phone: (body.agent && body.agent.phone) || body.business_phone,
        license: (body.agent && body.agent.license) || "",
      },
      property: {
        title: (body.property && body.property.title) ||
          `${(body.property && body.property.rooms) || ""} חד׳ ב${(body.property && (body.property.neighborhood || body.property.city)) || ""}`.trim(),
        listing_type: (body.property && body.property.listing_type) || (listing && listing.listing_type) || "sale",
        address: (body.property && body.property.address) || "",
        neighborhood: (body.property && body.property.neighborhood) || "",
        city: (body.property && body.property.city) || "",
        price: Number(body.property && body.property.price) || 0,
        rooms: Number(body.property && body.property.rooms) || 0,
        size_sqm: Number(body.property && body.property.size_sqm) || 0,
        floor: Number(body.property && body.property.floor) || 0,
        parking: Number(body.property && body.property.parking) || 0,
      },
      theme: theme || null,
      language: sanitizeLang(body.language || (listing && listing.language)),
      hero: { phrase: body.hero_phrase || "", video_url: videoUrl, poster_url: posterUrl },
      gallery: { images: galleryImages },
      carousel: { slides: (body.carousel_slides || []).slice(0, 6) },
      area: {
        blurb: (body.area && body.area.blurb) || "",
        stops: (body.area && body.area.stops) || [],
        stats: ((body.area && body.area.stats) || []).filter((s) => s && s.source_url),
        map_image_url: mapUrl,
        profile_slug: (body.area && body.area.profile_slug) || null,
      },
      cta: {
        headline: (body.cta && body.cta.headline) || "רוצים לראות את הנכס מקרוב?",
        sub: (body.cta && body.cta.sub) || "השאירו פרטים ונחזור אליכם לתיאום ביקור.",
        bullets: (body.cta && body.cta.bullets) || [],
        button_label: (body.cta && body.cta.button_label) || "תיאום ביקור",
      },
      sections: { gallery: galleryImages.length >= 3, carousel: true, area: true },
      view_count: reusable ? (reusable.view_count || 0) : 0,
      lead_count: reusable ? (reusable.lead_count || 0) : 0,
    };

    await savePage(doc);
    await setListingPageId(body.listing_id, pageId);
    res.json({ page_id: pageId, page_url: `${PAGE_BASE_URL}/p/${pageId}` });
  } catch (err) {
    console.error("createPropertyPage failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
  }
});

// ════════════════════════ LANDING PAGE ════════════════════════

// Shared page payload — used by /api/property-page (client) and the
// server-rendered templates (nocturne/galerie/reel) via /p/:id.
function pagePayload(id, d) {
  return {
    page_id: id, status: d.status, agent: d.agent, property: d.property,
    hero: d.hero, gallery: d.gallery, carousel: d.carousel, area: d.area,
    cta: d.cta, sections: d.sections, theme: d.theme || null,
    language: d.language || "he",
  };
}

app.get("/api/property-page", async (req, res) => {
  const id = typeof req.query.id === "string" ? req.query.id : "";
  if (!id) return res.status(400).json({ error: "missing id" });
  const d = await getPage(id);
  if (!d) return res.status(404).json({ error: "not found" });
  if (d.status === "expired" || d.status === "archived") {
    res.set("Cache-Control", "public, max-age=60");
    return res.json({
      page_id: id, status: d.status,
      property: { title: d.property.title },
      agent: { name: d.agent.name, brand_name: d.agent.brand_name, phone: d.agent.phone },
      language: d.language || "he",
    });
  }
  if (d.status === "building") return res.status(404).json({ error: "not ready" });
  res.set("Cache-Control", "public, max-age=60");
  res.json(pagePayload(id, d));
});

app.post("/api/property-lead", async (req, res) => {
  const body = req.body || {};
  const prospectPhone = normalizePhone(body.phone || "");
  const name = String(body.name || "").trim().slice(0, 60);
  if (!body.page_id || !prospectPhone || name.length < 2) return res.status(400).json({ error: "invalid_input" });
  const page = await getPage(body.page_id);
  if (!page) return res.status(404).json({ error: "page_not_found" });
  if (page.status !== "active" && page.status !== "expiring") return res.status(410).json({ error: "page_inactive" });

  // simple per-prospect hourly throttle; over-limit silently accepted
  const t = mem.throttle.get(prospectPhone);
  const now = Date.now();
  const count = t && now - t.windowStart < 3600000 ? t.count : 0;
  if (count >= LEAD_MAX_PER_HOUR) return res.json({ ok: true });
  mem.throttle.set(prospectPhone, { windowStart: count === 0 ? now : t.windowStart, count: count + 1 });

  const message = String(body.message || "").trim().slice(0, 500);
  try {
    // 1) Lead doc — never downgrade a converted lead.
    const prior = db ?
      (await db.collection("leads").doc(prospectPhone).get()).data() :
      mem.leads.get(prospectPhone);
    const existingStatus = prior ? prior.status : null;
    const lead = {
      phone: prospectPhone, prospect_name: name, source: "landing_page",
      page_id: body.page_id, listing_id: page.listing_id,
      agent_phone: page.business_phone,
      ...(existingStatus === "converted" ? {} : { status: existingStatus || "new" }),
      last_activity_at: new Date(),
    };
    if (db) await db.collection("leads").doc(prospectPhone).set(lead, { merge: true });
    else mem.leads.set(prospectPhone, { ...(prior || {}), ...lead });

    // 2) Immutable per-submission record, stamped with the agent behind the page.
    const agentInfo = {
      name: (page.agent && page.agent.name) || "",
      brand_name: (page.agent && page.agent.brand_name) || "",
      phone: (page.agent && page.agent.phone) || page.business_phone,
      license: (page.agent && page.agent.license) || "",
    };
    await addLeadSubmission({
      page_id: body.page_id, listing_id: page.listing_id,
      prospect_name: name, prospect_phone: prospectPhone, message: message || null,
      source: "landing_page", property_title: (page.property && page.property.title) || "",
      agent: agentInfo, agent_phone: page.business_phone, created_at: new Date(),
    });

    // 3) Counter.
    await incrPageCounter(body.page_id, "lead_count", 1);

    sendWhatsApp(page.business_phone,
      `🔔 ליד חדש מדף הנכס "${page.property.title}"!\n👤 ${name}\n📞 0${prospectPhone.slice(3)}\n` +
      `דברו איתו עכשיו: https://wa.me/${prospectPhone}`).catch((e) => console.error("lead notify failed:", e.message));

    if (N8N_LEAD_WEBHOOK_URL) {
      fetch(N8N_LEAD_WEBHOOK_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: prospectPhone, name, message: message || null, source: "landing_page",
          page_id: body.page_id, listing_id: page.listing_id, agent_phone: page.business_phone, agent: agentInfo }),
        signal: AbortSignal.timeout(10000),
      }).catch((e) => console.error("leads-handler webhook failed:", e.message));
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("submitPropertyLead failed:", err);
    res.status(500).json({ error: "internal" });
  }
});

// ── POST /api/video-overlay — burn titles onto the last 3s of a video ──
// Body: { video_url, lines: ["4 חד׳ בבבלי | תל אביב", "₪4,900,000"] }
// Returns: { video_url } of the re-hosted, overlaid mp4.
const { overlayVideo, MAX_LINES } = require("./overlay");
app.post("/api/video-overlay", async (req, res) => {
  const body = req.body || {};
  const videoUrl = String(body.video_url || "");
  const lines = Array.isArray(body.lines) ?
    body.lines.map((l) => String(l || "").trim()).filter(Boolean) : [];
  if (!/^https?:\/\//.test(videoUrl) || lines.length < 1 || lines.length > MAX_LINES) {
    return res.status(400).json({ error: `video_url and 1-${MAX_LINES} lines required` });
  }
  try {
    const result = await overlayVideo({ videoUrl, lines, uploadDir: UPLOAD_DIR, baseUrl: BASE_URL });
    res.json(result);
  } catch (err) {
    console.error("video-overlay failed:", err.message);
    res.status(500).json({ error: "overlay_failed", detail: err.message.slice(0, 300) });
  }
});

const EVENTS = new Set(["view", "scroll_50", "scroll_90", "video_play", "cta_click"]);
app.post("/api/property-event", express.text({ type: () => true }), async (req, res) => {
  let body = {};
  try { body = typeof req.body === "string" && req.body ? JSON.parse(req.body) : (req.body || {}); } catch { /* ignore */ }
  const { page_id: pageId, event } = body;
  if (!pageId || !event || !EVENTS.has(event)) return res.status(204).send("");
  try {
    await bumpPageMetric(pageId, event);
    if (event === "view") await incrPageCounter(pageId, "view_count", 1);
  } catch (err) { console.warn("trackPropertyEvent failed:", err.message); }
  res.status(204).send("");
});

// /p/{id} → serve the landing-page shell (frontend reads id from the path)
// Server-rendered templates: nocturne/galerie/reel are their own pages, filled
// by injecting window.__PAGE__. "original" (and anything else) keeps the proven
// client-fetch shell in public-nadlan/p/index.html.
const SERVER_TEMPLATES = new Set(["nocturne", "galerie", "reel"]);
app.get("/p/:id", async (req, res) => {
  const id = req.params.id;
  const origShell = path.join(__dirname, "..", "public-nadlan", "p", "index.html");
  let d = null;
  try { d = await getPage(id); } catch (e) { /* fall back to original shell below */ }
  const tpl = d && d.theme && d.theme.template;
  // Only the new designs render server-side, and only when the page is live.
  if (!d || d.status !== "active" || !SERVER_TEMPLATES.has(tpl)) {
    return res.sendFile(origShell);
  }
  const file = path.join(TEMPLATES_DIR, tpl + ".html");
  if (!fs.existsSync(file)) return res.sendFile(origShell);
  let html = fs.readFileSync(file, "utf8");
  const inject = `<script>window.__PAGE__=${JSON.stringify(pagePayload(id, d)).replace(/</g, "\\u003c")};</script>`;
  html = html.replace("</head>", inject + "</head>");
  res.set("Cache-Control", "public, max-age=60");
  res.type("html").send(html);
});

// ════════════════════════ LIFECYCLE (expirePagesDaily) ════════════════════════
// The Cloud Functions path ran this on a 09:00 Asia/Jerusalem schedule. Here the
// server is long-running, so an hourly tick fires the sweep once per day when the
// Jerusalem hour hits 9 (reminders are idempotent via reminder_sent_at).
async function runExpirySweep() {
  const now = Date.now();
  const soon = now + REMINDER_BEFORE_DAYS * 86400000;
  let reminded = 0; let expired = 0;
  const docs = await listPagesForExpiry(soon);
  for (const d of docs) {
    const expMs = toMillis(d.expires_at);
    try {
      if (expMs < now) {
        await patchPage(d.page_id, { status: "expired", updated_at: new Date() });
        expired++;
        continue;
      }
      if (!d.reminder_sent_at) {
        const daysLeft = Math.max(1, Math.ceil((expMs - now) / 86400000));
        const link = buildExtendLink(d.page_id, expMs);
        await sendWhatsApp(d.business_phone,
          `⏳ דף הנכס "${d.property.title}" יפוג בעוד ${daysLeft} ימים.\n` +
          `להארכה בחינם (30 יום נוספים) בלחיצה אחת:\n${link}\n\n` +
          `לניהול כל הנכסים: agent.call4li.com`).catch((e) => { throw e; });
        await patchPage(d.page_id, { reminder_sent_at: new Date(), status: "expiring" });
        reminded++;
      }
    } catch (err) {
      console.error(`lifecycle failed for page ${d.page_id}:`, err.message);
    }
  }
  console.log(`expirePagesDaily: reminded=${reminded} expired=${expired}`);
}
let lastSweepDay = "";
function jerusalemParts() {
  // Hour + Y-M-D in Asia/Jerusalem without pulling a tz library.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => (fmt.find((p) => p.type === t) || {}).value;
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}
function startExpiryScheduler() {
  const tick = () => {
    const { day, hour } = jerusalemParts();
    if (hour === 9 && day !== lastSweepDay) {
      lastSweepDay = day;
      runExpirySweep().catch((e) => console.error("expiry sweep error:", e.message));
    }
  };
  setInterval(tick, 60 * 60 * 1000); // hourly
  tick();
}

app.listen(PORT, () => {
  console.log(`Forly server on ${BASE_URL} (port ${PORT})`);
  console.log(`  demo form:   ${BASE_URL}/create.html?key=demo`);
  console.log(`  pages served: ${PAGE_BASE_URL}/p/{id}`);
  console.log(`  uploads dir: ${UPLOAD_DIR}`);
  console.log(`  WW1 webhook: ${N8N_WW1_WEBHOOK_URL || "(not set)"}`);
  console.log(`  agent auth:  ${NADLAN_JWT_SECRET ? "enabled" : "DISABLED (set NADLAN_JWT_SECRET)"}`);
  startExpiryScheduler();
});
