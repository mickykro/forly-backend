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

/*
 * Per-group phrasing. Identical text pasted into many groups is the classic
 * spam fingerprint — and it also reads like a bot to human members. The FACTS
 * never change (price, rooms, size, link); only the framing does, and the
 * variant is derived from the property+group so a retry reproduces the same
 * text rather than inventing a new one each time.
 */
const OPENERS = ["🏠", "🔑", "🏡", "✨", "📍"];
const CTAS = [
  "לכל הפרטים, תמונות וסרטון ⬅️",
  "סרטון הליכה, תמונות ומידע מלא ⬅️",
  "כל הפרטים והסרטון כאן ⬅️",
  "לצפייה בסרטון ובפרטים המלאים ⬅️",
];
const CLOSERS = ["", "מוזמנים לפנות 🙂", "אשמח להעביר פרטים נוספים", "פתוח לשאלות"];

function variantIndex(seed, mod) {
  const s = String(seed || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % mod;
}

function buildPostCopy(page, pageUrl, opts = {}) {
  const p = (page && page.property) || {};
  const a = (page && page.agent) || {};
  const seed = opts.variantSeed || "";
  const pick = (arr) => arr[seed ? variantIndex(seed + arr.length, arr.length) : 0];
  const lines = [];
  lines.push(`${pick(OPENERS)} ${p.title || "נכס חדש"}`);
  const loc = [p.neighborhood, p.city].filter(Boolean).join(", ");
  if (loc) lines.push(`📍 ${loc}`);
  const facts = [];
  if (Number(p.rooms) > 0) facts.push(`${p.rooms} חדרים`);
  if (Number(p.size_sqm) > 0) facts.push(`${p.size_sqm} מ"ר`);
  if (Number(p.floor) > 0) facts.push(`קומה ${p.floor}`);
  if (facts.length) lines.push(facts.join(" · "));
  if (Number(p.price) > 0) {
    const verb = p.listing_type === "rent" ? "שכירות" : "מחיר";
    lines.push(`💰 ${verb}: ₪${Number(p.price).toLocaleString("en-US")}`);
  }
  lines.push("");
  // linkInComment: many groups treat an external link in the post body as
  // spam (and Facebook scores the domain for it). The agent posts the link
  // as the first comment instead — standard practice in these groups.
  if (opts.linkInComment) {
    lines.push("קישור לסרטון ולפרטים המלאים בתגובה הראשונה 👇");
  } else {
    lines.push(`${pick(CTAS)} ${pageUrl}`);
  }
  if (a.name) {
    const phone = localPhone(a.phone);
    lines.push(`${a.name}${phone ? ` · ${phone}` : ""}`);
  }
  const closer = pick(CLOSERS);
  if (closer) lines.push(closer);
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
