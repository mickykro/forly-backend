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

async function readPage(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
  // Auto-waiting, not a fixed sleep: settle on the network going quiet, and
  // carry on regardless if it never does — a chatty analytics beacon must not
  // cost us the scrape.
  if (page.waitForLoadState) await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
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

module.exports = { fromDriver, _test: { pickImages, isLoginWall, readPage, descriptionOf } };
