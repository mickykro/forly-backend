/*
 * listing-sweep.js — read an agent's own Yad2/Madlan "my ads" page and turn
 * each ad into a listing draft.
 *
 * Isolation (a reviewed security boundary, not a shortcut): this file's
 * browser session holds the agent's login cookies. It reads ONLY
 * {source_url, title, price} off one fixed, known "my ads" URL — never the
 * free text of an arbitrary listing page. The full listing (description,
 * photos) is fetched afterward by a SEPARATE, non-authenticated extract job
 * (extract-jobs.js, forceSource:"driver", no profile), so page content can
 * never steer the browser that holds the account's session.
 *
 * Task 26 (site-dwell.js, anti-detection browsing before the read) is out of
 * scope here — not implemented, not called.
 */
const crypto = require("crypto");
const driverLive = require("./driver-browser");
const extractJobsLive = require("./extract-jobs");
const locksLive = require("./profile-lock");
const { profileName } = require("./profile-name");
const { isLoginWall } = require("./listing-driver")._test;

const GOTO_TIMEOUT_MS = 45000;
const ALLOWED_HOST = /(^|\.)(yad2\.co\.il|madlan\.co\.il)$/i;

function fail(code, msg) { const e = new Error(msg || code); e.code = code; return e; }

function assertAllowedUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch (e) { throw fail("invalid_input", "bad url"); }
  if (u.protocol !== "https:" || !ALLOWED_HOST.test(u.hostname)) throw fail("invalid_input", "host not allowed");
  return u;
}

// Untrusted (scraped) text, capped and markup-stripped before it reaches a
// draft — the swept title is agent-visible, never agent-authored.
const MAX_TITLE = 200;
function cleanText(s) {
  return String(s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
}

// ponytail: local fingerprint, not posting-safety.js's — that file is Phase
// 3, out of scope. Upgrade to the shared one when Phase 3 lands.
function fingerprint(title, price) {
  const norm = cleanText(title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return crypto.createHash("sha256").update(`${norm}|${Number(price) || 0}`).digest("hex").slice(0, 16);
}

// Idempotency key: same phone+platform+ad is always the same draft id, so a
// re-sweep is a plain get-by-id instead of a scan-and-compare.
function draftKey(phone, platform, sourceId) {
  return crypto.createHmac("sha256", String(process.env.PROFILE_KEY || "dev"))
    .update(`${phone}|${platform}|${sourceId}`).digest("hex");
}

function sourceIdFromUrl(url) {
  const clean = String(url).split(/[?#]/)[0].replace(/\/+$/, "");
  const parts = clean.split("/");
  return parts[parts.length - 1] || clean;
}

async function readMyAds(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
  if (page.waitForLoadState) await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  const text = String(await page.innerText("body")).trim();
  // Selectors are site-specific and [Unverified] in the plan; page.myAds()
  // is the same test-injection seam listing-driver.js uses for imageSrcs().
  const ads = page.myAds ? await page.myAds() : [];
  return { landedUrl: page.url(), text, ads };
}

const nowIso = () => new Date().toISOString();

async function sweep({ platform, phone }, deps) {
  const db = deps.db;
  const locks = deps.locks || locksLive;
  const extractJobs = deps.extractJobs || extractJobsLive;
  const platforms = deps.platforms || require("./routes/connections-browser").PLATFORMS;
  const spec = platforms[platform];
  if (!spec) throw fail("invalid_input", "unknown platform");

  const conn = (await db.getConnection(phone)) || {};
  if (!conn[`${platform}_browser_connected_at`]) throw fail("invalid_input", "not connected");

  const release = locks.tryAcquire(phone, platform);
  if (!release) return { found: 0, queued: 0, skipped: 0 }; // profile busy elsewhere; next sweep

  try {
    const url = assertAllowedUrl(spec.checkUrl).href;
    const withPage = deps.withPage || driverLive.withPage;
    const opts = {
      duration: 300, note: `forly-sweep:${platform}`, type: "hosted", country: "IL",
      // The CURRENT generation's name (I2): after a reconnect the old name is refused.
      profile: { name: profileName(platform, phone, conn[`${platform}_profile_gen`] || 0), persist: true },
    };
    // We hold the lock (above); withPage still asserts the name is this
    // phone's, and refuses a revoked or quarantined connection.
    const { landedUrl, text, ads } = await withPage(opts, (page) => readMyAds(page, url), { phone, platform, lockHeld: true, conn });
    if (isLoginWall(landedUrl, text)) throw fail("social_login_required", "login wall");

    const listings = await db.listListingsByPhone(phone);
    const pageFingerprints = new Set(listings.map((l) => fingerprint(l.address, l.price)));

    let queued = 0, skipped = 0;
    for (const ad of ads || []) {
      assertAllowedUrl(ad.url); // never trust a scraped href past the allowlist
      const title = cleanText(ad.title);
      const price = Number(ad.price) || 0;
      const sourceId = sourceIdFromUrl(ad.url);
      if (pageFingerprints.has(fingerprint(title, price))) { skipped++; continue; }
      const id = draftKey(phone, platform, sourceId);
      if (await db.getListingDraft(id)) { skipped++; continue; }

      await db.saveListingDraft({
        id, phone: String(phone), platform, source_url: ad.url, source_id: sourceId,
        title, price, status: "queued", extract: null, error_code: null,
        page_id: null, created_at: nowIso(), updated_at: nowIso(), dismissed_at: null,
      });
      // Separate, non-authenticated job: no profile, so this untrusted page's
      // own content can never steer the browser that holds the login.
      await extractJobs.create({ phone, url: ad.url, forceSource: "driver", draftId: id }, { db });
      queued++;
    }
    return { found: (ads || []).length, queued, skipped };
  } finally {
    release();
  }
}

function liveDeps() {
  return { db: require("./db") };
}

module.exports = {
  sweep, fingerprint, draftKey, sourceIdFromUrl, liveDeps,
  _test: { readMyAds, assertAllowedUrl, cleanText, ALLOWED_HOST },
};
