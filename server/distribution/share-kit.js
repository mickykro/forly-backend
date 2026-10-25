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
 * never change; only the decision path, order and CTA vary. These ten
 * templates are deliberately facts-first: detail modules appear only when
 * their structured values exist. A retry reproduces the same copy, while a
 * later completed round gets a fresh framing.
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

function postFacts(page) {
  const p = (page && page.property) || {};
  const a = (page && page.agent) || {};
  const num = (v) => (Number(v) > 0 ? Number(v) : 0);
  const rooms = num(p.rooms), sqm = num(p.size_sqm), built = num(p.size_built), floor = num(p.floor), price = num(p.price);
  const balcony = num(p.size_balcony), garden = num(p.size_garden), plot = num(p.size_plot), parking = num(p.parking);
  const rent = p.listing_type === "rent";
  const hood = p.neighborhood || "", city = p.city || "";
  // After ב the article drops (הבורסה → בבורסה), but a name can start with
  // a root ה (הדר). "בשכונת הבורסה" is right either way. Only the
  // neighborhood: a city keeps its own (בהרצליה).
  const hoodAt = hood.startsWith("ה") ? `שכונת ${hood}` : hood;
  const sqmText = sqm ? `${sqm} מ"ר` : "";
  const builtText = built ? `${built} מ"ר` : "";
  const outdoorLines = [
    balcony ? `מרפסת: ${balcony} מ"ר` : "",
    garden ? `גינה: ${garden} מ"ר` : "",
    plot ? `מגרש: ${plot} מ"ר` : "",
  ].filter(Boolean);
  const elevatorLine = p.shabbat_elevator ? "מעלית שבת" : p.elevator ? "מעלית" : "";
  const parkingLine = parking ? `חניה: ${parking} ${parking === 1 ? "מקום" : "מקומות"}` : "";
  const storageLine = p.storage === true ? "מחסן: קיים" : "";
  const accessLines = [elevatorLine, parkingLine, storageLine].filter(Boolean);
  const builtLine = built && sqm && built !== sqm ? `שטח בנוי: ${builtText}` : "";
  // Extra detail must qualify a buyer. Unknown values never create a label,
  // and an ordinary listing receives no longer copy merely for variety.
  const primaryModule = outdoorLines.length ? outdoorLines : accessLines.length ? accessLines : builtLine ? [builtLine] : [];
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
    sqm: sqmText || builtText,
    sqmLine: sqmText ? `שטח: ${sqmText}` : builtText ? `שטח בנוי: ${builtText}` : "",
    builtLine,
    outdoorLines,
    accessLines,
    primaryModule,
    floor: floor ? `קומה ${floor}` : "",
    price: price ? priceText(price, p.currency) : "",
    name: a.name || "",
    phone: localPhone(a.phone),
  };
}

const at = (place) => (place ? ` ב${place}` : "");
const priceLine = (f) => (f.price ? `${f.priceLabel}: ${f.price}` : "");

// A public listing URL or an actual first-comment CTA is preferred. Contact
// details appear only when there is no route to the listing at all.
function finish(lines, f, link, label) {
  const action = link(label);
  if (action) return lines.concat(action);
  const contact = join("-", f.name, f.phone);
  return contact ? lines.concat(`לפרטים: ${contact}`) : lines;
}

// Each template: (facts, link) → lines. All ten retain the factual spine;
// specialty lines are emitted only from structured property data. This keeps
// each version useful even for older pages that lack newer detail fields.
const TEMPLATES = [
  (f, link) => [
    `${f.deal}${at(f.place)}`,
    join(" | ", f.apt, f.sqm),
    f.floor,
    priceLine(f),
    ...f.primaryModule,
    ...finish([], f, link, "לפרטים ולתיאום צפייה"),
  ],
  (f, link) => [
    "השטח והחוץ, בנפרד וברור",
    `${f.deal}${at(f.place)}`,
    f.apt,
    f.sqmLine,
    f.builtLine,
    ...f.outdoorLines,
    f.floor,
    priceLine(f),
    ...finish([], f, link, "כל הפרטים והצפייה בנכס"),
  ],
  (f, link) => [
    "לפני ביקור, אלה הפרטים החשובים",
    `${f.deal}${at(f.place)}`,
    join(" | ", f.apt, f.sqm),
    f.floor,
    ...f.primaryModule,
    priceLine(f),
    ...finish([], f, link, "לבדיקת התאמה ולתיאום ביקור"),
  ],
  (f, link) => [
    "מגיעים, עולים, חונים",
    `${f.deal}${at(f.place)}`,
    join(" | ", f.apt, f.sqm),
    f.floor,
    ...f.accessLines,
    priceLine(f),
    ...finish([], f, link, "פרטי הנכס ותיאום צפייה"),
  ],
  (f, link) => [
    "פרטי הנכס לפני שקובעים ביקור",
    `${f.deal}${at(f.city)}`,
    join(" | ", f.apt, f.sqm),
    f.hood && `שכונה: ${f.hood}`,
    f.floor,
    priceLine(f),
    ...f.primaryModule,
    ...finish([], f, link, "לפרטים המלאים ולביקור"),
  ],
  (f, link) => [
    "הבית במספרים",
    f.apt + at(f.place),
    f.sqmLine,
    f.builtLine,
    f.floor,
    priceLine(f),
    ...f.primaryModule,
    ...finish([], f, link, "לפרטי הנכס"),
  ],
  (f, link) => [
    "הנכס והבניין",
    `${f.deal}${at(f.place)}`,
    join(" | ", f.apt, f.sqm),
    f.floor,
    ...f.accessLines,
    priceLine(f),
    ...finish([], f, link, "פרטי היחידה ותיאום צפייה"),
  ],
  (f, link) => [
    "המחיר לצד המפרט",
    priceLine(f),
    `${f.deal}${at(f.place)}`,
    join(" | ", f.apt, f.sqm),
    f.floor,
    ...f.primaryModule,
    ...finish([], f, link, "לתמונות, פרטים ותיאום"),
  ],
  (f, link) => [
    "מבט מהיר על הנכס",
    `${f.deal}${at(f.place)}`,
    f.apt,
    join(" | ", f.sqm, f.floor),
    priceLine(f),
    ...f.primaryModule,
    ...finish([], f, link, "לפירוט הנכס ולצפייה"),
  ],
  (f, link) => [
    "כשהפרטים ברורים",
    `${f.deal}${at(f.place)}`,
    join(" | ", f.apt, f.sqm),
    f.floor,
    ...f.primaryModule,
    priceLine(f),
    ...finish([], f, link, "מפה, פרטי הנכס ותיאום"),
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
  // No name, phone or CTA: the reader still needs a way to respond.
  const hasCta = opts.linkInComment ? (opts.destinationKind || "property") !== "none" : !!pageUrl;
  if (!f.name && !f.phone && !hasCta) lines.push("לפרטים נוספים כתבו לי בפרטי.");
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
