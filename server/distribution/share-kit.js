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

function buildPostCopy(page, pageUrl) {
  const p = (page && page.property) || {};
  const a = (page && page.agent) || {};
  const lines = [];
  lines.push(`🏠 ${p.title || "נכס חדש"}`);
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
  lines.push(`לכל הפרטים, תמונות וסרטון ⬅️ ${pageUrl}`);
  if (a.name) {
    const phone = localPhone(a.phone);
    lines.push(`${a.name}${phone ? ` · ${phone}` : ""}`);
  }
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
    const m = u.pathname.match(/^\/groups\/([A-Za-z0-9._-]+)\/?$/);
    if (!m) continue;
    const clean = `https://www.facebook.com/groups/${m[1]}`;
    if (!out.includes(clean)) out.push(clean);
    if (out.length >= MAX_GROUPS) break;
  }
  return out;
}

function sharerLink(pageUrl) {
  return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(String(pageUrl || ""))}`;
}

const FENCE = "──────────";

function buildShareKitMessage({ copy, pageUrl, groups }) {
  const parts = [
    "📣 ערכת שיתוף לקבוצות פייסבוק",
    "",
    "העתיקו את הטקסט שבין הקווים והדביקו בקבוצות שלכם:",
    FENCE,
    String(copy || ""),
    FENCE,
    "",
    `שיתוף מהיר בפייסבוק: ${sharerLink(pageUrl)}`,
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

module.exports = { MAX_GROUPS, buildPostCopy, sanitizeGroups, sharerLink, buildShareKitMessage };
