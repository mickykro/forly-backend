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
  composer: 'div[role="main"] [role="button"]:has-text("כתבו משהו"), div[role="main"] [role="button"]:has-text("Write something"), div[role="main"] [role="button"]:has-text("What\'s on your mind")', // [Unverified]
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
  feedPostAuthor: 'h2 strong, h3 strong, h4 strong', // [Unverified]
  postMessage: 'div[role="main"] div[data-ad-preview="message"], div[role="main"] div[data-ad-comet-preview="message"]', // [Unverified] on a permalink page
  postAuthor: 'div[role="main"] h2 strong, div[role="main"] h3 strong', // [Unverified]
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

const norm = (s) => (s === undefined || s === null ? "" : String(s)).normalize("NFC").replace(/\s+/g, " ").trim();
// The post's text fingerprint: the same hash as copy_hash, over the normalised text.
const fingerprint = (s) => sha(norm(s));
const FB_HOST = /^(www\.|m\.|web\.)?facebook\.com$/i;
const SEG = /^[A-Za-z0-9._-]+$/;
const POST_ID = /^[A-Za-z0-9]+$/;

// [Unverified] (M6, Task 24): Facebook may render an emoji as <img alt>;
// innerText drops it, so an editor holding the copy would read without the
// emoji and the proof would fail closed (copy_mismatch). Calibrate there.
// ── reads (never throw; a failed read is "" / null / -1) ──
async function textOf(page, sel) {
  try { return norm(await page.locator(sel).first().innerText()); } catch { return ""; }
}
async function attrOf(page, sel, name) {
  try { return String((await page.locator(sel).first().getAttribute(name)) || ""); } catch { return ""; }
}
// -1 when the count itself could not be read: callers treat that as "not proven".
async function countOf(page, sel) {
  try { const n = await page.locator(sel).count(); return Number.isInteger(n) ? n : -1; } catch { return -1; }
}

// The canonical numeric id from the page's own metadata, or null.
async function readTargetId(page, kind) {
  const app = await attrOf(page, SELECTORS.targetIdMeta, "content");
  const m = app.match(/^fb:\/\/(group|page|profile)\/(?:\?id=)?(\d+)/);
  if (m && (kind === "group" ? m[1] === "group" : m[1] !== "group")) return m[2];
  const og = await attrOf(page, SELECTORS.targetUrlMeta, "content");
  const g = kind === "group" ? og.match(/facebook\.com\/groups\/(\d+)(?:[/?#]|$)/) : og.match(/facebook\.com\/profile\.php\?id=(\d+)/);
  return g ? g[1] : null;
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
  const t = norm(text).replace(/\s*(…|\.\.\.)?\s*(see more|ראה עוד|הצגת עוד|עוד)$/i, "").replace(/…$/, "").trim();
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
  return page.$$eval(SELECTORS.feedPost, (els, s) => els.slice(0, 15).map((el) => {
    const link = el.querySelector(s.link), msg = el.querySelector(s.text), au = el.querySelector(s.author);
    return { href: link ? link.href : null, text: msg ? msg.innerText || msg.textContent || "" : "", author: au ? au.innerText || au.textContent || "" : "" };
  }), { link: SELECTORS.feedPostLink, text: SELECTORS.feedPostText, author: SELECTORS.feedPostAuthor }).catch(() => []);
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
  const no = (code) => ({ ok: false, code });
  const label = norm(conn && conn.facebook_identity_label);
  const header = await textOf(page, SELECTORS.identity);
  if (!label || header !== label) return no("identity_mismatch");

  const want = expectedTarget(attempt || {}, conn);
  if (!want.ok) return no(want.code);
  const kind = attempt.target_type;
  const wantId = want.id || (kind === "group" && /^\d+$/.test(String(opts.resolvedGroupId || "")) ? String(opts.resolvedGroupId) : null);
  const id = await readTargetId(page, kind);
  if (!wantId || id !== wantId) return no("destination_mismatch");
  const name = await textOf(page, SELECTORS.targetName);
  if (!name || (want.name && name !== want.name)) return no("destination_mismatch");

  // Exactly one composer: two open composers (a stale draft) could make any
  // read below — or the click after it — land in the wrong one.
  if ((await countOf(page, SELECTORS.composerRoot)) !== 1) return no("destination_mismatch");
  const author = await textOf(page, SELECTORS.composerAuthor);
  if (kind === "group") {
    const join = await countOf(page, SELECTORS.joinGroup);
    if (join < 0) return no("markers_missing"); // unreadable is not evidence of leaving
    if (join > 0) return no("not_member");
    if ((await textOf(page, SELECTORS.composerTarget)) !== name) return no("destination_mismatch");
    if (author !== label) return no("identity_mismatch");
  } else if (author !== name) return no("identity_mismatch"); // it must post AS the Page

  const copy = opts.copy;
  if (typeof copy !== "string" || !norm(copy) || sha(copy) !== attempt.copy_hash) return no("copy_mismatch");
  if ((await textOf(page, SELECTORS.editor)) !== norm(copy)) return no("copy_mismatch");
  return { ok: true };
}

module.exports = {
  SELECTORS, norm, fingerprint, sha,
  textOf, attrOf, countOf, readSignal, regionTexts, readTargetId, readFeedPosts, urlSegment, permalinkOf, findOwnPost, isCutOf,
  expectedTarget, proveIdentityAndDestination,
};
