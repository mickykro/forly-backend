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

const MAX_PHOTOS = 12;
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
    price: Number(body.price) || 0, rooms: Number(body.rooms) || 0,
    size_sqm: Number(body.size_sqm) || 0, floor: Number(body.floor) || 0,
    size_built: Number(body.size_built) || 0,
    size_balcony: Number(body.size_balcony) || 0,
    size_garden: Number(body.size_garden) || 0,
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
      price: listing.price, rooms: listing.rooms, size_sqm: listing.size_sqm,
      size_built: listing.size_built, size_balcony: listing.size_balcony,
      size_garden: listing.size_garden,
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
  return { listing_id: listingId };
}

module.exports = { validateListing, createListing, MAX_PHOTOS, MIN_PHOTOS };
