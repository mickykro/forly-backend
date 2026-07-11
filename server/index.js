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
const N8N_WW1_WEBHOOK_URL = process.env.N8N_WW1_WEBHOOK_URL || "";
const N8N_PIPELINE_WEBHOOK_URL = process.env.N8N_PIPELINE_WEBHOOK_URL || "";
const N8N_LEAD_WEBHOOK_URL = process.env.N8N_LEAD_WEBHOOK_URL || "";
const GREENAPI_INSTANCE = process.env.GREENAPI_INSTANCE || "";
const GREENAPI_TOKEN = process.env.GREENAPI_TOKEN || "";

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
const LEAD_MAX_PER_HOUR = 3;

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
const mem = { listings: new Map(), pages: new Map(), leads: new Map(), throttle: new Map() };

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

// ── helpers ──
const pad = (n) => String(n).padStart(2, "0");
const daysFromNow = (d) => new Date(Date.now() + d * 86400000);

// Landing-page theme: only whitelist a hex color, a short font family/token, and
// an optional custom-font URL. Returns null when nothing usable was provided.
const HEX = /^#[0-9a-fA-F]{6}$/;
function sanitizeTheme(t) {
  if (!t || typeof t !== "object") return null;
  const hex = (v) => (typeof v === "string" && HEX.test(v.trim()) ? v.trim() : null);
  const str = (v) => (typeof v === "string" ? v.slice(0, 60) : null);
  const clean = {
    font_title: str(t.font_title),
    font_body: str(t.font_body),
    font_url: typeof t.font_url === "string" && /^https?:\/\//.test(t.font_url) ? t.font_url : null,
    primary: hex(t.primary),
    accent: hex(t.accent),
  };
  return (clean.font_title || clean.font_body || clean.font_url || clean.primary || clean.accent) ? clean : null;
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

// ════════════════════════════ INTAKE ════════════════════════════

app.post("/api/upload-urls", (req, res) => {
  if (!("x-demo-key" in req.headers)) return res.status(401).json({ error: "unauthenticated" });
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
      public_url: `${BASE_URL}/files/${fname}`,
      max_mb: isVideo ? MAX_VIDEO_MB : isFont ? MAX_FONT_MB : MAX_IMAGE_MB,
    });
  }
  res.json({ files: slots });
});

const rawBody = express.raw({ type: () => true, limit: `${MAX_VIDEO_MB}mb` });
app.put("/api/upload/:fname", rawBody, (req, res) => {
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
    created_at: new Date(),
  };
  await saveListing(listing);

  const webhook = listing.own_video_url ? N8N_PIPELINE_WEBHOOK_URL : N8N_WW1_WEBHOOK_URL;
  const payload = listing.own_video_url ? {
    listing_id: listingId, business_phone: phone, video_url: listing.own_video_url,
  } : {
    phone, image_urls: listing.photos_urls, listing_id: listingId, trigger_source: "dashboard",
    property_details: {
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
    const pageId = reusable ? reusable.page_id : crypto.randomUUID();
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
    });
  }
  if (d.status === "building") return res.status(404).json({ error: "not ready" });
  res.set("Cache-Control", "public, max-age=60");
  res.json({
    page_id: id, status: d.status, agent: d.agent, property: d.property,
    hero: d.hero, gallery: d.gallery, carousel: d.carousel, area: d.area,
    cta: d.cta, sections: d.sections, theme: d.theme || null,
  });
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

  try {
    const lead = {
      phone: prospectPhone, prospect_name: name, source: "landing_page",
      page_id: body.page_id, listing_id: page.listing_id,
      agent_phone: page.business_phone, status: "new", last_activity_at: new Date(),
    };
    if (db) await db.collection("leads").doc(prospectPhone).set(lead, { merge: true });
    else mem.leads.set(prospectPhone, lead);
    await incrPageCounter(body.page_id, "lead_count", 1);

    sendWhatsApp(page.business_phone,
      `🔔 ליד חדש מדף הנכס "${page.property.title}"!\n👤 ${name}\n📞 0${prospectPhone.slice(3)}\n` +
      `דברו איתו עכשיו: https://wa.me/${prospectPhone}`).catch((e) => console.error("lead notify failed:", e.message));

    if (N8N_LEAD_WEBHOOK_URL) {
      fetch(N8N_LEAD_WEBHOOK_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: prospectPhone, name, source: "landing_page",
          page_id: body.page_id, listing_id: page.listing_id, agent_phone: page.business_phone }),
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
  try { if (event === "view") await incrPageCounter(pageId, "view_count", 1); }
  catch (err) { console.warn("trackPropertyEvent failed:", err.message); }
  res.status(204).send("");
});

// /p/{id} → serve the landing-page shell (frontend reads id from the path)
app.get("/p/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public-nadlan", "p", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Forly server on ${BASE_URL} (port ${PORT})`);
  console.log(`  demo form:   ${BASE_URL}/create.html?key=demo`);
  console.log(`  pages served: ${PAGE_BASE_URL}/p/{id}`);
  console.log(`  uploads dir: ${UPLOAD_DIR}`);
  console.log(`  WW1 webhook: ${N8N_WW1_WEBHOOK_URL || "(not set)"}`);
});
