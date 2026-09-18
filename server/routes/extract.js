/*
 * routes/extract.js — "paste text or a link, Forly fills the form".
 * Handles: POST /api/properties/extract, POST /api/photos/import-url
 *
 * Auth mirrors the upload routes: an x-demo-key header passes (the demo
 * wizard has no login), otherwise a signed session. The Facebook source needs
 * a real user (its Page token), so demo callers get facebook_not_connected.
 */
const express = require("express");
const crypto = require("crypto");
const { parseListing, MAX_INPUT } = require("../listing-extract");
const { resolve, isPublicUrl, TIMEOUT_MS } = require("../listing-sources");
const { storeBuffer } = require("../upload-store");
const { REVIEW_SCOPES } = require("../auth");

const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DAILY_CAP = 30;

const STATUS = { invalid_input: 400, facebook_not_connected: 409, page_unreadable: 422, extract_limit: 429, extract_unavailable: 503 };
function statusFor(code) { return STATUS[code] || 500; }

function validateBody(body) {
  const b = body || {};
  const text = typeof b.text === "string" ? b.text.trim() : "";
  const url = typeof b.url === "string" ? b.url.trim() : "";
  if ((text && url) || (!text && !url)) return null;
  if (text) return { text: text.slice(0, MAX_INPUT) };
  try { new URL(url); } catch (e) { return null; }
  return { url };
}

// ponytail: in-process counter, approximate across Cloud Run instances.
// Move to a Firestore counter if abuse ever shows up.
class DailyLimit {
  constructor(cap) { this.cap = cap; this.counts = new Map(); }
  take(key, now = new Date()) {
    const k = `${key}|${now.toISOString().slice(0, 10)}`;
    const n = (this.counts.get(k) || 0) + 1;
    if (n > this.cap) return false;
    this.counts.set(k, n);
    if (this.counts.size > 5000) this.counts.clear();
    return true;
  }
}

function sniffImage(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.slice(0, 4).toString("hex") === "89504e47") return "image/png";
  if (b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}

async function importImage(url, { fetchFn = fetch, lookup } = {}) {
  const fail = (code, msg) => { const e = new Error(msg || code); e.code = code; return e; };
  if (!(await isPublicUrl(url, lookup))) throw fail("invalid_input", "url not allowed");
  let r;
  try { r = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" }); }
  catch (err) { throw fail("page_unreadable", err.message); }
  if (!r.ok) throw fail("page_unreadable", `fetch ${r.status}`);
  let ct = String(r.headers.get("content-type") || "").split(";")[0].trim();
  // WhatsApp media (Green API's store) comes back as octet-stream: trust the bytes then.
  const generic = !ct || /^(application|binary)\/octet-stream$/.test(ct);
  if (!IMAGE_TYPES[ct] && !generic) throw fail("page_unreadable", `not an image: ${ct}`);
  const buffer = Buffer.from(await r.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw fail("page_unreadable", "bad size");
  if (!IMAGE_TYPES[ct]) ct = sniffImage(buffer);
  if (!ct) throw fail("page_unreadable", "not an image: octet-stream");
  return { fname: `${crypto.randomUUID()}.${IMAGE_TYPES[ct]}`, buffer, contentType: ct };
}

module.exports = function createExtractRouter(ctx) {
  const { requireAuth, authSecret, uploadDir, uploadPublicBase, remoteUploadBase } = ctx;
  const router = express.Router();
  const limit = new DailyLimit(DAILY_CAP);

  function auth(req, res, next) {
    if ("x-demo-key" in req.headers) return next();
    return requireAuth(authSecret, REVIEW_SCOPES)(req, res, next);
  }
  const keyFor = (req) => (req.user && req.user.userId) || `demo:${req.ip}`;
  const sendError = (res, err) => {
    const code = err.code || "internal";
    if (!err.code) console.error("[extract]", err);
    res.status(statusFor(code)).json({ error: code });
  };

  router.post("/properties/extract", auth, async (req, res) => {
    const input = validateBody(req.body);
    if (!input) return res.status(400).json({ error: "invalid_input" });
    if (!limit.take(keyFor(req))) return res.status(429).json({ error: "extract_limit" });
    try {
      const src = await resolve({ ...input, userId: req.user && req.user.userId });
      const { fields, missing } = await parseListing(src.text);
      console.log(`[extract] fields ${JSON.stringify(fields)} missing ${missing.join(",")}`);
      res.json({ source: src.source, fields, missing, description: src.description.slice(0, 2000), photos: src.photos });
    } catch (err) { sendError(res, err); }
  });

  router.post("/photos/import-url", auth, async (req, res) => {
    const url = req.body && typeof req.body.url === "string" ? req.body.url.trim() : "";
    if (!url) return res.status(400).json({ error: "invalid_input" });
    try {
      const img = await importImage(url);
      await storeBuffer(img, { uploadDir, remoteUploadBase, req });
      res.json({ url: `${uploadPublicBase}/files/${img.fname}` });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      sendError(res, err);
    }
  });

  return router;
};

module.exports.importImage = importImage;
module.exports.DailyLimit = DailyLimit;
module.exports._test = { validateBody, statusFor, DailyLimit, importImage, IMAGE_TYPES };
