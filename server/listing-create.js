/*
 * listing-create.js — the one place a listing is born.
 *
 * Shared by the create form (routes/intake.js) and the WhatsApp intake
 * (whatsapp-intake.js): validate, persist, kick the n8n page pipeline.
 * Validation is separate so a quota unit is only consumed for a request that
 * would actually create something (a 400 must not burn a paid creation).
 */
const crypto = require("crypto");
const db = require("./db");
const { sanitizeTheme, sanitizeLang } = require("./utils");
const { sanitizeTags } = require("./tags");
const { normalizeCurrency } = require("./currency");

const MAX_PHOTOS = 54; // walkthrough: up to 6 clips × 9 reference photos
// ponytail: dev only (N8N_DEV_* webhooks set) — chat/review listings reuse the last
// generated walkthrough (served from this server's /files) instead of paying for a
// new one. Production never takes this path. An agent's own video still wins.
const TEST_VIDEO_PATH = "/files/pages/krvytvrv-nksym-rwwx6/walkthrough.mp4";
const MIN_PHOTOS = 3;

function validateListing(body) {
  // Address is intentionally not required: scraped listings routinely omit
  // the exact street address (agent privacy) and still make a good page.
  if (!body.city || !body.price || !body.rooms) {
    return { error: "city, price, rooms are required", code: 400 };
  }
  if (!Array.isArray(body.photos_urls) || body.photos_urls.length < MIN_PHOTOS) {
    return { error: `at least ${MIN_PHOTOS} photos required`, code: 400 };
  }
  return null;
}

/*
 * createListing(phone, body, agentOverride, deps) → { listing_id } | { error, code }
 * deps: { n8nWw1Webhook, n8nPipelineWebhook, isDevRun, isDevPipelineRun, baseUrl,
 *         source = "dashboard", fetchFn = fetch }
 * `source` is stamped on the listing doc only ("dashboard" | "whatsapp").
 * The n8n payload keeps trigger_source "dashboard": WW1 treats both the same
 * (a page built from photos + details), and its end hook WhatsApps the agent
 * the page link either way.
 */
async function createListing(phone, body, agentOverride, deps) {
  const { n8nWw1Webhook, n8nPipelineWebhook, isDevRun, isDevPipelineRun, baseUrl,
    source = "dashboard", fetchFn = fetch } = deps;
  const invalid = validateListing(body);
  if (invalid) return invalid;
  if ((isDevRun || isDevPipelineRun) && source === "whatsapp" && !body.own_video_url && baseUrl) {
    body = { ...body, own_video_url: baseUrl + TEST_VIDEO_PATH };
  }
  const listingId = crypto.randomUUID();
  const listing = {
    listing_id: listingId, business_phone: phone, source,
    address: String(body.address || "").slice(0, 120),
    neighborhood: String(body.neighborhood || "").slice(0, 60),
    city: String(body.city).slice(0, 60),
    listing_type: body.listing_type === "rent" ? "rent" : "sale",
    price: Number(body.price) || 0, currency: normalizeCurrency(body.currency) || "ILS",
    rooms: Number(body.rooms) || 0,
    size_sqm: Number(body.size_sqm) || 0, floor: Number(body.floor) || 0,
    size_built: Number(body.size_built) || 0,
    size_balcony: Number(body.size_balcony) || 0,
    size_garden: Number(body.size_garden) || 0,
    size_plot: Number(body.size_plot) || 0,
    parking: Number(body.parking) || 0,
    storage: !!body.storage,
    elevator: !!body.elevator || !!body.shabbat_elevator,
    shabbat_elevator: !!body.shabbat_elevator,
    tags: sanitizeTags(body.tags),
    description: String(body.description || "").slice(0, 2000),
    photos_urls: body.photos_urls.slice(0, MAX_PHOTOS),
    own_video_url: body.own_video_url || null,
    status: "active", page_id: null,
    // Set when create.html?draft=<id> submits — lets the page-creation
    // handler (routes/pages.js) mark the listing-sweep draft "created".
    listing_draft_id: body.listing_draft_id ? String(body.listing_draft_id).slice(0, 200) : null,
    agent: agentOverride ? {
      name: String(agentOverride.name || ""),
      brand_name: String(agentOverride.brand_name || agentOverride.name || ""),
      logo_url: agentOverride.logo_url || null,
      tagline: String(agentOverride.tagline || ""),
      phone: String(agentOverride.phone || phone),
      phone2: agentOverride.phone2
        ? String(agentOverride.phone2).replace(/\D/g, "").slice(0, 15) || null
        : null,
      license: String(agentOverride.license || ""),
    } : null,
    agent2: body.agent2 && body.agent2.name && body.agent2.phone ? {
      name: String(body.agent2.name).slice(0, 60),
      phone: String(body.agent2.phone).replace(/\D/g, "").slice(0, 15),
    } : null,
    theme: sanitizeTheme(body.theme),
    language: sanitizeLang(body.language),
    created_at: new Date(),
  };
  await db.saveListing(listing);
  kickPipeline(listing, { n8nWw1Webhook, n8nPipelineWebhook, isDevRun, isDevPipelineRun, baseUrl, fetchFn });
  return { listing_id: listingId };
}

// Fire the n8n page pipeline for a saved listing. Everything it needs lives on
// the listing doc, so a retry replays exactly what the first attempt sent.
function kickPipeline(listing, deps) {
  const { n8nWw1Webhook, n8nPipelineWebhook, isDevRun, isDevPipelineRun, baseUrl, fetchFn = fetch } = deps;
  const listingId = listing.listing_id, phone = listing.business_phone;
  const webhook = listing.own_video_url ? n8nPipelineWebhook : n8nWw1Webhook;
  const payload = listing.own_video_url ? {
    listing_id: listingId, business_phone: phone, video_url: listing.own_video_url,
    language: listing.language, dev: !!isDevPipelineRun, base_url: baseUrl,
  } : {
    phone, image_urls: listing.photos_urls, listing_id: listingId, trigger_source: "dashboard",
    language: listing.language, dev: !!isDevRun, base_url: baseUrl,
    property_details: {
      listing_type: listing.listing_type,
      address: listing.address, neighborhood: listing.neighborhood, city: listing.city,
      price: listing.price, currency: listing.currency, rooms: listing.rooms, size_sqm: listing.size_sqm,
      size_built: listing.size_built, size_balcony: listing.size_balcony,
      size_garden: listing.size_garden, size_plot: listing.size_plot,
      floor: listing.floor, parking: listing.parking,
      storage: listing.storage, elevator: listing.elevator,
      shabbat_elevator: listing.shabbat_elevator,
      description: listing.description,
    },
  };
  if (webhook) {
    fetchFn(webhook, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
    }).then((r) => console.log(`pipeline webhook → ${r.status}`))
      .catch((err) => console.error("pipeline webhook failed:", err.message));
  }
}

/*
 * Retry a build that never produced a page. The listing (details, photos,
 * agent, theme) is all still stored, so this replays the same pipeline call —
 * no new upload, no new quota unit. Capped, since each run costs real money.
 */
const BUILD_STUCK_MS = 20 * 60 * 1000; // no page this long after an attempt = failed
const MAX_RETRIES = 3;
const asMs = (v) => (v && v.toMillis ? v.toMillis() : v ? new Date(v).getTime() : 0);
const lastAttemptMs = (l) => asMs(l.retried_at || l.created_at);

function buildFailed(l, now = Date.now()) {
  if (!l || l.page_id) return false;
  if (l.status === "failed") return true;
  return l.status === "active" && now - lastAttemptMs(l) > BUILD_STUCK_MS;
}

function retryBlocked(l, now = Date.now()) {
  if (!l) return "not_found";
  if (l.page_id) return "already_built";
  if (!buildFailed(l, now)) return "still_building";
  if ((l.retry_count || 0) >= MAX_RETRIES) return "retry_limit";
  return null;
}

async function retryListing(listing, deps, now = new Date()) {
  // photo_fallback_at reset: if this attempt fails too, it may fall back again.
  const patch = { status: "active", retried_at: now, retry_count: (listing.retry_count || 0) + 1, photo_fallback_at: null };
  await db.updateListing(listing.listing_id, patch);
  kickPipeline({ ...listing, ...patch }, deps);
  return patch;
}

module.exports = { validateListing, createListing, kickPipeline, buildFailed, retryBlocked, retryListing,
  lastAttemptMs, MAX_PHOTOS, MIN_PHOTOS, MAX_RETRIES, BUILD_STUCK_MS };
