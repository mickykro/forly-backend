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
const { isPublicUrl, TIMEOUT_MS } = require("../listing-sources");
const { storeBuffer } = require("../upload-store");
const { REVIEW_SCOPES } = require("../auth");

const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// The agent's own walkthrough video sent in chat (same cap as the create form's upload).
const VIDEO_TYPES = { "video/mp4": "mp4", "video/quicktime": "mp4" };
const MAX_VIDEO_BYTES = 120 * 1024 * 1024;
const DAILY_CAP = 30;
// A browser scrape is a whole Chrome instance plus metered bandwidth, where a
// firecrawl scrape is one HTTP call. Same abuse surface, very different cost.
const DRIVER_DAILY_CAP = 10;

const STATUS = {
  invalid_input: 400, facebook_not_connected: 409, social_login_required: 409, login_required_for_browser: 409,
  page_unreadable: 422, extract_limit: 429, extract_unavailable: 503,
};
function statusFor(code) { return STATUS[code] || 500; }
const fail = (code, msg) => { const e = new Error(msg || code); e.code = code; return e; };

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
  if (b.slice(4, 8).toString() === "ftyp") return "video/mp4";
  return null;
}

// { video: true } accepts an mp4/mov instead of an image.
async function importImage(url, { fetchFn = fetch, lookup, video = false } = {}) {
  const TYPES = video ? VIDEO_TYPES : IMAGE_TYPES;
  const fail = (code, msg) => { const e = new Error(msg || code); e.code = code; return e; };
  if (!(await isPublicUrl(url, lookup))) throw fail("invalid_input", "url not allowed");
  let r;
  try { r = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" }); }
  catch (err) { throw fail("page_unreadable", err.message); }
  if (!r.ok) throw fail("page_unreadable", `fetch ${r.status}`);
  let ct = String(r.headers.get("content-type") || "").split(";")[0].trim();
  // WhatsApp media (Green API's store) comes back as octet-stream: trust the bytes then.
  const generic = !ct || /^(application|binary)\/octet-stream$/.test(ct);
  if (!TYPES[ct] && !generic) throw fail("page_unreadable", `not an image: ${ct}`);
  const buffer = Buffer.from(await r.arrayBuffer());
  if (!buffer.length || buffer.length > (video ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES)) throw fail("page_unreadable", "bad size");
  if (!TYPES[ct]) ct = sniffImage(buffer);
  if (!TYPES[ct]) throw fail("page_unreadable", `not an image: ${ct || "octet-stream"}`);
  return { fname: `${crypto.randomUUID()}.${TYPES[ct]}`, buffer, contentType: ct };
}

// One persisted browser profile per agent per platform, shared with
// routes/connections-browser.js (the login browser) — see profile-name.js.
const profileFor = require("../profile-name").profileName;

module.exports = function createExtractRouter(ctx) {
  const { requireAuth, authSecret, uploadDir, uploadPublicBase, remoteUploadBase } = ctx;
  const resolve = ctx.resolve || require("../listing-sources").resolve;
  const database = ctx.db || require("../db");
  const extractJobs = ctx.extractJobs || require("../extract-jobs");
  const jobDeps = ctx.jobDeps || require("../extract-jobs").liveDeps();
  // The same decision index.js makes at boot: key, PROFILE_KEY and FORLY_ENV.
  const driverEnabled = ctx.driverEnabled !== undefined ? ctx.driverEnabled : require("../driver-browser").driverEnabled();
  const { sourceFor } = require("../listing-sources")._test;
  const router = express.Router();
  const limit = new DailyLimit(DAILY_CAP);
  const driverLimit = new DailyLimit(DRIVER_DAILY_CAP);

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
    const phone = keyFor(req);
    try {
      // Driver-routed hosts never try firecrawl: we already know it cannot read them.
      const kind = input.text ? "text" : sourceFor(input);

      async function queueDriverJob(forceSource, withProfile) {
        if (!driverEnabled) throw fail("extract_unavailable", "Driver is not configured");
        // A browser session is a paid resource and, for social hosts, opens the
        // customer's own logged-in profile. Demo callers get neither.
        if (!req.user) throw fail("login_required_for_browser");
        if (!driverLimit.take(phone)) throw fail("extract_limit");
        // The profile's current generation (I2): after a reconnect the gen-0 name is refused.
        let profileName = withProfile ? profileFor(input.url, phone) : null; // null: not a social host
        if (profileName) {
          const conn = (await database.getConnection(phone)) || {};
          const platform = profileName.split("-")[0];
          profileName = profileFor(input.url, phone, conn[`${platform}_profile_gen`] || 0);
        }
        const job = await extractJobs.create({ phone, url: input.url, forceSource, profileName }, jobDeps);
        return { job_id: job.id, status: job.status };
      }

      if (kind === "driver") return res.status(202).json(await queueDriverJob(null, true));

      let src;
      try {
        src = await resolve({ ...input, userId: req.user && req.user.userId });
      } catch (err) {
        // "or if firecrawl returns an error": a browser is the next thing to try —
        // but only when firecrawl actually failed to READ the page. A missing key
        // (extract_unavailable) or a bad URL (invalid_input) is not that. And the
        // fallback never carries a profile: an arbitrary URL must not be opened in
        // a browser that holds the customer's Facebook cookies.
        if (kind === "scrape" && err.code === "page_unreadable") {
          return res.status(202).json(await queueDriverJob("driver", false));
        }
        throw err;
      }
      const { fields, missing } = await parseListing(src.text);
      const result = { source: src.source, fields, missing, description: src.description.slice(0, 2000), photos: src.photos };
      console.log("[extract] scan result:", JSON.stringify(result, null, 2));
      res.json(result);
    } catch (err) { sendError(res, err); }
  });

  // Poll target for a queued browser scrape. A job that belongs to someone else
  // answers exactly like one that does not exist — an agent must not be able to
  // probe for other agents' job ids.
  router.get("/properties/extract/:job_id", requireAuth(authSecret), async (req, res) => {
    const job = await database.getExtractJob(String(req.params.job_id)).catch(() => null);
    if (!job || job.phone !== req.user.userId) return res.status(404).json({ error: "not_found" });
    const out = { status: job.status };
    if (job.status === "done" && job.result) {
      out.source = job.result.source;
      out.fields = job.result.fields;
      out.missing = job.result.missing;
      out.description = job.result.description;
      out.photos = job.result.photos;
    }
    if (job.status === "failed") out.error_code = job.error_code;
    return res.json(out);
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
module.exports._test = { validateBody, statusFor, DailyLimit, importImage, IMAGE_TYPES, profileFor };
