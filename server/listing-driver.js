/*
 * listing-driver.js — the Driver-backed listing source.
 *
 * Yad2 and Madlan render their facts with JavaScript and sit behind bot
 * defences that answer Firecrawl with a challenge page; a Facebook group post
 * is invisible without a session. All three are readable in a real browser.
 *
 * The result is deliberately the SAME shape fromFirecrawl() returns, so
 * listing-extract.js and every caller stay untouched: the page's innerText
 * carries the "label:value" lines the Hebrew prompt already knows how to read.
 */
const { MAX_PHOTOS, IMAGE_EXT, NOT_LISTING } = require("./listing-sources");
const driver = require("./driver-browser");

const GOTO_TIMEOUT_MS = 45000;

function fail(code, msg) { const e = new Error(msg || code); e.code = code; return e; }

// Same filters the markdown path uses, applied to <img> srcs instead.
function pickImages(srcs) {
  const out = [];
  for (const raw of srcs || []) {
    const src = String(raw || "");
    if (!/^https?:\/\//.test(src)) continue;
    if (!IMAGE_EXT.test(src) || NOT_LISTING.test(src) || out.includes(src)) continue;
    out.push(src);
    if (out.length >= MAX_PHOTOS) break;
  }
  return out;
}

const LOGIN_URL = /\/(login|accounts\/login|checkpoint|signin)(\/|\?|$)/i;

function isLoginWall(landedUrl, text) {
  if (LOGIN_URL.test(String(landedUrl || ""))) return true;
  const t = String(text || "");
  return t.length < 400 && /(log in to continue|יש להתחבר כדי להמשיך)/i.test(t);
}

// The listing's own description, not the whole page: innerText also carries
// the site's menus, the price box, the contact form and the transaction
// history. In order:
//  1. the heading "תיאור הנכס" (Madlan) up to the next section heading;
//  2. no heading (Yad2): the text just above "מפה" / "פרטים נוספים", back to
//     the "4חדריםקומה8/9116מ״ר" facts line — only when that line is found;
//  3. the page's meta description;
//  4. the text itself only when it is short enough to be just the listing (a
//     group post); otherwise empty — the agent writes their own.
const DESC_HEAD = /^(תיאור הנכס|תיאור הדירה|תיאור המודעה|תיאור|על הנכס)[:：]?$/;
const DESC_STOP = /^(מפרט מלא|פרטים נוספים|מידע נוסף( על הנכס)?|מאפייני הנכס|מה יש בנכס|יתרונות הנכס|יצירת קשר|חשוב לדעת|היסטוריית עסקאות|הציגו מספר טלפון|יש טעות במודעה\?.*|מודעות דומות|נכסים דומים)$/;
const DESC_MORE = /^(קרא(ו)? עוד|הצג(ו)? עוד|עוד|הצג פחות|קרא פחות)$/;
const DESC_MAX = 3000;
const BLOCK_END = /^(מפה|פרטים נוספים)$/;
const FACTS_LINE = /^\d+(\.\d+)?\s*חדרים/;
const INVISIBLE = /[\u200b-\u200f\u2060\ufeff]/g;
const SHORT_PAGE = 1500;
function descriptionOf(text, meta) {
  const lines = String(text || "").split("\n").map((l) => l.replace(INVISIBLE, "").trim());
  const tidy = (arr) => arr.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, DESC_MAX);
  const at = lines.findIndex((l) => DESC_HEAD.test(l));
  if (at >= 0) {
    const out = [];
    for (const l of lines.slice(at + 1)) {
      if (DESC_STOP.test(l) || DESC_HEAD.test(l)) break;
      if (!DESC_MORE.test(l)) out.push(l);
    }
    const d = tidy(out);
    if (d.length >= 20) return d;
  }
  const end = lines.findIndex((l) => BLOCK_END.test(l));
  if (end > 0) {
    const out = [];
    for (let i = end - 1; i >= 0 && i >= end - 40; i--) {
      if (FACTS_LINE.test(lines[i])) {
        const d = tidy(out.reverse());
        if (d.length >= 20) return d;
        break;
      }
      out.push(lines[i]);
    }
  }
  const m = String(meta || "").trim();
  if (m.length >= 20) return m.slice(0, DESC_MAX);
  const t = String(text || "").trim();
  return t.length <= SHORT_PAGE ? t : "";
}

// A Facebook post's page is the whole Facebook screen around it: the menu,
// stories, the feed, sponsored posts and the comments. Read only the post: its
// message element, and the large images of the post itself (not avatars, story
// thumbnails or UI icons). The post opens either as a dialog over the feed or
// on its own page. [Unverified] selectors — Facebook's markup changes.
const FB_HOST = /(^|\.)facebook\.com$/i;
const FB_MESSAGE = '[data-ad-rendering-role="story_message"], [data-ad-comet-preview="message"], [data-ad-preview="message"]';
const FB_MIN_PHOTO = 200;
const SEE_MORE = /^\s*(…\s*)?(ראה עוד|See more)\s*$/;
// Runs in the page (page.evaluate serialises it): no outer references.
function scopeFacebookPost({ sel, minPhoto }) {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((d) => d.querySelector(sel));
  const scope = dialogs[dialogs.length - 1] || document.querySelector('[role="main"]');
  const msg = scope && scope.querySelector(sel);
  if (!msg) return null;
  const big = (i) => (i.naturalWidth || i.width || 0) >= minPhoto && !/\/rsrc\.php\//.test(i.currentSrc || i.src);
  // The post's own box: its article, or the nearest ancestor of the message
  // that holds a photo — never climbing past the dialog/main it sits in.
  let box = msg.closest('[role="article"]');
  if (!box || !scope.contains(box)) {
    box = null;
    for (let el = msg, n = 0; el && n < 8; el = el.parentElement, n++) {
      if ([...el.querySelectorAll("img")].some(big)) { box = el; break; }
      if (el === scope) break;
    }
  }
  const srcs = box ? [...box.querySelectorAll("img")].filter(big).map((i) => i.currentSrc || i.src) : [];
  // Facebook shows at most five tiles; the last one says "+4" when there are
  // more. The rest are only reachable through the photo viewer.
  let more = 0, firstPhoto = null;
  if (box) {
    for (const el of box.querySelectorAll("*")) {
      const m = el.childElementCount === 0 && /^\+\s*(\d{1,3})$/.exec((el.textContent || "").trim());
      if (m) { more = Number(m[1]); break; }
    }
    const a = [...box.querySelectorAll('a[href*="/photo"]')].find((x) => [...x.querySelectorAll("img")].some(big));
    if (a) firstPhoto = { href: a.href, selector: `a[href="${CSS.escape(a.getAttribute("href"))}"]` };
  }
  return { text: msg.innerText, srcs, more, firstPhoto };
}

// Runs in the page: the largest visible image — in the photo viewer, the photo.
function largestImage(minPhoto) {
  let best = null, area = 0;
  for (const i of document.querySelectorAll("img")) {
    const src = i.currentSrc || i.src;
    const r = i.getBoundingClientRect();
    if (!src || /\/rsrc\.php\//.test(src) || r.width < minPhoto || r.bottom < 0 || r.top > innerHeight) continue;
    if (r.width * r.height > area) { area = r.width * r.height; best = src; }
  }
  return best;
}

// The whole album, one photo at a time: open the first photo and step with
// the arrow key, as a person browsing it would, until it comes back around or
// stops changing. At a reading pace — this is the agent's own account.
async function readAlbum(page, first, want, deps = {}) {
  const rand = deps.rand || Math.random;
  const key = (u) => String(u || "").split("?")[0];
  try { await page.locator(first.selector).first().click({ timeout: 3000 }); }
  catch (e) { await page.goto(first.href, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS }); }
  const out = [], seen = new Set();
  let prev = null;
  for (let i = 0; i < want; i++) {
    let src = null;
    for (let t = 0; t < 20; t++) { // up to ~5 s for the next photo to show
      src = await page.evaluate(largestImage, FB_MIN_PHOTO).catch(() => null);
      if (src && key(src) !== key(prev)) break;
      await page.waitForTimeout(250);
    }
    if (!src || key(src) === key(prev) || seen.has(key(src))) break;
    seen.add(key(src)); out.push(src); prev = src;
    if (out.length >= want) break;
    await page.waitForTimeout(500 + Math.floor(rand() * 700));
    await page.keyboard.press("ArrowRight");
  }
  return out;
}
async function readFacebookPost(page) {
  // A long post is cut at "ראה עוד"; open it, as a reader would.
  try {
    const buttons = FB_MESSAGE.split(", ").map((s) => `${s} [role="button"]`).join(", ");
    const dialog = page.locator('[role="dialog"]').filter({ has: page.locator(FB_MESSAGE) });
    const scope = (await dialog.count()) ? dialog.last() : page.locator('[role="main"]');
    await scope.locator(buttons).filter({ hasText: SEE_MORE }).first().click({ timeout: 1500 });
    await page.waitForTimeout(400);
  } catch (e) { /* no "see more", or not clickable: read what is shown */ }
  let post;
  try { post = await page.evaluate(scopeFacebookPost, { sel: FB_MESSAGE, minPhoto: FB_MIN_PHOTO }); }
  catch (e) { return null; }
  if (post && post.more > 0 && post.firstPhoto) {
    try {
      const album = await readAlbum(page, post.firstPhoto, Math.min(MAX_PHOTOS, post.srcs.length + post.more));
      // Only when the viewer gave at least what the post showed.
      if (album.length > post.srcs.length) post.srcs = album;
    } catch (e) { /* keep the photos the post showed */ }
  }
  return post;
}

async function readPage(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
  // Auto-waiting, not a fixed sleep: settle on the network going quiet, and
  // carry on regardless if it never does — a chatty analytics beacon must not
  // cost us the scrape.
  if (page.waitForLoadState) await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  let host = "";
  try { host = new URL(url).hostname; } catch (e) { host = ""; }
  const post = FB_HOST.test(host) && page.evaluate ? await readFacebookPost(page) : null;
  if (post && String(post.text || "").trim().length >= 10) {
    const text = String(post.text).split("\n").filter((l) => !SEE_MORE.test(l)).join("\n").trim();
    return { landedUrl: page.url(), text, srcs: post.srcs || [], meta: null };
  }
  const text = String(await page.innerText("body")).trim();
  const srcs = page.imageSrcs
    ? await page.imageSrcs()
    : await page.$$eval("img", (els) => els.map((e) => e.currentSrc || e.src).filter(Boolean));
  let meta = null;
  try { meta = await page.$eval('meta[property="og:description"], meta[name="description"]', (e) => e.content); } catch (e) { meta = null; }
  return { landedUrl: page.url(), text, srcs, meta };
}

async function fromDriver(input, deps = {}) {
  const withPage = deps.withPage || driver.withPage;
  // resolve() hands these through `deps` (extract-jobs sets them per attempt);
  // a direct caller passes them on the input. Accept both, input wins.
  const url = input.url;
  const profileName = input.profileName || deps.profileName || null;
  const browserType = input.browserType || deps.browserType || null;
  const opts = {
    duration: 300,
    note: `forly-extract:${deps.jobId || "adhoc"}`,
    type: browserType || "hosted",
    // driver-browser.createSession also enforces this on every real session;
    // set here too since withPage is stubbed directly in tests and by any
    // caller that bypasses createSession's own SESSION_DEFAULTS merge.
    country: "IL",
  };
  if (profileName) opts.profile = { name: profileName, persist: true };

  // Whose profile it is, so withPage can assert ownership and take (or, with
  // lockHeld, trust the caller's) profile lock. Ignored when there is no profile.
  // deps.conn (I2): the connection, so withPage checks the profile's generation
  // and refuses a revoked or quarantined one.
  const owner = { phone: deps.phone, platform: deps.platform, lockHeld: deps.lockHeld, conn: deps.conn || null };
  const { landedUrl, text, srcs, meta } = await withPage(opts, (page) => readPage(page, url), owner);
  if (isLoginWall(landedUrl, text)) throw fail("social_login_required", "login wall");
  const photos = pickImages(srcs).map((u) => ({ url: u, source: "driver" }));
  if (!text && !photos.length) throw fail("page_unreadable", "empty page");
  if (!text) throw fail("page_unreadable", "no text");
  return { source: "driver", text, description: descriptionOf(text, meta), photos };
}

module.exports = { fromDriver, _test: { pickImages, isLoginWall, readPage, descriptionOf, scopeFacebookPost, readAlbum, FB_MESSAGE } };
