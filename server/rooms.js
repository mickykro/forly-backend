/*
 * Vision-Tagger room types → Hebrew display labels.
 *
 * The tagger classifies each listing photo, and two very different things then
 * want to put a Hebrew word on screen for it: the labels burned into the
 * walkthrough video (overlay.js) and the captions under each photo on the
 * landing page (routes/pages.js). One vocabulary for both, so a room is never
 * called one thing in the clip and another on the page — and so n8n can forward
 * the tagger's raw output without knowing any Hebrew.
 */

// Vision-Tagger room types → Hebrew display labels (exact, normalized key).
const ROOM_HE = {
  living_room: "סלון", livingroom: "סלון", salon: "סלון", lounge: "סלון",
  open_plan_living_dining_kitchen: "חלל פתוח", open_plan: "חלל פתוח",
  living_dining_kitchen: "חלל פתוח", living_dining: "סלון ופינת אוכל",
  kitchen: "מטבח", kitchenette: "מטבחון",
  bedroom: "חדר שינה", master_bedroom: "חדר שינה ראשי",
  kids_room: "חדר ילדים", children_room: "חדר ילדים", nursery: "חדר ילדים",
  bathroom: "חדר רחצה", toilet: "שירותים", shower: "מקלחת",
  balcony: "מרפסת", terrace: "מרפסת", sun_balcony: "מרפסת שמש",
  dining_room: "פינת אוכל", dining_area: "פינת אוכל",
  office: "חדר עבודה", study: "חדר עבודה",
  entrance: "כניסה", entry: "כניסה", hallway: "מסדרון", corridor: "מסדרון",
  mamad: "ממ״ד", safe_room: "ממ״ד",
  garden: "גינה", yard: "חצר",
  roof: "גג", rooftop: "גג",
  parking: "חניה", storage: "מחסן", laundry: "חדר כביסה",
  building: "הבניין", exterior: "חזית הבניין", facade: "חזית הבניין",
  view: "נוף", lobby: "לובי", pool: "בריכה", gym: "חדר כושר",
};

// Ordered substring → Hebrew fallbacks for compound/unseen types the Tagger
// invents ("open_plan_apartment", "guest_bedroom", "second_balcony"). Most
// specific first — the first substring found in the normalized key wins.
const ROOM_KEYWORDS = [
  ["open_plan", "חלל פתוח"], ["open_space", "חלל פתוח"],
  ["master", "חדר שינה ראשי"],
  ["kids", "חדר ילדים"], ["children", "חדר ילדים"], ["nursery", "חדר ילדים"],
  ["bedroom", "חדר שינה"],
  ["living", "סלון"], ["salon", "סלון"], ["lounge", "סלון"],
  ["kitchen", "מטבח"],
  ["dining", "פינת אוכל"],
  ["bathroom", "חדר רחצה"], ["shower", "מקלחת"], ["toilet", "שירותים"],
  ["mamad", "ממ״ד"], ["safe_room", "ממ״ד"],
  ["balcony", "מרפסת"], ["terrace", "מרפסת"],
  ["office", "חדר עבודה"], ["study", "חדר עבודה"],
  ["hallway", "מסדרון"], ["corridor", "מסדרון"], ["entrance", "כניסה"],
  ["garden", "גינה"], ["yard", "חצר"], ["roof", "גג"],
  ["parking", "חניה"], ["storage", "מחסן"], ["laundry", "חדר כביסה"],
  ["facade", "חזית הבניין"], ["exterior", "חזית הבניין"], ["building", "הבניין"],
  ["lobby", "לובי"], ["pool", "בריכה"], ["gym", "חדר כושר"], ["view", "נוף"],
];

// Map a Tagger room type to a Hebrew label: exact match → keyword fallback →
// drop. Values already in Hebrew pass through. Unknown English is DROPPED
// (returns ""), never burned onto the video as a raw type string.
function roomLabel(r) {
  const raw = typeof r === "string" ? r : (r && (r.room_type || r.label)) || "";
  const s = String(raw).trim();
  if (!s) return "";
  if (/[֐-׿]/.test(s)) return s.slice(0, 30); // already Hebrew
  const key = s.toLowerCase().replace(/[\s-]+/g, "_");
  if (ROOM_HE[key]) return ROOM_HE[key];
  for (const [needle, he] of ROOM_KEYWORDS) {
    if (key.includes(needle)) return he;
  }
  return "";
}

module.exports = { roomLabel, ROOM_HE, ROOM_KEYWORDS };
