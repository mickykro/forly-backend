/*
 * Forly intake server — standalone replacement for the Firebase Functions
 * intake path (upload URLs, demo/agent property creation, status polling).
 *
 * Design goals:
 *  - The existing public-agent frontend (create.html + api.js) works
 *    unchanged: same /api/* routes, same request/response shapes.
 *  - Photos are stored on local disk and served back at BASE_URL/files/…,
 *    so when this runs on a public host (e.g. the n8n VPS) the URLs are
 *    fetchable by n8n / Vision Tagger / Seedance with no tunnel.
 *  - Firestore (via service-account key) keeps the listing docs compatible
 *    with the n8n Property Page Builder. Without credentials it falls back
 *    to in-memory listings so the demo intake still works.
 *
 * Env:
 *  PORT                     default 8787
 *  BASE_URL                 public base of THIS server (no trailing slash);
 *                           default http://127.0.0.1:<PORT>
 *  UPLOAD_DIR               default ./data/uploads
 *  N8N_WW1_WEBHOOK_URL      WW1 gateway (photos → video pipeline)
 *  N8N_PIPELINE_WEBHOOK_URL Property Page Builder (own-video path)
 *  PAGE_BASE_URL            default https://call4li-nadlan.web.app
 *  GOOGLE_APPLICATION_CREDENTIALS  path to SA key json (enables Firestore)
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
    let val = m[2].trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = val;
  }
  console.log(`Loaded config from ${envPath}`);
})();

const PORT = Number(process.env.PORT || 8787);
const BASE_URL = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "data", "uploads");
const PAGE_BASE_URL = (process.env.PAGE_BASE_URL || "https://call4li-nadlan.web.app").replace(/\/+$/, "");
const N8N_WW1_WEBHOOK_URL = process.env.N8N_WW1_WEBHOOK_URL || "";
const N8N_PIPELINE_WEBHOOK_URL = process.env.N8N_PIPELINE_WEBHOOK_URL || "";

const MAX_UPLOAD_FILES = 12;
const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const VIDEO_TYPES = { "video/mp4": "mp4", "video/quicktime": "mp4" };
const MAX_IMAGE_MB = 10;
const MAX_VIDEO_MB = 120;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Firestore (optional) ──
let db = null;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const admin = require("firebase-admin");
  admin.initializeApp();
  db = admin.firestore();
  console.log("Firestore enabled (service account credentials found)");
} else {
  console.warn("No GOOGLE_APPLICATION_CREDENTIALS — using in-memory listings. " +
    "Status polling will only resolve if the Page Builder writes back here.");
}
const memListings = new Map(); // fallback store: listing_id → listing

async function saveListing(listing) {
  if (db) await db.collection("listings").doc(listing.listing_id).set(listing);
  else memListings.set(listing.listing_id, listing);
}

async function getListing(id) {
  if (db) {
    const doc = await db.collection("listings").doc(id).get();
    return doc.exists ? doc.data() : null;
  }
  return memListings.get(id) || null;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// ── static: the agent forms + uploaded files ──
app.use(express.static(path.join(__dirname, "..", "public-agent"), { index: "index.html" }));
app.use("/files", express.static(UPLOAD_DIR, { maxAge: "1d", immutable: true }));

// ── POST /api/upload-urls — same contract as the Cloud Function ──
// Demo auth: presence of x-demo-key header (any value), matching the
// current demo policy. Session-cookie agent auth is not implemented here.
app.post("/api/upload-urls", (req, res) => {
  if (!("x-demo-key" in req.headers)) {
    return res.status(401).json({ error: "unauthenticated" });
  }
  const files = req.body && req.body.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_UPLOAD_FILES) {
    return res.status(400).json({ error: `1-${MAX_UPLOAD_FILES} files` });
  }
  const slots = [];
  for (const f of files) {
    const ct = String((f && f.contentType) || "");
    const ext = IMAGE_TYPES[ct] || VIDEO_TYPES[ct];
    if (!ext) return res.status(400).json({ error: `unsupported type: ${ct}` });
    const isVideo = ct in VIDEO_TYPES;
    const id = crypto.randomUUID();
    const fname = `${id}.${ext}`;
    slots.push({
      name: (f && f.name) || fname,
      upload_url: `/api/upload/${fname}`,
      method: "PUT",
      content_type: ct,
      public_url: `${BASE_URL}/files/${fname}`,
      max_mb: isVideo ? MAX_VIDEO_MB : MAX_IMAGE_MB,
    });
  }
  res.json({ files: slots });
});

// ── PUT /api/upload/:fname — raw body upload to local disk ──
const rawBody = express.raw({ type: () => true, limit: `${MAX_VIDEO_MB}mb` });
app.put("/api/upload/:fname", rawBody, (req, res) => {
  const fname = req.params.fname;
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp|mp4)$/.test(fname)) {
    return res.status(400).json({ error: "bad filename" });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: "empty body" });
  }
  const isVideo = fname.endsWith(".mp4");
  if (req.body.length > (isVideo ? MAX_VIDEO_MB : MAX_IMAGE_MB) * 1024 * 1024) {
    return res.status(413).json({ error: "too large" });
  }
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), req.body);
  res.json({ ok: true });
});

// ── shared create logic (mirrors createListingAndKickPipeline) ──
async function createListing(phone, body, agentOverride) {
  if (!body.address || !body.city || !body.price || !body.rooms) {
    return { error: "address, city, price, rooms are required", code: 400 };
  }
  if (!Array.isArray(body.photos_urls) || body.photos_urls.length < 3) {
    return { error: "at least 3 photos required", code: 400 };
  }
  const listingId = crypto.randomUUID();
  const listing = {
    listing_id: listingId,
    business_phone: phone,
    source: "dashboard",
    address: String(body.address).slice(0, 120),
    neighborhood: String(body.neighborhood || "").slice(0, 60),
    city: String(body.city).slice(0, 60),
    price: Number(body.price) || 0,
    rooms: Number(body.rooms) || 0,
    size_sqm: Number(body.size_sqm) || 0,
    floor: Number(body.floor) || 0,
    parking: Number(body.parking) || 0,
    description: String(body.description || "").slice(0, 2000),
    photos_urls: body.photos_urls.slice(0, MAX_UPLOAD_FILES),
    own_video_url: body.own_video_url || null,
    status: "active",
    page_id: null,
    agent: agentOverride ? {
      name: String(agentOverride.name || ""),
      brand_name: String(agentOverride.brand_name || agentOverride.name || ""),
      logo_url: agentOverride.logo_url || null,
      tagline: String(agentOverride.tagline || ""),
      phone: String(agentOverride.phone || phone),
      license: String(agentOverride.license || ""),
    } : null,
    created_at: new Date(),
  };
  await saveListing(listing);

  const webhook = listing.own_video_url ? N8N_PIPELINE_WEBHOOK_URL : N8N_WW1_WEBHOOK_URL;
  const payload = listing.own_video_url ? {
    listing_id: listingId,
    business_phone: phone,
    video_url: listing.own_video_url,
  } : {
    phone,
    image_urls: listing.photos_urls,
    listing_id: listingId,
    trigger_source: "dashboard",
    property_details: {
      address: listing.address,
      neighborhood: listing.neighborhood,
      city: listing.city,
      price: listing.price,
      rooms: listing.rooms,
      size_sqm: listing.size_sqm,
      floor: listing.floor,
      parking: listing.parking,
      description: listing.description,
    },
  };
  if (webhook) {
    fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    }).then((r) => console.log(`pipeline webhook → ${r.status}`))
      .catch((err) => console.error("pipeline webhook failed:", err.message));
  } else {
    console.warn("no pipeline webhook configured; listing created without page build");
  }
  return { listing_id: listingId };
}

// ── POST /api/properties/demo-create — no key validation (operator demo) ──
app.post("/api/properties/demo-create", async (req, res) => {
  const body = req.body || {};
  const agentPhone = body.agent && body.agent.phone ? String(body.agent.phone) : "";
  if (!agentPhone) return res.status(400).json({ error: "agent.phone required" });
  const result = await createListing(agentPhone, body, body.agent || {});
  if (result.error) return res.status(result.code).json({ error: result.error });
  res.json({ ...result, status: "building" });
});

// ── GET /api/listing-status?id= — building-screen polling ──
app.get("/api/listing-status", async (req, res) => {
  const id = typeof req.query.id === "string" ? req.query.id : "";
  if (!id) return res.status(400).json({ error: "missing id" });
  const listing = await getListing(id);
  if (!listing) return res.status(404).json({ error: "not found" });
  res.json({
    listing_id: id,
    page_id: listing.page_id || null,
    page_url: listing.page_id ? `${PAGE_BASE_URL}/p/${listing.page_id}` : null,
  });
});

app.listen(PORT, () => {
  console.log(`Forly intake server on ${BASE_URL} (port ${PORT})`);
  console.log(`  demo form:   ${BASE_URL}/create.html?key=demo`);
  console.log(`  uploads dir: ${UPLOAD_DIR}`);
  console.log(`  WW1 webhook: ${N8N_WW1_WEBHOOK_URL || "(not set)"}`);
});
