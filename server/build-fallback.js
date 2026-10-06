/*
 * build-fallback.js — a listing whose video never arrived still gets its page.
 *
 * The walkthrough video is the fragile half of a build (a Seedance clip fails,
 * polling times out, the stitch errors). Once a listing has had no page for
 * BUILD_STUCK_MS since its last attempt, this sweep asks the n8n page builder
 * (the same webhook an agent's own video goes to) to build the page without a
 * video: the hero shows the first photo instead. If the video does land later,
 * createPropertyPage updates that same page and the video replaces the photo.
 *
 * Each listing falls back once (photo_fallback_at, claimed in a transaction so
 * staging and production, which share Firestore, never both send it). Listings
 * older than a day are left alone: they predate this and nobody is waiting.
 */
const db = require("./db");
const { lastAttemptMs, BUILD_STUCK_MS } = require("./listing-create");

const SWEEP_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function due(l, now) {
  if (!l || l.page_id || l.photo_fallback_at) return false;
  if (!Array.isArray(l.photos_urls) || !l.photos_urls.length) return false;
  const age = now - lastAttemptMs(l);
  return age > BUILD_STUCK_MS && age < MAX_AGE_MS;
}

/** One pass. deps: { pageBuilderWebhook, baseUrl, fetchFn } → listing ids sent. */
async function sweepPhotoFallback(deps, now = Date.now()) {
  const { pageBuilderWebhook, baseUrl, fetchFn = fetch } = deps;
  if (!pageBuilderWebhook) return [];
  const pending = [...await db.listPagelessListings("active"), ...await db.listPagelessListings("failed")];
  const sent = [];
  for (const l of pending) {
    if (!due(l, now)) continue;
    if (!(await db.claimField("listings", l.listing_id, "photo_fallback_at", new Date(now)))) continue;
    try {
      const r = await fetchFn(pageBuilderWebhook, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listing_id: l.listing_id, business_phone: l.business_phone, video_url: null,
          photo_only: true, language: l.language, base_url: baseUrl }),
        signal: AbortSignal.timeout(15000),
      });
      console.log(`[build-fallback] ${l.listing_id}: page without video requested → ${r.status}`);
      sent.push(l.listing_id);
    } catch (err) {
      console.error(`[build-fallback] ${l.listing_id}: request failed:`, err.message);
    }
  }
  return sent;
}

function startPhotoFallback(deps) {
  if (!deps.pageBuilderWebhook) { console.log("  photo fallback: off (no page builder webhook)"); return null; }
  return setInterval(() => sweepPhotoFallback(deps).catch((err) =>
    console.error("[build-fallback] sweep failed:", err.message)), SWEEP_MS).unref();
}

module.exports = { sweepPhotoFallback, startPhotoFallback, due };
