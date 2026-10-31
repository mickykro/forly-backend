/*
 * promo-body.js — what POST /api/promo/order accepts from create.html's submit body
 * (public-agent/create.html ~1748-1782). Whitelists only; the phone is always the session's.
 */

// Listing fields a /reel buyer may send. Never: own_video_url, listing_draft_id, replaces_listing_id, whatsapp_draft.
const LISTING_FIELDS = ["city", "address", "neighborhood", "price", "rooms", "size_sqm", "floor", "listing_type",
  "description", "photos_urls", "language", "size_built", "size_balcony", "size_garden", "parking", "storage",
  "elevator", "shabbat_elevator"];
// create.html buildTheme() keys, minus font_url (an uploaded font file isn't offered to strangers).
const THEME_FIELDS = ["template", "font_title", "font_body", "primary", "accent"];
// Never: agent.phone, phone2, agent2, agent_phones.
const AGENT_FIELDS = ["name", "brand_name", "license", "logo_url"];
const MIN_PHOTOS = 4;

const pick = (src, keys) => Object.fromEntries(keys.filter((k) => src[k] !== undefined).map((k) => [k, src[k]]));
const ownUrl = (photoBase, u) => typeof u === "string" && u.startsWith(photoBase) && !/\.\.|[?#]/.test(u);

// → { error, code } | { listing, agent }
function parseOrderBody(body, photoBase) {
  const listing = pick(body, LISTING_FIELDS);
  if (body.theme && typeof body.theme === "object") listing.theme = pick(body.theme, THEME_FIELDS);
  const a = body.agent && typeof body.agent === "object" ? body.agent : {};
  const agent = Object.fromEntries(AGENT_FIELDS.map((k) => [k, typeof a[k] === "string" ? a[k].trim().slice(0, 120) : ""]));
  agent.name = agent.name.slice(0, 60);
  if (!agent.name) return { error: "agent.name is required", code: 400 };
  if (!Array.isArray(listing.photos_urls) || listing.photos_urls.length < MIN_PHOTOS) return { error: `at least ${MIN_PHOTOS} photos required`, code: 400 };
  if (!listing.photos_urls.every((u) => ownUrl(photoBase, u)) || (agent.logo_url && !ownUrl(photoBase, agent.logo_url))) return { error: "photos must be uploaded here", code: 400 };
  return { listing, agent };
}

module.exports = { parseOrderBody };
