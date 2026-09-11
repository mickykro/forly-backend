/*
 * whatsapp-intake.js — an agent drops a listing link in WhatsApp, Forly
 * builds the property page and replies in the same chat.
 *
 *   link → listing-sources.resolve (Firecrawl / Facebook)
 *        → listing-extract.parseListing (fields)
 *        → photos re-hosted on Forly (importPhoto)
 *        → quota + listing-create.createListing (kicks the n8n page pipeline)
 *        → "building" reply now; the n8n Property Page Builder WhatsApps the
 *          agent the page link when it is live (as it does for every page).
 *
 * Pure orchestration with injected deps so whatsapp-intake.test.js runs
 * without Express, Firestore or the network. Every outcome has a stable
 * `status` and a Hebrew `reply` (null when the sender is not a client — we
 * never message strangers).
 */
const { MIN_PHOTOS, MAX_PHOTOS } = require("./listing-create");

// First http(s) link in a chat message. Trailing punctuation a phone keyboard
// adds ("…link.", "(link)") is not part of the URL.
const URL_RE = /https?:\/\/[^\s<>"']+/i;
function findUrl(text) {
  const m = URL_RE.exec(String(text || ""));
  if (!m) return null;
  const url = m[0].replace(/[.,;:!?)\]]+$/, "");
  try { return new URL(url).href; } catch (e) { return null; }
}

// What the page needs to exist at all (mirrors listing-create.validateListing).
const NEEDED = { city: "עיר", price: "מחיר", rooms: "מספר חדרים" };

const R = {
  no_link: (createUrl) =>
    `לא מצאתי קישור בהודעה. שלחו לי קישור למודעה (יד2, מדלן, פייסבוק או כל אתר) ואבנה ממנו דף נכס.\nאפשר גם למלא ידנית: ${createUrl}`,
  facebook_not_connected: (createUrl) =>
    `כדי לקרוא פוסטים מפייסבוק צריך קודם לחבר את עמוד הפייסבוק שלכם בפאנל.\nבינתיים אפשר להדביק את הטקסט של הפוסט כאן, או למלא ידנית: ${createUrl}`,
  page_unreadable: (createUrl) =>
    `לא הצלחתי לקרוא את הדף בקישור. אולי המודעה פרטית או הוסרה.\nאפשר להדביק את טקסט המודעה כאן, או למלא ידנית: ${createUrl}`,
  extract_unavailable: (createUrl) =>
    `יש לי תקלה זמנית בקריאת מודעות. נסו שוב בעוד כמה דקות, או מלאו ידנית: ${createUrl}`,
  missing_fields: (labels, createUrl) =>
    `קראתי את המודעה אבל חסר לי: ${labels.join(", ")}.\nהשלימו את הפרטים כאן ואבנה את הדף: ${createUrl}`,
  few_photos: (n, createUrl) =>
    `מצאתי במודעה ${n} תמונות, ולדף נכס צריך לפחות ${MIN_PHOTOS}.\nהעלו את התמונות כאן ואבנה את הדף: ${createUrl}`,
  create_failed: (createUrl) =>
    `משהו השתבש ביצירת הדף. נסו שוב, או מלאו ידנית: ${createUrl}`,
  building: (f) =>
    `קיבלתי! 🏠 ${f.rooms} חד׳ ב${f.neighborhood || f.city}${f.price ? `, ₪${Number(f.price).toLocaleString("en-US")}` : ""}.\nאני בונה את דף הנכס — אשלח לכם קישור כשהוא מוכן (כמה דקות).`,
};

function listingBody(fields, src, photos) {
  return {
    city: fields.city, price: fields.price, rooms: fields.rooms,
    address: fields.address || "", neighborhood: fields.neighborhood || "",
    listing_type: fields.deal || "sale",
    size_sqm: fields.size_sqm, size_built: fields.sqm_built,
    size_balcony: fields.sqm_balcony, size_garden: fields.sqm_garden,
    floor: fields.floor, parking: fields.parking,
    storage: !!fields.storage, elevator: !!fields.elevator, shabbat_elevator: !!fields.shabbat_elevator,
    description: String(src.description || src.text || "").slice(0, 2000),
    photos_urls: photos,
  };
}

/*
 * intake({ phone, text }, deps) → { status, reply, listing_id? }
 * deps: getBusiness(phone), resolve(input), parseListing(text), importPhoto(url) → hosted url,
 *       quota (optional, .consume), createListing(phone, body), createUrl
 */
async function intake({ phone, text }, deps) {
  const { getBusiness, resolve, parseListing, importPhoto, quota, createListing, createUrl } = deps;
  const business = await getBusiness(phone).catch(() => null);
  if (!business) return { status: "unknown_agent", reply: null };

  const url = findUrl(text);
  if (!url) return { status: "no_link", reply: R.no_link(createUrl) };

  let src, parsed;
  try {
    src = await resolve({ url, userId: phone });
    parsed = await parseListing(src.text);
  } catch (err) {
    const code = R[err.code] ? err.code : "page_unreadable";
    if (!R[err.code]) console.error("[whatsapp-intake]", err);
    return { status: code, reply: R[code](createUrl) };
  }
  const { fields } = parsed;
  const missing = Object.keys(NEEDED).filter((k) => fields[k] === null || fields[k] === undefined);
  if (missing.length) {
    return { status: "missing_fields", missing, reply: R.missing_fields(missing.map((k) => NEEDED[k]), createUrl) };
  }

  const candidates = (src.photos || []).slice(0, MAX_PHOTOS).map((p) => p.url);
  const settled = await Promise.allSettled(candidates.map((u) => importPhoto(u)));
  const photos = settled.filter((s) => s.status === "fulfilled" && s.value).map((s) => s.value);
  if (photos.length < MIN_PHOTOS) {
    return { status: "few_photos", photos: photos.length, reply: R.few_photos(photos.length, createUrl) };
  }

  if (quota) {
    const q = await quota.consume(phone, "walkthroughs", 1, {
      source: "whatsapp", business,
      request: { url, city: fields.city, price: fields.price, rooms: fields.rooms, photos: photos.length },
    });
    if (!q.ok) return { status: "quota_blocked", reply: q.message || R.create_failed(createUrl) };
  }

  const result = await createListing(phone, listingBody(fields, src, photos));
  if (result.error) {
    console.error("[whatsapp-intake] create failed:", result.error);
    return { status: "create_failed", reply: R.create_failed(createUrl) };
  }
  return { status: "building", listing_id: result.listing_id, reply: R.building(fields) };
}

module.exports = { intake, findUrl, _test: { listingBody, NEEDED, R } };
