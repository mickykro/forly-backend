/*
 * posting-destination.js — choose the real destination placed in a Group
 * post's first comment. This is content routing, not URL cloaking: every URL is
 * the canonical Forly property, the agent's WhatsApp, or an existing Facebook
 * Page post. There are no alternate domains, shorteners or redirect aliases.
 *
 * The choice is stored on the campaign post. A retry therefore uses the same
 * destination; a later completed round may choose another one.
 */
const { variantIndex } = require("./distribution/share-kit");
const { normalizePhone, publicUrl } = require("./utils");
const { clickLink } = require("./posting-attribution");

const KINDS = new Set(["property", "whatsapp", "facebook_page", "none"]);
const FACEBOOK_HOST = /^(?:www\.|m\.|web\.)?facebook\.com$/i;

function safeFacebookUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    return u.protocol === "https:" && FACEBOOK_HOST.test(u.hostname) && u.pathname !== "/" ? u.toString() : null;
  } catch { return null; }
}

function whatsappUrl(page) {
  const phone = normalizePhone(page && page.agent && page.agent.phone);
  if (!phone) return null;
  const title = String((page.property || {}).title || "הנכס").trim().slice(0, 100);
  const name = String((page.agent || {}).name || "").trim().slice(0, 60);
  const text = `היי${name ? ` ${name}` : ""}, ראיתי את ${title} ואשמח לפרטים נוספים.`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

function pagePostFrom(distributions) {
  return (Array.isArray(distributions) ? distributions : [])
    .filter((d) => d && d.targets && d.targets.facebook_page && d.targets.facebook_page.status === "posted")
    .sort((a, b) => Date.parse(b.updated_at || b.confirmed_at || 0) - Date.parse(a.updated_at || a.confirmed_at || 0))
    .map((d) => safeFacebookUrl(d.targets.facebook_page.post_url))
    .find(Boolean) || null;
}

async function pagePostUrl(db, pageId) {
  if (!db || typeof db.listDistributionsByPage !== "function") return null;
  try { return pagePostFrom(await db.listDistributionsByPage(pageId)); }
  catch { return null; }
}

function choose({ page, campaign, target, pagePostUrl, variantRound = 0 } = {}) {
  // A Page post always points to the property; Page-to-Page and CTA-only
  // variants are only useful for Group distribution.
  if (target && target.target === "page") return { kind: "property", url: null };
  const candidates = [{ kind: "property", url: null }];
  const wa = whatsappUrl(page);
  if (wa) candidates.push({ kind: "whatsapp", url: wa });
  const fb = safeFacebookUrl(pagePostUrl);
  if (fb) candidates.push({ kind: "facebook_page", url: fb });
  candidates.push({ kind: "none", url: null });
  const key = `${campaign && campaign.page_id}|${target && (target.group_id || target.url)}|destination`;
  const round = Number.isSafeInteger(variantRound) && variantRound >= 0 ? variantRound : 0;
  return candidates[(variantIndex(key, candidates.length) + round) % candidates.length];
}

function notice(kind) {
  if (kind === "whatsapp") return "כדי לגוון את דרך הפנייה, קישור הנכס של פורלי לא יצורף לפוסט הזה. במקום זאת יצורף קישור לוואטסאפ שלכם, כדי שמתעניינים יפנו אליכם ישירות.";
  if (kind === "facebook_page") return "כדי להוביל דרך תוכן שכבר פורסם בפייסבוק, קישור הנכס של פורלי לא יצורף לפוסט הזה. במקום זאת יצורף הפוסט הקיים בדף העסקי, שבו כבר נמצא קישור הנכס.";
  if (kind === "none") return "כדי לשמור על פוסט קצר ללא קישור חיצוני, קישור הנכס של פורלי לא יצורף לפוסט הזה. הפוסט יזמין לפנות אליכם בפרטי; תוכלו לשלוח את דף הנכס בשיחה.";
  return "קישור ישיר לדף הנכס של פורלי יצורף בתגובה הראשונה.";
}

function previewUrl(destination, { pageBaseUrl, pageId } = {}) {
  const d = destination && KINDS.has(destination.kind) ? destination : { kind: "property", url: null };
  if (d.kind === "none") return null;
  if (d.kind === "property") return publicUrl(`${String(pageBaseUrl || "").replace(/\/+$/, "")}/p/${pageId}`);
  return d.url || null;
}

function commentUrl(post, attempt, { pageBaseUrl, campaignId } = {}) {
  const kind = post && KINDS.has(post.link_kind) ? post.link_kind : "property";
  if (kind === "none") return null;
  if (kind === "property") return publicUrl(clickLink(pageBaseUrl || "", attempt.page_id, attempt.click_id));
  if (kind === "whatsapp") return /^https:\/\/wa\.me\//i.test(String(post.link_url || "")) ? post.link_url : null;
  if (kind === "facebook_page") return safeFacebookUrl(post.link_url);
  return null;
}

module.exports = { KINDS, safeFacebookUrl, whatsappUrl, pagePostFrom, pagePostUrl, choose, notice, previewUrl, commentUrl };
