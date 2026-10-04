/*
 * distribution/share-kit.js — pure Hebrew copy builders for distribution.
 *
 * Shared copy builders for the automatic browser publisher and the manual
 * fallback queue. The facts stay exact; only framing, fact order and CTA vary.
 * A seed plus round makes every variation deterministic, so retries type the
 * exact same approved text while a later completed round gets fresh framing.
 *
 * Pure functions — no I/O. Unit-tested in share-kit.test.js.
 */

const { symbol } = require("../currency");
// A 30-day campaign can cover this pool under the existing daily/weekly caps;
// widening the pool increases reach without increasing posting frequency.
const MAX_GROUPS = 40;

// 972501234567 → 0501234567 for display; anything non-IL stays as-is.
function localPhone(p) {
  const s = String(p || "");
  return /^9725\d{8}$/.test(s) ? "0" + s.slice(3) : s;
}

// A per-(session,group) tracked link: the SHARED url carries attribution,
// while the page keeps serving an undecorated canonical og:url so Facebook
// still aggregates every share onto one object.
function trackedUrl(pageUrl, { session, group }) {
  if (!session || !group) return pageUrl;
  const u = new URL(String(pageUrl));
  u.searchParams.set("src", "fb_group");
  u.searchParams.set("s", String(session));
  u.searchParams.set("g", String(group));
  return u.toString();
}

/*
 * Per-group phrasing. Identical text pasted into many groups is the classic
 * spam fingerprint, and it also reads like a bot to human members. The FACTS
 * never change (price, rooms, size, link); only the whole post's wording and
 * order do. Ten templates, written the way a local agent types a group post:
 * short fact lines, sparing "?" / "!", no emoji. The template is derived from
 * the property+group so a retry reproduces the same text rather than
 * inventing a new one each time. A template drops any line whose fact is
 * missing.
 */
const COMMENT_CTAS = [
  "הקישור לפרטים המלאים בתגובה הראשונה 👇",
  "כל הפרטים והתמונות בתגובה הראשונה 👇",
  "הקישור לנכס בתגובה הראשונה 👇",
  "הוספתי קישור עם כל הפרטים בתגובה הראשונה 👇",
  "קישור לכל הפרטים בתגובה הראשונה 👇",
  "רוצים לראות את הנכס? הקישור בתגובה הראשונה 👇",
];
const WHATSAPP_COMMENT_CTAS = [
  "קישור לוואטסאפ בתגובה הראשונה 👇",
  "רוצים לשאול או לתאם? קישור לוואטסאפ בתגובה הראשונה 👇",
  "אפשר לדבר איתי ישירות בוואטסאפ, הקישור בתגובה הראשונה 👇",
];
const PAGE_COMMENT_CTAS = [
  "הפוסט המלא בדף העסקי, קישור בתגובה הראשונה 👇",
  "קישור לפוסט בדף העסקי בתגובה הראשונה 👇",
  "לצפייה בפוסט בדף העסקי, הקישור בתגובה הראשונה 👇",
];

const join = (sep, ...xs) => xs.filter(Boolean).join(sep);
const shekel = (n) => `${n.toLocaleString("en-US")} ש"ח`;
const priceText = (n, cur) => (!cur || cur === "ILS" ? shekel(n) : `${symbol(cur)}${n.toLocaleString("en-US")}`);
// 0542045280 → 054-2045280, the way agents usually write it.
const dashedPhone = (s) => (/^05\d{8}$/.test(s) ? `${s.slice(0, 3)}-${s.slice(3)}` : s);

function postFacts(page) {
  const p = (page && page.property) || {};
  const a = (page && page.agent) || {};
  const num = (v) => (Number(v) > 0 ? Number(v) : 0);
  const rooms = num(p.rooms), sqm = num(p.size_sqm), floor = num(p.floor), price = num(p.price);
  const rent = p.listing_type === "rent";
  const hood = p.neighborhood || "", city = p.city || "";
  // After ב the article drops (הבורסה → בבורסה), but a name can start with
  // a root ה (הדר). "בשכונת הבורסה" is right either way. Only the
  // neighborhood: a city keeps its own (בהרצליה).
  const hoodAt = hood.startsWith("ה") ? `שכונת ${hood}` : hood;
  return {
    rooms, rent,
    hood, city,
    hoodAt,                                     // only ever printed after ב
    place: join(", ", hoodAt, city),            // שיקון ותיקים, כפר סבא
    placeIn: join(" ב", hoodAt, city),          // שיקון ותיקים בכפר סבא
    deal: rent ? "להשכרה" : "למכירה",
    priceLabel: rent ? "שכירות" : "מחיר",
    apt: rooms ? `דירת ${rooms} חדרים` : p.title || "נכס",
    roomsText: rooms ? `${rooms} חדרים` : "",
    roomsShort: rooms ? `${rooms} חד'` : "",
    sqm: sqm ? `${sqm} מ"ר` : "",
    floor: floor ? `קומה ${floor}` : "",
    price: price ? priceText(price, p.currency) : "",
    // 2,900,000 → 2.9 מ' ש"ח, only when that is exact (2,925,000 stays full). ILS only.
    priceShort: price && (!p.currency || p.currency === "ILS") && price >= 1e6 && price % 10000 === 0
      ? `${price / 1e6} מ' ש"ח` : price ? priceText(price, p.currency) : "",
    name: a.name || "",
    phone: localPhone(a.phone),
  };
}

const at = (place) => (place ? ` ב${place}` : "");
const sqmOnFloor = (f) => (f.sqm && f.floor ? `${f.sqm} ב${f.floor}` : f.sqm || f.floor);

// Each template: (facts, link, round) → lines. link(label) is the label plus
// the page URL, or the first-comment CTA, or null. Falsy lines are dropped.
const TEMPLATES = [
  (f, link) => [
    `${f.deal}${at(f.place)}!`,
    join(", ", f.apt, f.sqm),
    f.floor,
    f.price && `${f.priceLabel}: ${f.price}`,
    link("כל הפרטים על הנכס"),
    (f.name || f.phone) && "לפרטים ותיאום:",
    join("-", f.name, f.phone),
  ],
  (f, link) => [
    `מחפשים ${f.roomsText || "דירה"}${at(f.city)}?`,
    join(", ", f.hood, f.floor, f.sqm),
    f.price,
    link("פרטים נוספים ותמונות"),
    join("-", f.name, f.phone),
  ],
  (f, link) => [
    `${f.roomsShort || f.apt}${at(f.place)}`,
    sqmOnFloor(f),
    f.priceShort && (f.rent ? `שכירות: ${f.price}` : `מחיר שיווק: ${f.priceShort}`),
    link("רוצים לדעת עוד לפני ביקור? כל הפרטים כאן"),
    join(" ", f.name, dashedPhone(f.phone)),
  ],
  (f, link) => [
    join(", ", f.apt, f.sqm) + at(f.hoodAt),
    join(", ", f.city, f.floor),
    f.price,
    link("כל הפרטים על הדירה"),
    "מוזמנים לתאם ביקור!",
    join("-", f.name, f.phone),
  ],
  (f, link) => [
    `${f.deal}${at(f.city)}`,
    join(", ", f.hood, f.roomsText),
    join(", ", f.sqm, f.floor),
    f.price && `${f.priceLabel}: ${f.price}`,
    (f.name || f.phone) && "שאלות? דברו איתי",
    f.name,
    f.phone,
    link("לפרטים נוספים"),
  ],
  // "חדש" is only claimed on a target's first round.
  (f, link, round) => [
    round === 0 ? "חדש אצלי בשיווק:" : "אצלי בשיווק:",
    `${f.roomsText || f.apt}${at(f.place)}`,
    join(", ", f.sqm, f.floor),
    f.price,
    link("כל הפרטים והתמונות"),
    (f.name || f.phone) && `לתיאום: ${join("-", f.name, f.phone)}`,
  ],
  (f, link) => [
    f.price ? `${f.price} ל${f.apt}${at(f.city)}` : `${f.apt}${at(f.city)}`,
    f.hood && `שכונת ${f.hood}`,
    sqmOnFloor(f),
    link("לפרטים נוספים על הנכס"),
    f.name,
    dashedPhone(f.phone),
  ],
  (f, link) => {
    const what = `${f.roomsText || f.apt}${f.sqm ? ` על ${f.sqm}` : ""}${f.floor ? `, ${f.floor}` : ""}`;
    return [
      f.rooms >= 3 ? "משפחה שצריכה עוד חדר?" : `מחפשים דירה${at(f.city)}?`,
      f.placeIn ? `ב${f.placeIn} יש ${what}` : what,
      f.price && `${f.priceLabel}: ${f.price}`,
      link("כל המידע על הדירה כאן"),
      join("-", f.name, f.phone),
    ];
  },
  (f, link) => [
    join(", ", f.city, f.hood),
    join(", ", f.roomsShort, f.sqm, f.floor) || f.apt,
    f.priceShort,
    (f.name || f.phone) && "כתבו לי ואשלח פרטים!",
    join("-", f.name, f.phone),
    link("פרטים מלאים"),
  ],
  (f, link) => [
    `${f.deal}:`,
    f.apt + at(f.hoodAt),
    f.city,
    f.sqm,
    f.floor,
    f.price && `${f.priceLabel} ${f.price}`,
    link("מה דעתכם? כל הפרטים כאן"),
    (f.name || f.phone) && `לפרטים: ${join(" ", f.name, f.phone)}`,
  ],
];

function variantIndex(seed, mod) {
  const s = String(seed || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % mod;
}

function buildPostCopy(page, pageUrl, opts = {}) {
  const seed = String(opts.variantSeed || "");
  const round = Number.isSafeInteger(opts.variantRound) && opts.variantRound >= 0 ? opts.variantRound : 0;
  const pick = (arr, key) => {
    const base = seed ? variantIndex(`${key}|${seed}`, arr.length) : 0;
    return arr[(base + round) % arr.length];
  };
  const f = postFacts(page);
  // linkInComment: many groups treat an external link in the post body as
  // spam (and Facebook scores the domain for it). The agent posts the link
  // as the first comment instead — standard practice in these groups.
  const link = (label) => {
    if (!opts.linkInComment) return pageUrl ? `${label}->${pageUrl}` : null;
    const destination = opts.destinationKind || "property";
    if (destination === "whatsapp") return pick(WHATSAPP_COMMENT_CTAS, "whatsapp_comment_cta");
    if (destination === "facebook_page") return pick(PAGE_COMMENT_CTAS, "page_comment_cta");
    return destination === "none" ? null : pick(COMMENT_CTAS, "comment_cta");
  };
  const lines = pick(TEMPLATES, "template")(f, link, round).filter(Boolean);
  // No name or phone: the reader still needs a way to respond.
  if (!f.name && !f.phone) lines.push("לפרטים נוספים כתבו לי בפרטי.");
  return lines.join("\n");
}

// facebook.com/groups/<slug> on facebook.com / www / m / web hosts only.
// Normalized to one canonical form so duplicates collapse; capped so a
// pathological dashboard payload can't turn the share kit into a novel.
function sanitizeGroups(urls) {
  const out = [];
  for (const raw of Array.isArray(urls) ? urls : []) {
    let u;
    try { u = new URL(String(raw).trim()); } catch { continue; }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    if (!/^(www\.|m\.|web\.)?facebook\.com$/i.test(u.hostname)) continue;
    // Slug first, rest of the path ignored: real links carry Hebrew vanity
    // names (percent-encoded by URL) and deep paths (/groups/x/posts/123).
    const m = u.pathname.match(/^\/groups\/([^/]+)(\/.*)?$/);
    if (!m || /^(feed|discover|create|joins|browse)$/i.test(m[1])) continue;
    const clean = `https://www.facebook.com/groups/${m[1]}`;
    if (!out.includes(clean)) out.push(clean);
    if (out.length >= MAX_GROUPS) break;
  }
  return out;
}

// Share link. With opts.quote the post text rides along (Facebook's Share
// Dialog attaches it as a quote — no copy-paste needed); with opts.appId the
// official dialog is used instead of the legacy sharer.
function sharerLink(pageUrl, opts = {}) {
  const quote = opts.quote ? String(opts.quote) : null;
  if (opts.appId) {
    const q = new URLSearchParams({
      app_id: String(opts.appId), display: "popup", href: String(pageUrl || "") });
    if (quote) q.set("quote", quote);
    return `https://www.facebook.com/dialog/share?${q}`;
  }
  const q = new URLSearchParams({ u: String(pageUrl || "") });
  if (quote) q.set("quote", quote);
  return `https://www.facebook.com/sharer/sharer.php?${q}`;
}

const FENCE = "──────────";

function buildShareKitMessage({ copy, pageUrl, groups, appId }) {
  const quickShare = sharerLink(pageUrl, { quote: copy, appId });
  const parts = [
    "📣 ערכת שיתוף לקבוצות פייסבוק",
    "",
    "העתיקו את הטקסט שבין הקווים והדביקו בקבוצות שלכם:",
    FENCE,
    String(copy || ""),
    FENCE,
    "",
    `לשיתוף בפרופיל או בקבוצה — הטקסט כבר מצורף, רק בוחרים איפה: ${quickShare}`,
  ];
  const gs = Array.isArray(groups) ? groups : [];
  if (gs.length) {
    parts.push("", "הקבוצות שלכם (הקישו, הדביקו, פרסמו):");
    gs.forEach((g, i) => parts.push(`${i + 1}. ${g}`));
  } else {
    parts.push("", "עדיין לא הוגדרו קבוצות — אפשר להוסיף אותן בעמוד ההפצה בדשבורד.");
  }
  return parts.join("\n");
}

// The WhatsApp alert that replaces the old wall of raw links: a short
// heads-up plus one deep link into the in-app sharing queue, where the copy
// and each group live with resumable progress.
function buildQueueMessage({ title, groupCount, queueUrl, postUrl }) {
  const lines = [];
  if (postUrl) lines.push(`✅ "${title}" פורסם בדף הפייסבוק שלכם!`, postUrl, "");
  lines.push(groupCount
    ? `📣 ${groupCount} קבוצות מחכות לשיתוף — הטקסט מוכן, עוברים קבוצה־קבוצה:`
    : "📣 ערכת השיתוף מוכנה (עדיין לא בחרתם קבוצות):");
  lines.push(queueUrl);
  return lines.join("\n");
}

/*
 * "shared to X of Z groups", for the dashboard.
 *
 * Z is the live queue when one exists, otherwise the property's target list —
 * so the denominator is what the agent will actually be asked to do, not a
 * count that changes meaning once a queue opens.
 *
 * X counts ONLY confirmed queue completions. copied/opened are preparation and
 * must never inflate this legacy manual-queue number; automatic campaign
 * outcomes are tracked by the posting attempt ledger instead.
 */
function groupProgress(session, fallbackGroups) {
  const groups = session && Array.isArray(session.groups) ? session.groups : null;
  if (groups) {
    return {
      posted: groups.filter((g) => g && g.state === "posted").length,
      total: groups.length,
    };
  }
  return { posted: 0, total: sanitizeGroups(fallbackGroups).length };
}

module.exports = { MAX_GROUPS, TEMPLATE_COUNT: TEMPLATES.length, buildPostCopy, sanitizeGroups, sharerLink,
  buildShareKitMessage, buildQueueMessage, trackedUrl, variantIndex, groupProgress };
