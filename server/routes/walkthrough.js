/*
 * routes/walkthrough.js — POST /api/walkthrough/plan, called by the n8n
 * walkthrough workflow right after the quota check.
 *
 * Takes the listing photos (image_urls), maps them into spaces (one vision
 * call) and returns the Seedance clips — prompt, reference images and duration
 * per clip — plus the end titles. n8n-only (x-forly-secret): it spends a vision
 * call per request.
 */

const express = require("express");
const db = require("../db");
const { constantTimeEqual } = require("../security");
const { mapSpaces, MAX_PHOTOS } = require("../space-map");
const { planWalkthrough } = require("../walkthrough-plan");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { videoRef, REF_MAX_SIDE } = require("../photo-orient");
const { assertPublicHttpUrl, storeBuffer, ownUploadedVideo } = require("../utils");
const { writeScript } = require("../reel-script");
const reel = require("../reel");

const HEAD_BYTES = 128 * 1024; // EXIF sits at the start of a JPEG
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;

async function fetchBytes(url, range) {
  const safe = await assertPublicHttpUrl(url);
  const resp = await fetch(safe, { signal: AbortSignal.timeout(30000), redirect: "error",
    headers: range ? { Range: `bytes=0-${HEAD_BYTES - 1}` } : {} });
  if (!resp.ok) throw new Error(`photo fetch ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > MAX_PHOTO_BYTES) throw new Error("photo too large");
  return { buf, partial: resp.status === 206 };
}

/*
 * Seedance gets its own copy of every photo: upright (it ignores EXIF rotation,
 * which made rooms come out sideways), the long side at most 1280 px, a plain
 * JPEG. The page gallery keeps the originals. The copy's name is derived from
 * the source URL, so a re-plan reuses it instead of making it again; a photo
 * that cannot be fetched or converted is sent as it is.
 * → { refs, uprighted }. store(buf, fname) hosts a copy and returns its URL;
 * existing(fname) returns the URL of an already-made copy, or null.
 */
const refName = (url) => {
  const h = crypto.createHash("sha1").update(`${url}|${REF_MAX_SIDE}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}.jpg`;
};

async function shrinkPhotos(tags, { store, existing = () => null, get = fetchBytes }) {
  let refs = 0, uprighted = 0;
  const one = async (t) => {
    try {
      const fname = refName(t.url);
      const have = existing(fname);
      if (have) { t.url = have; refs++; return; }
      const { buf } = await get(t.url, false);
      const ref = await videoRef(buf);
      t.url = await store(ref.buffer, fname);
      refs++;
      if (ref.orientation !== 1) uprighted++;
    } catch (err) {
      console.warn("walkthrough: video copy failed, photo used as is:", err.message);
    }
  };
  for (let i = 0; i < tags.length; i += 6) await Promise.all(tags.slice(i, i + 6).map(one));
  return { refs, uprighted };
}

module.exports = function createWalkthroughRouter({ n8nSecret, uploadDir, baseUrl, storeOpts = {} }) {
  const router = express.Router();

  function requireN8n(req, res, next) {
    if (!n8nSecret) return res.status(503).json({ error: "n8n_secret_not_configured" });
    if (!constantTimeEqual(req.get("x-forly-secret"), n8nSecret)) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  }

  // Where the Seedance copies live: this server's /files (relayed to the shared
  // store when one is configured, like every upload).
  const publicBase = (storeOpts.remoteUploadBase && storeOpts.uploadPublicBase) || baseUrl;
  const refStore = {
    store: (buf, fname) => storeBuffer(buf, "jpg", uploadDir, baseUrl, { ...storeOpts, fname }).then((r) => r.url),
    existing: (fname) => (fs.existsSync(path.join(uploadDir, fname)) ? `${publicBase}/files/${fname}` : null),
  };

  // ── POST /refs: Seedance copies for a workflow that plans its own clips (V2) ──
  // { image_urls: [...] } → { image_urls: [...] }, same order; a photo that
  // cannot be converted comes back unchanged.
  router.post("/refs", requireN8n, async (req, res) => {
    const urls = (Array.isArray(req.body && req.body.image_urls) ? req.body.image_urls : [])
      .map((u) => String(u || "").trim()).filter((u) => /^https?:\/\//.test(u)).slice(0, MAX_PHOTOS);
    if (!urls.length) return res.status(400).json({ error: "image_urls required" });
    if (!uploadDir) return res.json({ image_urls: urls, ref_photos: 0 });
    const tags = urls.map((url) => ({ url }));
    const shrunk = await shrinkPhotos(tags, refStore);
    res.json({ image_urls: tags.map((t) => t.url), ref_photos: shrunk.refs, uprighted_photos: shrunk.uprighted });
  });

  router.post("/plan", requireN8n, async (req, res) => {
    const body = { ...(req.body || {}) };
    // page_id: re-make the video of an existing page from its own photos,
    // details and agent (WW1 V4). Explicit fields in the body still win.
    const page = typeof body.page_id === "string" && body.page_id ? await db.getPage(body.page_id.slice(0, 100)).catch(() => null) : null;
    if (body.page_id && !page) return res.status(404).json({ error: "page not found" });
    if (page) {
      if (!Array.isArray(body.image_urls) || !body.image_urls.length) body.image_urls = ((page.gallery && page.gallery.images) || []).map((g) => g.url);
      if (!body.property_details) body.property_details = page.property || {};
      if (!body.listing_id && page.listing_id) body.listing_id = page.listing_id;
    }
    const model = body.model === "h3" ? "h3" : "seedance";
    // image_urls: plain strings, {url} or Firestore {stringValue}. `tags` (the
    // old Vision Tagger output) is still accepted; its scores are used only
    // where the space map gives none.
    const urlOf = (u) => (typeof u === "string" ? u : u && (u.url || u.stringValue)) || "";
    const raw = Array.isArray(body.tags) && body.tags.length ? body.tags : (Array.isArray(body.image_urls) ? body.image_urls : []);
    const tags = raw
      .map((t) => ({ t: t && typeof t === "object" ? t : {}, url: String(urlOf(t)).trim() }))
      .filter(({ url }) => /^https?:\/\//.test(url))
      .slice(0, MAX_PHOTOS)
      .map(({ t, url }) => ({
        url,
        room_type: typeof t.room_type === "string" ? t.room_type.slice(0, 40) : "",
        quality_score: typeof t.quality_score === "number" && Number.isFinite(t.quality_score) ? t.quality_score : null,
        is_real_estate: t.is_real_estate !== false,
      }));
    if (!tags.length) return res.status(400).json({ error: "image_urls (or tags with url) required" });
    const details = body.property_details && typeof body.property_details === "object" ? body.property_details : {};
    const listingId = typeof body.listing_id === "string" ? body.listing_id.slice(0, 100) : "";

    const shrunk = uploadDir ? await shrinkPhotos(tags, refStore) : { refs: 0, uprighted: 0 };
    const { map, debug } = await mapSpaces(tags);
    let plan;
    try {
      plan = planWalkthrough(map, tags, details, undefined, model);
    } catch (err) {
      if (err.code === "too_few_photos") return res.status(422).json({ error: err.message, map_debug: debug });
      console.error("walkthrough plan failed:", err.message);
      return res.status(500).json({ error: "plan_failed" });
    }
    // Kept with the listing so an odd video can be traced back to its map.
    if (listingId) {
      try {
        if (await db.getListing(listingId)) {
          await db.updateListing(listingId, { space_map: { ...map, debug, planned_at: new Date() } });
        }
      } catch (err) {
        console.warn("walkthrough: saving space map failed:", err.message);
      }
    }
    // The narrated reel's words (WW1 V4): one Claude call, template fallback.
    let script;
    if (body.script) {
      let agent = body.agent && typeof body.agent === "object" ? body.agent : page && page.agent;
      if (!agent && body.phone) {
        const biz = await db.getBusiness(String(body.phone)).catch(() => null);
        agent = biz ? { name: biz.full_name, brand_name: biz.business_name, phone: body.phone } : null;
      }
      script = await writeScript({ clips: plan.clips, spaces: map.spaces, details, agent: agent || {} });
    }
    res.json({ ...plan, ...(script ? { script } : {}), ...(page ? { page_id: page.page_id || body.page_id } : {}),
      end_bg_image_url: tags[0] && tags[0].url, space_map: map, map_debug: debug, ref_photos: shrunk.refs, uprighted_photos: shrunk.uprighted });
  });

  // ── narrated reel (WW1 V4): n8n submits, polls, then renders ──
  const fail = (res, where) => (err) => {
    console.error(`walkthrough ${where} failed:`, err.message);
    res.status(502).json({ error: `${where}_failed`, detail: err.message.slice(0, 300) });
  };
  const validClips = (clips) => Array.isArray(clips) && clips.length >= 1 && clips.length <= 6 && clips.every((c) =>
    c && typeof c.prompt === "string" && c.prompt.length <= 2000 && Number.isInteger(c.duration) && c.duration >= 5 && c.duration <= 15 &&
    Array.isArray(c.image_urls) && c.image_urls.length >= 1 && c.image_urls.every((u) => /^https:\/\//.test(String(u))));

  // { clips } (from /plan with model "h3") → { requests } to poll
  router.post("/reel/clips", requireN8n, async (req, res) => {
    const clips = req.body && req.body.clips;
    if (!validClips(clips)) return res.status(400).json({ error: "clips: 1-6 of {prompt, duration 5-15, image_urls}" });
    reel.submitClips(clips).then((requests) => res.json({ requests }), fail(res, "reel_clips"));
  });

  // { requests } → { all_complete, failed, statuses, video_urls }
  router.post("/reel/status", requireN8n, async (req, res) => {
    const requests = req.body && req.body.requests;
    if (!Array.isArray(requests) || !requests.length || requests.length > 6) return res.status(400).json({ error: "requests required" });
    reel.clipStatus(requests).then((r) => res.json(r), fail(res, "reel_status"));
  });

  // Renders by request body. A retry of a render still running joins it, and one
  // that finished in the last RENDER_KEEP_MS gets its result, so a timed-out n8n
  // call never pays fal or ffmpeg twice. At most RENDER_MAX different renders at
  // once (each is minutes of ffmpeg); past that, 429. In memory: one container.
  const renders = new Map(); // key → { promise, done }
  const RENDER_MAX = Math.max(1, Number(process.env.REEL_RENDER_MAX) || 2);
  const RENDER_KEEP_MS = 30 * 60 * 1000;

  // { clips, clip_urls, script, end_bg_image_url } → voice + music on fal, then the four files
  router.post("/reel/render", requireN8n, async (req, res) => {
    const b = req.body || {};
    const urls = Array.isArray(b.clip_urls) ? b.clip_urls.map(String) : [];
    const lines = b.script && Array.isArray(b.script.lines) ? b.script.lines : [];
    if (!validClips(b.clips) || urls.length !== b.clips.length || lines.length !== urls.length ||
      !urls.every((u) => /^https:\/\//.test(u)) || !/^https:\/\//.test(String(b.end_bg_image_url || ""))) {
      return res.status(400).json({ error: "clips, clip_urls, script.lines (same length) and end_bg_image_url required" });
    }
    if (!uploadDir) return res.status(503).json({ error: "no upload dir" });
    const key = crypto.createHash("sha256").update(JSON.stringify([b.clips, urls, b.script, b.end_bg_image_url])).digest("hex");
    for (const [k, r] of renders) if (r.done && Date.now() - r.done > RENDER_KEEP_MS) renders.delete(k);
    let job = renders.get(key);
    if (!job) {
      if ([...renders.values()].filter((r) => !r.done).length >= RENDER_MAX) {
        return res.status(429).set("Retry-After", "60").json({ error: "reel_render_busy" });
      }
      job = { done: 0, promise: (async () => {
        const [narrationUrls, musicUrl] = await Promise.all([
          Promise.all(lines.map((l) => reel.tts(String(l.narration || "").slice(0, 400)))),
          reel.music(String(b.script.music_prompt || "").slice(0, 600) || "Warm uplifting instrumental background music, no vocals"),
        ]);
        const store = (buf) => storeBuffer(buf, "mp4", uploadDir, baseUrl, storeOpts).then((r) => r.url);
        return reel.renderReel({ clips: b.clips, clipUrls: urls, script: b.script, narrationUrls, musicUrl,
          endBgUrl: b.end_bg_image_url, store });
      })() };
      renders.set(key, job);
      job.promise.then(() => { job.done = Date.now(); }, () => renders.delete(key)); // a failed render is tried afresh
    }
    job.promise.then((out) => res.json(out), fail(res, "reel_render"));
  });

  // { page_id, video_url, narration_url, music_url, post_video_url? } → the page plays the new reel.
  // Only our own /files uploads are accepted.
  router.post("/reel/page-media", requireN8n, async (req, res) => {
    const b = req.body || {};
    const bases = [storeOpts.uploadPublicBase, baseUrl, storeOpts.remoteUploadBase];
    const own = (u) => ownUploadedVideo(u, bases);
    const pageId = String(b.page_id || "").slice(0, 100);
    if (!pageId || !own(b.video_url) || !own(b.narration_url) || !own(b.music_url) || (b.post_video_url && !own(b.post_video_url))) {
      return res.status(400).json({ error: "page_id and our own video_url, narration_url, music_url required" });
    }
    const pageDoc = await db.getPage(pageId).catch(() => null);
    if (!pageDoc) return res.status(404).json({ error: "page not found" });
    const patch = { "hero.video_url": b.video_url, "hero.narration_url": b.narration_url, "hero.music_url": b.music_url, updated_at: new Date() };
    if (b.post_video_url) patch["hero.promo_video_url"] = b.post_video_url;
    db.updatePage(pageId, patch).then(() => res.json({ ok: true, page_id: pageId }), fail(res, "page_media"));
  });

  return router;
};
module.exports.shrinkPhotos = shrinkPhotos;
module.exports.refName = refName;
