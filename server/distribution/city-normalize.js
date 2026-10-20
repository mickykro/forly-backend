/* city-normalize.js — the catalog has 88 spellings for far fewer places
   ("תל אביב", "תל אביב - יפו", "Tel Aviv", "TLV"…). One canonical Hebrew
   name each, so "groups in your area" is a real question. */
const ALIASES = {
  "תל אביב": ["תל אביב - יפו", "תל אביב-יפו", "תל-אביב", "tel aviv", "tel aviv-yafo", "tlv", "ת\"א"],
  "באר שבע": ["beersheba", "beer sheva", "be'er sheva"],
  "ירושלים": ["jerusalem"], "חיפה": ["haifa"], "ראשון לציון": ["rishon lezion", "rishon"],
  "פתח תקווה": ["petah tikva", "petach tikva"], "נתניה": ["netanya"], "הרצליה": ["herzliya"],
  "רמת גן": ["ramat gan"], "אשדוד": ["ashdod"], "מודיעין": ["modiin", "modi'in"],
};
const NATIONWIDE = new Set(["כל הארץ", "ישראל", "israel", "ארצי", "nationwide"]);
// fold(): the SAME dash/whitespace normalization used on both sides of the
// lookup — an alias registered as "tel aviv-yafo" (no spaces) must still
// match an input that folds to "tel aviv - yafo", or vice versa.
const fold = (s) => String(s || "").trim().replace(/\s*-\s*/g, " - ").replace(/\s+/g, " ");
const LOOKUP = new Map();
for (const [canon, list] of Object.entries(ALIASES)) { LOOKUP.set(fold(canon).toLowerCase(), canon); for (const a of list) LOOKUP.set(fold(a).toLowerCase(), canon); }

function normalizeCity(s) {
  const first = fold(String(s || "").split(/[,/]/)[0]);
  const key = first.toLowerCase();
  if (NATIONWIDE.has(key)) return "כל הארץ";
  return LOOKUP.get(key) || first;
}
function sameArea(a, b) {
  const x = normalizeCity(a), y = normalizeCity(b);
  return x === "כל הארץ" || y === "כל הארץ" || x === y;
}
// Whether a free-text name (a Facebook group's) names this city, in any of
// its known spellings — "דירות להשכרה בהוד השרון" names הוד השרון.
function mentionsCity(name, city) {
  const n = fold(name).toLowerCase(), c = normalizeCity(city);
  if (!n || !c || c === "כל הארץ") return false;
  return [c, ...(ALIASES[c] || [])].map((x) => fold(x).toLowerCase()).filter((x) => x.length >= 2).some((x) => n.includes(x));
}
module.exports = { normalizeCity, sameArea, mentionsCity, ALIASES };
