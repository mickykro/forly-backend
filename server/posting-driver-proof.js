/*
 * posting-driver-proof.js — what Facebook's page looks like (SELECTORS), the
 * page reads posting-driver.js makes, and the R3 proof built on them. Split
 * out of posting-driver.js to keep both under their line budget; nothing
 * outside the driver should need this file except its tests.
 *
 * R3: identity and destination are proven before Post, by exact comparison
 * of normalised strings (NFC, whitespace collapsed, trimmed) — no fuzzy
 * matching, no selector-based guessing. A read that returns nothing is a
 * mismatch: every check here fails closed.
 *
 * [Unverified] Every selector is a starting point; Task 24's dry run fixes
 * them against the live page. dialog/alert/captchaFrame are social-dwell's
 * own (its readSignal reads them), so the two files can never disagree.
 */
const { sha } = require("./posting-campaign");
const SD = require("./social-dwell");
const { classifySignal, REGION_CAP } = require("./posting-signals");

// The composer's root: the INNERMOST dialog that holds the editor — one that
// contains no other such dialog (fix round 2). A modal layer or a
// restriction dialog wrapping the composer is therefore not a second root.
// The editor, Post, target and author are all found inside it.
const EDITOR = 'div[contenteditable="true"][role="textbox"]';
const COMPOSER_ROOT = `div[role="dialog"]:has(${EDITOR}):not(:has(div[role="dialog"] ${EDITOR}))`; // [Unverified]

const SELECTORS = {
  identity: 'div[role="banner"] a[href$="/me/"] span, div[role="banner"] [aria-label="Your profile"], div[role="banner"] [aria-label="הפרופיל שלך"]', // [Unverified]
  targetName: 'div[role="main"] h1', // [Unverified] the group's / Page's own header
  targetIdMeta: 'meta[property="al:android:url"]', // [Unverified] fb://group/<id>, fb://page/<id>, fb://profile/<id>
  targetUrlMeta: 'meta[property="og:url"]', // [Unverified]
  joinGroup: 'div[role="main"] div[aria-label="Join group"][role="button"], div[role="main"] div[aria-label="הצטרפות לקבוצה"][role="button"]', // [Unverified]
  // "כאן כותבים" is what a live Hebrew group page showed (a failed run's screenshot); the rest are guesses.
  composer: 'div[role="main"] [role="button"]:has-text("כאן כותבים"), div[role="main"] [role="button"]:has-text("כתבו משהו"), div[role="main"] [role="button"]:has-text("Write something"), div[role="main"] [role="button"]:has-text("What\'s on your mind")', // [Unverified]
  composerRoot: COMPOSER_ROOT,
  editor: `${COMPOSER_ROOT} ${EDITOR}`, // [Unverified]
  // Scoped to the composer root (fix round 1, M5): nothing outside our own
  // composer can be read as its target or author, or clicked as its Post.
  composerTarget: `${COMPOSER_ROOT} a[href*="/groups/"][role="link"]`, // [Unverified] the dialog names the group
  composerAuthor: `${COMPOSER_ROOT} h2 ~ div strong, ${COMPOSER_ROOT} [role="heading"] ~ div strong`, // [Unverified] who it posts as
  submit: `${COMPOSER_ROOT} div[aria-label="פרסום"][role="button"], ${COMPOSER_ROOT} div[aria-label="Post"][role="button"]`, // [Unverified]
  discard: 'div[role="dialog"] div[aria-label="מחיקה"][role="button"], div[role="dialog"] div[aria-label="Discard"][role="button"]', // [Unverified]
  dialog: SD.SELECTORS.dialog,
  alert: SD.SELECTORS.alert,
  captchaFrame: SD.SELECTORS.captchaFrame,
  feedPost: 'div[role="feed"] > div', // [Unverified]
  chronoMarker: 'div[role="main"] [aria-label="New posts"], div[role="main"] [aria-label="פוסטים חדשים"]', // [Unverified] the group feed's "New posts" sort
  feedPostText: 'div[data-ad-preview="message"], div[data-ad-comet-preview="message"]', // [Unverified]
  feedPostLink: 'a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid="]', // [Unverified]
  // Calibrated 2 Oct 2026: the author's name sits in an <h2> marked profile_name, with no <strong>.
  feedPostAuthor: '[data-ad-rendering-role="profile_name"], h2 strong, h3 strong, h4 strong',
  postMessage: 'div[role="main"] div[data-ad-preview="message"], div[role="main"] div[data-ad-comet-preview="message"]', // [Unverified] on a permalink page
  // Calibrated 2 Oct 2026: a post opened from a group shows as a dialog over the feed ("הפוסט של …").
  postDialogMessage: 'div[role="dialog"] div[data-ad-preview="message"], div[role="dialog"] div[data-ad-comet-preview="message"]',
  postDialogAuthor: 'div[role="dialog"] [data-ad-rendering-role="profile_name"]',
  postAuthor: 'div[role="main"] [data-ad-rendering-role="profile_name"], div[role="main"] h2 strong, div[role="main"] h3 strong',
  commentBox: 'div[aria-label^="כתיבת תגובה"], div[aria-label^="Write a comment"]', // [Unverified]
  commentSubmit: 'div[aria-label="תגובה"][role="button"], div[aria-label="Comment"][role="button"]', // [Unverified]
  // The post's video (posting-media.js), all inside our own composer: its
  // file input, else its Photo/video button (then a drop zone that opens the
  // file chooser); attached = a preview; uploading = a progress bar.
  mediaInput: `${COMPOSER_ROOT} input[type="file"]`, // [Unverified]
  mediaButton: `${COMPOSER_ROOT} div[aria-label="תמונה/סרטון"][role="button"], ${COMPOSER_ROOT} div[aria-label="Photo/video"][role="button"]`, // [Unverified]
  mediaDrop: `${COMPOSER_ROOT} [role="button"]:has-text("הוספת תמונות/סרטונים"), ${COMPOSER_ROOT} [role="button"]:has-text("Add photos/videos")`, // [Unverified]
  mediaAttached: `${COMPOSER_ROOT} video, ${COMPOSER_ROOT} img[src^="blob:"]`, // [Unverified]
  mediaProgress: `${COMPOSER_ROOT} [role="progressbar"]`, // [Unverified]
};

// Invisible format characters are dropped before comparing: bidi marks and
// isolates (Facebook wraps names in them on an RTL page), zero-width
// space/non-joiner, word joiner, BOM, and the emoji variation selector
// (U+FE0F: the same emoji is written with and without it). The zero-width
// JOINER stays — it is part of an emoji sequence. Both sides of every
// comparison go through this, so what is compared is still exact.
const INVISIBLE = /[\u200b\u200c\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufe0f\ufeff]/g;
const norm = (s) => (s === undefined || s === null ? "" : String(s)).normalize("NFC").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
// The post's text fingerprint: the same hash as copy_hash, over the normalised text.
const fingerprint = (s) => sha(norm(s));
const FB_HOST = /^(www\.|m\.|web\.)?facebook\.com$/i;
const SEG = /^[A-Za-z0-9._-]+$/;
const POST_ID = /^[A-Za-z0-9]+$/;

// In the page. An element's text as innerText gives it — plus the emoji
// Facebook renders as <img alt="😇">, which innerText drops (M6): a group
// name, a post or an editor holding an emoji would otherwise read without it
// and fail closed on a page that is right. Only an <img> whose alt is
// nothing but emoji counts (never an avatar's alt, a name). With no such
// image the result IS innerText; with one, the subtree is walked the way
// innerText reads it (hidden parts skipped, a line break around each block).
// readDom(el) → its text; readDom(els) → [{ href, text }] (a list of links);
// readDom(els, { link, text, author }) → the first 15 feed posts.
function readDom(target, s) {
  const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component})+$/u, PICT = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;
  const text = (el) => {
    const plain = el.innerText || el.textContent || "";
    const imgs = new Set(Array.from(el.querySelectorAll("img[alt]")).filter((i) => EMOJI.test(i.alt) && PICT.test(i.alt)));
    if (!imgs.size) return plain;
    let t = "";
    const walk = (n) => {
      if (n.nodeType === 3) { if (!n.parentElement || getComputedStyle(n.parentElement).visibility !== "hidden") t += n.data; return; }
      if (n.nodeType !== 1) return;
      if (imgs.has(n)) { t += n.alt; return; }
      if (n.tagName === "BR") { t += "\n"; return; }
      const display = getComputedStyle(n).display;
      if (display === "none") return;
      const block = !/^(inline|contents)/.test(display);
      if (block) t += "\n";
      n.childNodes.forEach(walk);
      if (block) t += "\n";
    };
    walk(el);
    return t;
  };
  if (!Array.isArray(target)) return text(target);
  if (!s) return target.map((a) => ({ href: a.href, text: text(a).trim() }));
  return target.slice(0, 15).map((el) => {
    const link = el.querySelector(s.link), msg = el.querySelector(s.text), au = el.querySelector(s.author);
    return { href: link ? link.href : null, text: msg ? text(msg) : "", author: au ? text(au) : "" };
  });
}

// The audience label a group's own composer shows under the author's name.
const GROUP_AUDIENCE = new Set(["קבוצה ציבורית", "קבוצה פרטית", "Public group", "Private group"]);
// In the page: every short text the composer dialog itself shows — its
// heading, who posts, where to — never the editor's (the post's own words
// can't name the group or the author). Emoji images count as their alt.
function chromeTexts(root) {
  const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component})+$/u, out = new Set();
  for (const el of root.querySelectorAll('span, a, strong, h1, h2, h3, h4, [role="heading"], [role="button"]')) {
    if (el.closest('[contenteditable="true"]')) continue;
    let t = "";
    const walk = (n) => {
      if (n.nodeType === 3) t += n.data;
      else if (n.nodeType === 1) { if (n.tagName === "IMG") { if (EMOJI.test(n.alt || "")) t += n.alt; } else n.childNodes.forEach(walk); }
    };
    walk(el);
    if (t.trim() && t.length <= 160) out.add(t);
  }
  return [...out].slice(0, 300);
}
// → the normalised chrome texts of the one open composer ([] when unreadable).
async function composerTexts(page) {
  try {
    const v = await page.locator(SELECTORS.composerRoot).first().evaluate(chromeTexts, null, { timeout: 5000 });
    return Array.isArray(v) ? v.map(norm).filter(Boolean) : [];
  } catch { return []; }
}

// The headings of every open dialog — an opened post's is "הפוסט של <author>".
async function dialogHeadings(page) {
  try {
    const v = await page.locator('div[role="dialog"] h2, div[role="dialog"] [role="heading"]').evaluateAll((els) => els.map((e) => e.textContent || ""));
    return Array.isArray(v) ? v.map(norm).filter(Boolean) : [];
  } catch { return []; }
}

// ── reads (never throw; a failed read is "" / null / -1) ──
async function textOf(page, sel) {
  try {
    const loc = page.locator(sel).first();
    const plain = await loc.innerText({ timeout: 5000 }); // waits for the element, but not 30 s per missing one
    const rich = await Promise.resolve().then(() => loc.evaluate(readDom, null, { timeout: 2000 })).catch(() => null);
    return norm(typeof rich === "string" ? rich : plain);
  } catch { return ""; }
}
// <meta> is in the served HTML or it is not: no 30 s wait for one that never comes.
async function attrOf(page, sel, name) {
  try { return String((await page.locator(sel).first().getAttribute(name, { timeout: 2000 })) || ""); } catch { return ""; }
}

// In the page: the logged-in account's display name from Facebook's own
// bootstrap data — the `CurrentUserInitialData` definition in a
// <script type="application/json"> block. [Unverified] that the block is
// still there; if it is not, this is "" and the banner is read instead.
// Page-owned, not post content: each block is JSON.parse'd and only an ARRAY
// whose first item is that module name counts — a post's text is a string
// inside the JSON and can never become such an array. Two different names → "".
function userNameInPage() {
  const names = new Set();
  const walk = (v) => {
    if (Array.isArray(v) && v[0] === "CurrentUserInitialData") { if (v[2] && typeof v[2].NAME === "string") names.add(v[2].NAME); }
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  for (const sc of document.querySelectorAll('script[type="application/json"]')) {
    const t = sc.textContent || "";
    if (!t.includes('"CurrentUserInitialData"')) continue;
    try { walk(JSON.parse(t)); } catch { /* not JSON: not evidence */ }
  }
  return names.size === 1 ? [...names][0] : "";
}
// Who is logged in: the bootstrap name, else the banner marker. The SAME read
// at connect (routes/connections-browser.js stores it) and in the R3 proof,
// so the two can match exactly. "" when neither says: fails closed.
async function readIdentity(page) {
  let name = "";
  try { name = await page.evaluate(userNameInPage); } catch { name = ""; }
  return (typeof name === "string" && norm(name)) || textOf(page, SELECTORS.identity);
}
// A stored identity label must be a person's name: never empty, never the
// site's own name (a tab title read before the page filled in is "Facebook").
const isPersonName = (s) => { const n = norm(s); return n.length > 0 && n.length <= 120 && !/facebook|פייסבוק/i.test(n); };

// The numeric group id the browser's own address names (/groups/<digits>…),
// or null. The address is the browser's, never page content.
function urlGroupId(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== "https:" || !FB_HOST.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/groups\/(\d+)(?:\/|$)/);
  return m ? m[1] : null;
}
// -1 when the count itself could not be read: callers treat that as "not proven".
async function countOf(page, sel) {
  try { const n = await page.locator(sel).count(); return Number.isInteger(n) ? n : -1; } catch { return -1; }
}

// The canonical numeric id, or null: from the page's own metadata and — for
// a group — from the address the browser landed on. A logged-in group page
// carries neither <meta> (a real run: both absent, the page was right), so
// the address is what is left: Facebook serves group <id> at /groups/<id>
// and a redirect elsewhere changes it. Every source that speaks must say the
// SAME id; two that disagree → null (fails closed). A vanity address names
// no id: such a group still needs the metadata.
async function readTargetId(page, kind) {
  const ids = [];
  const app = await attrOf(page, SELECTORS.targetIdMeta, "content");
  const m = app.match(/^fb:\/\/(group|page|profile)\/(?:\?id=)?(\d+)/);
  if (m && (kind === "group" ? m[1] === "group" : m[1] !== "group")) ids.push(m[2]);
  const og = await attrOf(page, SELECTORS.targetUrlMeta, "content");
  const g = kind === "group" ? og.match(/facebook\.com\/groups\/(\d+)(?:[/?#]|$)/) : og.match(/facebook\.com\/profile\.php\?id=(\d+)/);
  if (g) ids.push(g[1]);
  let landed = null;
  try { landed = kind === "group" ? urlGroupId(page.url()) : null; } catch { landed = null; }
  if (landed) ids.push(landed);
  return ids.length && ids.every((i) => i === ids[0]) ? ids[0] : null;
}

// The first path segment after /groups/ (group) or the first segment (Page).
function urlSegment(url, kind) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== "https:" || !FB_HOST.test(u.hostname)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (kind === "group") return parts[0] === "groups" && SEG.test(parts[1] || "") && parts.length <= 2 ? parts[1] : null;
  if (parts[0] === "groups") return null;
  if (parts[0] === "profile.php") return /^\d+$/.test(u.searchParams.get("id") || "") ? u.searchParams.get("id") : null;
  return parts.length === 1 && SEG.test(parts[0]) ? parts[0] : null;
}

// A post link → its canonical permalink, only when it is under one of `ids`
// (the target's numeric id or its URL segment). Anything else → null.
function permalinkOf(href, kind, ids) {
  let u;
  try { u = new URL(String(href)); } catch { return null; }
  if (u.protocol !== "https:" || !FB_HOST.test(u.hostname)) return null;
  const p = u.pathname.split("/").filter(Boolean);
  if (kind === "group") {
    if (p[0] !== "groups" || !ids.includes(p[1]) || !["posts", "permalink"].includes(p[2]) || !POST_ID.test(p[3] || "")) return null;
    return `https://www.facebook.com/groups/${p[1]}/${p[2]}/${p[3]}/`;
  }
  if (p[0] === "permalink.php") {
    const id = u.searchParams.get("id"), story = u.searchParams.get("story_fbid");
    return ids.includes(id) && POST_ID.test(story || "") ? `https://www.facebook.com/permalink.php?story_fbid=${story}&id=${id}` : null;
  }
  if (!ids.includes(p[0]) || p[1] !== "posts" || !POST_ID.test(p[2] || "")) return null;
  return `https://www.facebook.com/${p[0]}/posts/${p[2]}/`;
}

// Feed text is often cut ("… See more"): a cut prefix only SELECTS a
// candidate to open — it never verifies anything (the permalink page does).
function isCutOf(text, copy) {
  const t = norm(text).replace(/\s*(…|\.\.\.)?\s*(see more|ראו עוד|ראה עוד|הצגת עוד|הצג עוד|עוד)$/i, "").replace(/…$/, "").trim();
  return t.length >= 20 && norm(copy).startsWith(t);
}

// → { permalink, exact } for the newest feed post by `author`, under the
// target, whose text is the copy (exact) or a cut of it; or null.
function findOwnPost(posts, { kind, ids, author, copy }) {
  const fp = fingerprint(copy);
  for (const p of Array.isArray(posts) ? posts : []) {
    const permalink = p && permalinkOf(p.href, kind, ids);
    if (!permalink || !author || norm(p.author) !== author) continue;
    const exact = fingerprint(p.text) === fp;
    if (exact || isCutOf(p.text, copy)) return { permalink, exact };
  }
  return null;
}

// The text of every `sel` region: every text node in document order, with
// each [contenteditable] subtree skipped (what we typed) and a space after
// every element so words never run together. The composer's chrome — an
// inline "You can't post in this group", a restriction dialog wrapping the
// composer — is still read.
//
// Fix round 5 (page-side cost): one page.evaluate with the browser's own
// querySelectorAll (Playwright's selector engine walks the whole DOM per
// query: seconds on a 200k-element thread), searching open shadow roots too
// as that engine does, and a TreeWalker instead of a clone. Whitespace is
// collapsed as the walk goes and it stops once RAW_CAP characters are held,
// so a huge comment thread costs no more than its first few thousand
// characters (classifySignal cuts further, to REGION_CAP). The output is the
// same as the round-4 collapse(clone-and-append).trim().slice(0, RAW_CAP).
// → { regions: [texts of sels[0]'s regions, …], count: matches of countSel }
const RAW_CAP = 2 * REGION_CAP;
function readInPage({ sels, cap, countSel }) {
  const scopes = [document];
  for (let i = 0; i < scopes.length; i++) {
    const w = document.createTreeWalker(scopes[i], NodeFilter.SHOW_ELEMENT);
    for (let el = w.nextNode(); el; el = w.nextNode()) if (el.shadowRoot) scopes.push(el.shadowRoot);
  }
  const all = (sel) => scopes.flatMap((sc) => Array.from(sc.querySelectorAll(sel)));
  const skip = { acceptNode: (n) => (n.nodeType === 1 && n.hasAttribute("contenteditable") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) };
  const textOfRegion = (root) => {
    let t = "";
    const add = (s) => {
      const c = s.replace(/\s+/g, " ");
      t += t === "" || t.endsWith(" ") ? c.replace(/^ /, "") : c;
    };
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, skip);
    let n = w.firstChild();
    while (n && t.length <= cap) {
      if (n.nodeType === 3) add(n.data);
      const down = n.nodeType === 1 ? w.firstChild() : null;
      if (down) { n = down; continue; }
      if (n.nodeType === 1) add(" "); // leaving an element with no children read
      for (n = w.nextSibling(); !n; n = w.nextSibling()) {
        if (!w.parentNode() || w.currentNode === root) { n = null; break; }
        add(" "); // leaving the parent element
      }
    }
    return (t.length > cap ? t : t.trim()).slice(0, cap);
  };
  return { regions: sels.map((sel) => all(sel).map(textOfRegion)), count: countSel ? all(countSel).length : 0 };
}
async function readPage(page, sels, countSel) {
  let out = null;
  try { out = await page.evaluate(readInPage, { sels, cap: RAW_CAP, countSel: countSel || null }); } catch { out = null; }
  // A read that threw (navigation mid-read, a selector querySelectorAll rejects)
  // is NOT an empty page: callers must treat it as "unreadable", never "ok".
  const failed = !out || !Array.isArray(out.regions);
  const regions = sels.map((_, i) => {
    const r = out && Array.isArray(out.regions) && out.regions[i];
    return Array.isArray(r) ? r.map((x) => String(x).slice(0, RAW_CAP)) : [];
  });
  return { regions, count: out && Number.isInteger(out.count) ? out.count : 0, failed };
}
async function regionTexts(page, sel) {
  return (await readPage(page, [sel])).regions[0];
}
// classifySignal over the landed URL, a captcha frame, and every dialog and
// alert/status region SEPARATELY, on its unstripped text: a phrase match is
// excused only when it sits wholly inside a run of that region, at least 10
// characters longer than the phrase (and >= 20), that also occurs in the
// copy (an echo of our own post). One page read for all of it.
async function readSignal(page, copy) {
  const r = await readPage(page, [SELECTORS.dialog, SELECTORS.alert], SELECTORS.captchaFrame);
  const regions = r.regions.flat().map(norm);
  const hasCaptchaFrame = r.count > 0;
  let landedUrl = "";
  try { landedUrl = page.url(); } catch { landedUrl = ""; }
  const sig = classifySignal({ landedUrl, hasCaptchaFrame, ownText: norm(copy), regions });
  // The URL alone can still prove a halt; otherwise a failed read fails closed.
  return r.failed && sig === "ok" ? "unreadable" : sig;
}

async function readFeedPosts(page) {
  return page.$$eval(SELECTORS.feedPost, readDom, { link: SELECTORS.feedPostLink, text: SELECTORS.feedPostText, author: SELECTORS.feedPostAuthor }).catch(() => []);
}

// ── pure checks on the attempt and the connection, before any browser ──
// → { ok: true, id, slug, name, ids } | { ok: false, code }
function expectedGroup(attempt) {
  const slug = urlSegment(attempt.target_url, "group");
  const tid = String(attempt.target_id || "");
  if (!slug) return { ok: false, code: "destination_mismatch" };
  if (/^\d+$/.test(tid)) {
    if (/^\d+$/.test(slug) && slug !== tid) return { ok: false, code: "destination_mismatch" };
    return { ok: true, id: tid, slug, ids: [...new Set([tid, slug])] };
  }
  const m = tid.match(/^slug:(.+)$/);
  if (!m || m[1] !== slug) return { ok: false, code: "destination_mismatch" };
  return { ok: true, id: null, slug, ids: [slug] }; // the numeric id is read on the page (resolved_group_id)
}
function expectedPage(attempt, conn) {
  const pages = Array.isArray(conn && conn.facebook_pages) ? conn.facebook_pages.filter((p) => p && p.id) : [];
  const chosen = ((conn && conn.posting_permission) || {}).page_id;
  if (pages.length > 1 && !chosen) return { ok: false, code: "destination_mismatch" }; // R3: the agent must confirm the Page
  const entry = pages.find((p) => String(p.id) === String(attempt.target_id));
  if (!entry || !/^\d+$/.test(String(entry.id))) return { ok: false, code: "destination_mismatch" };
  if (chosen && chosen !== entry.id && chosen !== entry.url) return { ok: false, code: "destination_mismatch" };
  const seg = urlSegment(attempt.target_url, "page");
  if (!seg) return { ok: false, code: "destination_mismatch" };
  return { ok: true, id: String(entry.id), slug: seg, name: norm(entry.name) || null, ids: [...new Set([String(entry.id), seg])] };
}
function expectedTarget(attempt, conn) {
  if (attempt.target_type === "page") return expectedPage(attempt, conn);
  if (attempt.target_type !== "group") return { ok: false, code: "destination_mismatch" };
  const out = expectedGroup(attempt);
  if (!out.ok) return out;
  // The membership entry by id OR alias (a resolved slug, fix round 2 E).
  const tid = String(attempt.target_id);
  const entry = ((conn && conn.facebook_groups_member) || []).find((e) => e && (e.group_id === tid || (Array.isArray(e.aliases) && e.aliases.map(String).includes(tid))));
  return Object.assign(out, { name: entry && entry.name ? norm(entry.name) : null });
}

/*
 * proveIdentityAndDestination(page, attempt, conn, { copy, resolvedGroupId })
 * → { ok: true } | { ok: false, code } — code ∈ identity_mismatch |
 * destination_mismatch | not_member | copy_mismatch | markers_missing (the
 * membership marker could not be read at all). Runs with the composer
 * open and the copy typed, immediately before the Post click.
 */
async function proveIdentityAndDestination(page, attempt, conn, opts = {}) {
  // check: which check failed; expected/found go to the local failure note only (posting-diag).
  const no = (code, check, expected, found) => ({ ok: false, code, check, expected: expected ?? null, found: found ?? null });
  const label = norm(conn && conn.facebook_identity_label);
  const header = await readIdentity(page);
  if (!label || header !== label) return no("identity_mismatch", label ? "header_name" : "no_identity_label", label, header);

  const want = expectedTarget(attempt || {}, conn);
  if (!want.ok) return no(want.code, "target_address");
  const kind = attempt.target_type;
  const wantId = want.id || (kind === "group" && /^\d+$/.test(String(opts.resolvedGroupId || "")) ? String(opts.resolvedGroupId) : null);
  const id = await readTargetId(page, kind);
  if (!wantId || id !== wantId) return no("destination_mismatch", wantId ? "group_id_on_page" : "group_id_unresolved", wantId, id);
  const name = await textOf(page, SELECTORS.targetName);
  if (!name || (want.name && name !== want.name)) return no("destination_mismatch", "group_name", want.name, name);

  // Exactly one composer: two open composers (a stale draft) could make any
  // read below — or the click after it — land in the wrong one.
  const roots = await countOf(page, SELECTORS.composerRoot);
  if (roots !== 1) return no("destination_mismatch", "composer_count", 1, roots);
  const author = await textOf(page, SELECTORS.composerAuthor);
  if (kind === "group") {
    const join = await countOf(page, SELECTORS.joinGroup);
    if (join < 0) return no("markers_missing", "join_button_unreadable"); // unreadable is not evidence of leaving
    if (join > 0) return no("not_member", "join_button_in_composer", 0, join);
    // The dialog names the group and the author somewhere in its own chrome
    // (today: plain text under "יצירת פוסט", not the link/strong the
    // selectors expected). Still exact: one of its texts IS the name.
    const shown = await composerTexts(page);
    const target = await textOf(page, SELECTORS.composerTarget);
    // Calibrated on the live page (2 Oct 2026): the group composer no longer
    // names its group — it shows the audience ("קבוצה ציבורית") under the
    // author. Which group is proven by the page it was opened on (its id and
    // its header name, both checked above, and exactly one composer); the
    // dialog must still say it posts to a group, or name the group itself.
    const toGroup = target === name || shown.includes(name) || shown.some((t) => GROUP_AUDIENCE.has(t));
    if (!toGroup) return no("destination_mismatch", "composer_target_name", name, target);
    if (author !== label && !shown.includes(label)) return no("identity_mismatch", "composer_author", label, author);
  } else if (author !== name && !(await composerTexts(page)).includes(name)) return no("identity_mismatch", "composer_author", name, author); // it must post AS the Page

  const copy = opts.copy;
  if (typeof copy !== "string" || !norm(copy) || sha(copy) !== attempt.copy_hash) return no("copy_mismatch", "copy_hash");
  const typed = await textOf(page, SELECTORS.editor);
  if (typed !== norm(copy)) return no("copy_mismatch", "editor_text", `${norm(copy).length} chars`, typed == null ? null : `${typed.length} chars: ${typed.slice(0, 80)}`);
  return { ok: true };
}

module.exports = {
  dialogHeadings, composerTexts,
  SELECTORS, norm, fingerprint, sha,
  textOf, attrOf, countOf, readDom, readIdentity, isPersonName, urlGroupId, readSignal, regionTexts, readTargetId, readFeedPosts, urlSegment, permalinkOf, findOwnPost, isCutOf,
  expectedTarget, proveIdentityAndDestination,
};
