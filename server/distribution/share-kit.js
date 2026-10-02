/*
 * distribution/share-kit.js — pure Hebrew copy builders for distribution.
 *
 * Groups get a WhatsApp "share kit" instead of automated posting: Meta removed
 * the Groups publishing API in 2022 and browser automation was rejected as a
 * ban risk (spec §1). So this module builds (a) the post copy used for the
 * Facebook Page / Instagram post, and (b) a WhatsApp message that lets the
 * agent paste that copy into their groups in ~5 taps.
 *
 * Pure functions — no I/O. Unit-tested in share-kit.test.js.
 */

const MAX_GROUPS = 20;

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

function variantIndex(seed, mod) {
  const s = String(seed || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % mod;
}

// ponytail: no property_type field yet, so the title decides. Rooms + a title
// that doesn't name another kind of property ⇒ "דירת N חדרים"; otherwise the
// agent's own title is the noun.
const NOT_APARTMENT = /בית|וילה|קוטג|משפחתי|פנטהאוז|מגרש|חנות|משרד|מחסן/;

function postFacts(p, a, pageUrl, opts) {
  const rooms = Number(p.rooms) > 0 ? p.rooms : 0;
  const title = p.title || "נכס חדש";
  const apt = Boolean(rooms) && !NOT_APARTMENT.test(title);
  const rent = p.listing_type === "rent";
  const size = Number(p.size_sqm) > 0 ? `${p.size_sqm} מ"ר` : "";
  const floor = Number(p.floor) > 0 ? `קומה ${p.floor}` : "";
  const price = Number(p.price) > 0
    ? `₪${Number(p.price).toLocaleString("en-US")}${rent ? " לחודש" : ""}` : "";
  const place = p.neighborhood && p.city ? `${p.neighborhood} ב${p.city}` : p.neighborhood || p.city || "";
  const phone = localPhone(a.phone);
  return {
    rooms, apt, rent, size, floor, price, phone,
    name: a.name || "",
    city: p.city || "",
    neighborhood: p.neighborhood || "",
    noun: apt ? `דירת ${rooms} חדרים` : title,
    the: apt ? "הדירה" : "הנכס",
    it: apt ? "אותה" : "אותו",
    deal: rent ? "להשכרה" : "למכירה",
    inPlace: place ? ` ב${place}` : "",
    loc: [p.neighborhood, p.city].filter(Boolean).join(", "),
    specs: [size, floor && `ב${floor}`].filter(Boolean).join(" "),
    contact: [a.name, phone].filter(Boolean).join(", "),
    // linkInComment: many groups treat an external link in the post body as
    // spam (and Facebook scores the domain for it). The agent posts the link
    // as the first comment instead, standard practice in these groups.
    link: opts.linkInComment ? "הקישור בתגובה הראשונה 👇" : pageUrl,
  };
}

/*
 * Per-group phrasing. Identical text pasted into many groups is the classic
 * spam fingerprint, and it also reads like a bot to human members. Each
 * template has its own order, voice and wording, but the FACTS never change
 * (price, rooms, size, link) and none of them invents a feature we don't
 * know. A template returns null when the property lacks what it needs. The
 * variant is derived from the property+group, so a retry reproduces the same
 * text rather than inventing a new one each time.
 */
const TEMPLATES = [
  // a family that has outgrown its home
  (f) => f.rooms >= 3 && [
    `משפחה שגדלה ומחפשת חדר נוסף${f.city ? ` בלי לעזוב את ${f.city}` : ""}?`,
    `${f.neighborhood ? `ב${f.neighborhood} ` : ""}יש ${f.noun} ${f.deal}${f.specs ? `, ${f.specs}` : ""}.`,
    f.price && `${f.rent ? "שכירות" : "המחיר"}: ${f.price}`,
    `יש סרטון הליכה ${f.apt ? "בדירה" : "בנכס"}, כך שאפשר לראות ${f.it} עוד לפני הביקור:`,
    f.link,
    f.name && [f.name, f.phone].filter(Boolean).join(" · "),
  ],
  // price first
  (f) => f.price && [
    `${f.price} ל${f.noun}${f.inPlace}.`,
    [f.size, f.floor].filter(Boolean).join(", "),
    `בסרטון אפשר לעבור על ${f.the} לפני שקובעים ביקור:`,
    f.link,
    f.contact && `לביקור: ${f.contact}`,
  ],
  // the agent in first person
  (f) => f.name && [
    `היי, כאן ${f.name} 👋`,
    `קיבלתי לשיווק ${f.noun}${f.inPlace}${(() => {
      const d = [f.size, f.floor, f.price && `${f.rent ? "בשכירות של" : "במחיר"} ${f.price}`].filter(Boolean);
      return d.length ? `: ${d.join(", ")}` : "";
    })()}.`,
    "העליתי סרטון הליכה וכל הפרטים לכאן:",
    f.link,
    f.phone && `מי שרוצה לראות ${f.it} במציאות, אפשר להתקשר אליי: ${f.phone}`,
  ],
  // quick to scan, location last
  (f) => [
    `🏠 ${f.noun} ${f.deal}`,
    [f.size, f.floor, f.price].filter(Boolean).join(" · "),
    f.loc,
    `בקישור יש סרטון של ${f.the}, ככה תדעו אם שווה לקבוע ביקור:`,
    f.link,
    [f.name, f.phone].filter(Boolean).join(" "),
  ],
  // from the reader's side
  (f) => [
    `לפני שנוסעים לראות ${f.apt ? "דירה" : "נכס"}, נוח לראות ${f.it} קודם בסרטון.`,
    `אז הנה: ${[`${f.noun}${f.inPlace}`, f.specs, f.price && `${f.rent ? "בשכירות של" : "במחיר"} ${f.price}`].filter(Boolean).join(", ")}.`,
    f.link,
    f.contact && `לשאלות או לתיאום ביקור: ${f.contact}`,
  ],
];

function buildPostCopy(page, pageUrl, opts = {}) {
  const f = postFacts((page && page.property) || {}, (page && page.agent) || {}, pageUrl, opts);
  const fits = TEMPLATES.map((t) => t(f)).filter(Boolean);
  const seed = opts.variantSeed || "";
  const lines = fits[seed ? variantIndex(seed + fits.length, fits.length) : 0];
  return lines.filter(Boolean).join("\n");
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
 * X counts ONLY groups the agent marked posted by hand. Forly does not post to
 * groups (docs/distribution/DECISION-no-automation.md), so copied/opened are
 * preparation and must never inflate this number.
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

module.exports = { MAX_GROUPS, buildPostCopy, sanitizeGroups, sharerLink,
  buildShareKitMessage, buildQueueMessage, trackedUrl, variantIndex, groupProgress };
