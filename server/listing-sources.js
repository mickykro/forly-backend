/*
 * listing-sources.js — turns "what the agent pasted" into text + photo URLs.
 *
 *   text            → as is
 *   facebook.com    → Graph API with the agent's connected Page token
 *   any other URL   → Firecrawl scrape (markdown)
 *
 * Nothing here calls the LLM; listing-extract.js does that on the text we
 * return. Every error carries a stable `code` the route maps to a status.
 */
const dns = require("dns").promises;
const net = require("net");
const meta = require("./distribution/meta");
const db = require("./db");

const TIMEOUT_MS = 10000;
const MAX_PHOTOS = 12;
const FIRECRAWL_URL = "https://api.firecrawl.dev/v1/scrape";
const FB_HOSTS = /(^|\.)(facebook\.com|fb\.com|fb\.watch)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp)(\?|$)/i;
const NOT_LISTING = /(logo|icon|sprite|pixel|avatar|badge|flag|banner|placeholder)/i;

function fail(code, msg) { const e = new Error(msg || code); e.code = code; return e; }

function parseUrl(url) {
  let u;
  try { u = new URL(String(url || "")); } catch (e) { throw fail("invalid_input", "bad url"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw fail("invalid_input", "bad scheme");
  return u;
}

function sourceFor({ text, url }) {
  if (typeof text === "string" && text.trim()) return "text";
  if (!url) throw fail("invalid_input", "text or url required");
  return FB_HOSTS.test(parseUrl(url).hostname) ? "facebook" : "scrape";
}

// ── SSRF guard ──
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) return ip === "::1" || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || /^::ffff:/i.test(ip) && isPrivateIp(ip.replace(/^::ffff:/i, ""));
  const p = ip.split(".").map(Number);
  if (p.length !== 4) return true;
  return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 169 && p[1] === 254);
}

async function isPublicUrl(url, lookup = (h) => dns.lookup(h, { all: true })) {
  let u;
  try { u = parseUrl(url); } catch (e) { return false; }
  if (u.hostname === "localhost") return false;
  if (net.isIP(u.hostname)) return !isPrivateIp(u.hostname);
  try {
    const addrs = await lookup(u.hostname);
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch (e) { return false; }
}

// ── images out of scraped markdown ──
function listingImages(markdown) {
  const out = [];
  const re = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(String(markdown || ""))) && out.length < MAX_PHOTOS) {
    const src = m[1];
    if (!IMAGE_EXT.test(src) || NOT_LISTING.test(src) || out.includes(src)) continue;
    out.push(src);
  }
  return out;
}

// ── facebook ──
function facebookPostId(url) {
  let u;
  try { u = parseUrl(url); } catch (e) { return null; }
  const q = u.searchParams;
  if (q.get("story_fbid")) return q.get("story_fbid");
  if (q.get("fbid")) return q.get("fbid");
  const m = u.pathname.match(/\/posts\/([A-Za-z0-9_]+)/) || u.pathname.match(/\/videos\/(\d+)/);
  return m ? m[1] : null;
}

function attachmentImages(post) {
  const urls = [];
  const walk = (list) => {
    for (const a of (list && list.data) || []) {
      const src = a && a.media && a.media.image && a.media.image.src;
      if (src && !urls.includes(src) && urls.length < MAX_PHOTOS) urls.push(src);
      if (a && a.subattachments) walk(a.subattachments);
    }
  };
  walk(post && post.attachments);
  return urls;
}

async function fromFacebook({ url, userId }, { graphCall = meta.graphCall, getConnection = db.getConnection }) {
  const conn = userId ? await getConnection(userId) : null;
  if (!conn || !conn.page_token || !conn.page_id) throw fail("facebook_not_connected");
  const id = facebookPostId(url);
  if (!id) throw fail("page_unreadable", "no post id in url");
  const fields = "message,attachments{media,subattachments{media}}";
  // Graph wants "<page>_<post>" for numeric post ids; pfbid slugs are global.
  const tries = /^\d+$/.test(id) ? [`/${conn.page_id}_${id}`, `/${id}`] : [`/${id}`];
  let post = null, lastErr = null;
  for (const pathname of tries) {
    try { post = await graphCall(pathname, { params: { fields }, token: conn.page_token, timeoutMs: TIMEOUT_MS }); break; }
    catch (err) { lastErr = err; if (meta.isAuthError(err)) throw err; }
  }
  if (!post) throw fail("page_unreadable", lastErr ? lastErr.message : "graph failed");
  const text = String(post.message || "").trim();
  const photos = attachmentImages(post).map((u) => ({ url: u, source: "facebook" }));
  if (!text && !photos.length) throw fail("page_unreadable", "empty post");
  return { source: "facebook", text, description: text, photos };
}

// ── firecrawl ──
async function fromFirecrawl({ url }, { fetchFn = fetch, firecrawlKey = process.env.FIRECRAWL_API_KEY, lookup }) {
  if (!(await isPublicUrl(url, lookup))) throw fail("invalid_input", "url not allowed");
  if (!firecrawlKey) throw fail("extract_unavailable", "FIRECRAWL_API_KEY is not set");
  let data;
  try {
    const r = await fetchFn(FIRECRAWL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${firecrawlKey}` },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) throw fail("page_unreadable", `firecrawl ${r.status}`);
    data = (await r.json()).data || {};
  } catch (err) {
    if (err.code) throw err;
    throw fail("page_unreadable", err.message);
  }
  const text = String(data.markdown || "").trim();
  if (!text) throw fail("page_unreadable", "empty page");
  const description = String((data.metadata && data.metadata.description) || "").trim() || text;
  return { source: "scrape", text, description, photos: listingImages(text).map((u) => ({ url: u, source: "scrape" })) };
}

async function resolve(input, deps = {}) {
  const kind = sourceFor(input);
  if (kind === "text") { const text = input.text.trim(); return { source: "text", text, description: text, photos: [] }; }
  if (kind === "facebook") return fromFacebook(input, deps);
  return fromFirecrawl(input, deps);
}

module.exports = { resolve, isPublicUrl, TIMEOUT_MS, _test: { sourceFor, facebookPostId, listingImages, isPrivateIp, attachmentImages } };
