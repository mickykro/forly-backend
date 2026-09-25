/*
 * social-dwell.js — be a person on Facebook for a few minutes (Task 17).
 *
 * The anti-ban design leans on this more than on any number in INTERACTION: an
 * account that only ever appears, drops a link and vanishes has no history of
 * being a person. This routine gives it one — reading, watching, the odd like.
 *
 * Two permissions gate what happens (R2, review §10):
 *  - passive dwell (scroll, open a post, let a video play) is part of
 *    connecting and needs no consent beyond the fleet/account switches;
 *  - visible interactions (like, story) additionally need
 *    posting_permission.allows_visible_interactions AND the fleet toggle
 *    (settings/posting.visible_interactions_enabled). Both live in one
 *    place — posting-guard.assertAllowed({action:"like"}) — which
 *    browseSession asks once, non-throwing, to compute `opts.allowVisible`
 *    for dwell(); dwell() skips visible steps entirely when it is false, and
 *    still asks the guard again, immediately before each click (R2), belt
 *    and suspenders.
 *
 * Writes are limited to likes (<= INTERACTION.likes_max per session), never
 * on a post inside the group we are about to post in, never sponsored,
 * sensitive, a competitor, or under INTERACTION.min_reactions, and never a
 * post whose id we already liked this session or — via
 * `opts.recentlyLikedPostIds`, which browseSession fills from
 * posting-store.listRecentLikedPostIds — in the last 30 days. No comments,
 * no follows, no friend requests, no search, no profiles. Nothing is typed.
 *
 * Idempotency (R2): before clicking, the like button's own aria-pressed/label
 * is read — already liked -> skip; after clicking, re-read once; uncertain ->
 * `like_uncertain`, never retried or toggled, and never counted as "liked"
 * (only a confirmed `like` is saved to posting-store.saveDwellSession's
 * `likes: [{post_id, at}]`, which is exactly what the 30-day check reads back).
 *
 * Nothing readable is persisted or logged: no post text, author names, story
 * names, hrefs, cdpUrl or profile names — only action names and, on a like,
 * the numeric Facebook post id, which never leaves this module except as
 * that {post_id, at} pair (browseSession folds everything else into counts
 * before it reaches posting-store).
 *
 * [Unverified] SELECTORS are a starting point; Task 24's dry run fixes them.
 */
const driver = require("./driver-browser");
const guardLive = require("./posting-guard");
const { classifySignal } = require("./posting-safety");

const INTERACTION = {
  scrolls: [3, 6], scroll_pause_s: [4, 12],
  open_posts: [1, 2], read_s: [8, 20],
  video_watch_s: [10, 40],
  like_probability: 0.5, likes_max: 2,
  story_probability: 0.4, stories: [1, 3], story_watch_s: [3, 8],
  min_reactions: 5,
};

const SELECTORS = {
  feedPost: 'div[role="feed"] > div', // [Unverified]
  postLink: 'a[href*="/posts/"]', // [Unverified]
  author: 'h3 a, h4 a, strong a', // [Unverified]
  video: 'video', // [Unverified]
  sponsoredLabel: 'span:has-text("Sponsored"), span:has-text("ממומן"), span:has-text("Suggested for you")', // [Unverified]
  like: 'div[aria-label="לייק"][role="button"], div[aria-label="Like"][role="button"]', // [Unverified]
  commentBox: 'div[aria-label^="כתיבת תגובה"], div[aria-label^="Write a comment"]', // [Unverified]
  follow: 'div[aria-label="עקוב"][role="button"], div[aria-label="Follow"][role="button"]', // [Unverified]
  storyTray: 'div[aria-label="סטוריז"], div[aria-label="Stories"]', // [Unverified]
  storyCard: 'div[aria-label="סטוריז"] a, div[aria-label="Stories"] a', // [Unverified]
  storyClose: 'div[aria-label="סגירה"][role="button"], div[aria-label="Close"][role="button"]', // [Unverified]
  reactionCount: 'span[aria-label*="תגובות"] ~ span, div[aria-label*="reactions"] span, span[aria-hidden="true"]:has(+ span)', // [Unverified]
  commentCount: 'span:has-text("תגובות"), span:has-text("comments")', // [Unverified]
  dialog: 'div[role="dialog"]', // [Unverified]
  alert: '[role="alert"], [role="status"]', // [Unverified]
  captchaFrame: 'iframe[src*="captcha"], iframe[title*="captcha" i]', // [Unverified]
};

// Sensitive topics an ordinary agent account should never be seen reacting
// to — exactly the list R2 gives. Both English and Hebrew matches are
// case-insensitive (the /i flag; Hebrew has no case, English does).
const SENSITIVE_RE = /politic|בחירות|ממשלה|war|מלחמה|חדשות|news|תאונה|accident|בריאות|health|דת|religion|הלוויה|died|נפטר/i;
const SPONSORED_RE = /sponsored|ממומן|suggested for you/i;
// No agency catalog lives in this repo yet (see report: task-17). Exported so
// an operator — or a later task — can fill it without touching the filter
// logic; empty means "no competitor is ever matched", not "skip the check".
const COMPETITOR_PATTERNS = [];

// Soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul/Khmer/
// Mongolian fillers, zero-width space through right-to-left mark, the
// bidi-embedding/override controls, word joiner through nominal digit
// shapes, and the BOM — every character a post could insert between letters
// to read as "sponsored" to a person while defeating a literal regex. Fix
// round 1: stripped, after Unicode NFKC normalisation, before every content-
// filter regex test (sponsored, sensitive, competitor) — on both this
// module's own regex checks and the in-page sponsored-label check in
// readFeed below.
const INVISIBLE_SRC = "[\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\uFEFF]";
const INVISIBLE_RE = new RegExp(INVISIBLE_SRC, "g");
function normalizeForFilter(s) {
  return String(s || "").normalize("NFKC").replace(INVISIBLE_RE, "");
}

const pick = (r, [a, b]) => a + Math.floor(r() * (b - a + 1));
const secs = (r, [a, b]) => Math.round((a + r() * (b - a)) * 1000);

function postIdFromHref(href) {
  const s = String(href || "");
  const m = s.match(/\/posts\/(\d+)/) || s.match(/[?&]story_fbid=(\d+)/) || s.match(/\/permalink\/(\d+)/);
  return m ? m[1] : null;
}

function groupSlug(groupUrl) {
  const m = String(groupUrl || "").match(/\/groups\/([^/?#]+)/);
  return m ? m[1] : null;
}
function isGroupAvoided(p, opts) {
  if (!p.group) return false;
  if (opts.avoidGroupUrl && p.group === opts.avoidGroupUrl) return true;
  const ids = opts.avoidGroupIds || [];
  const slug = groupSlug(p.group);
  return !!slug && ids.includes(slug);
}
// R2's content filter — applied only to the LIKE decision; reading/opening an
// ordinary post (sponsored or not) is unremarkable, leaving a visible like on
// sensitive or sponsored content is not. Text and author are normalised
// (NFKC, invisible characters stripped) before every regex test, so an
// inserted zero-width character cannot slip a sponsored/sensitive post past
// the filter.
function filteredFromLikes(p, opts) {
  if (!p || !p.href) return true;
  const text = normalizeForFilter(p.text);
  const author = normalizeForFilter(p.author);
  if (p.sponsored || SPONSORED_RE.test(text)) return true;
  if (SENSITIVE_RE.test(text)) return true;
  if (COMPETITOR_PATTERNS.some((re) => re.test(text) || re.test(author))) return true;
  if (isGroupAvoided(p, opts)) return true;
  if (!Number.isFinite(p.reactions) || p.reactions < INTERACTION.min_reactions) return true;
  return false;
}

async function readFeed(page) {
  return page.$$eval(SELECTORS.feedPost, (els, sels) => els.slice(0, 12).map((el) => {
    const link = el.querySelector(sels.postLink), auth = el.querySelector(sels.author);
    const href = link ? link.href : null;
    // Normalise in-page too, so the sponsored-label check is not itself
    // defeated by an invisible character (fix round 1).
    const norm = (String(el.textContent || "")).normalize("NFKC").replace(new RegExp(sels.invisibleSrc, "g"), "");
    const text = norm.slice(0, 2000);
    const reactMatch = text.match(/([\d,.]+)\s*(?:reactions|תגובות|לייקים)/i);
    const sponsored = !!el.querySelector(sels.sponsoredLabel) || new RegExp(sels.sponsoredSrc, "i").test(text);
    return {
      href, author: auth ? (auth.textContent || "").trim() : null,
      hasVideo: !!el.querySelector(sels.video),
      sponsored,
      reactions: reactMatch ? Number(reactMatch[1].replace(/[,.]/g, "")) : null,
      text,
      group: href && /\/groups\/([^/?#]+)/.test(href) ? href.replace(/(\/groups\/[^/?#]+).*/, "$1") : null,
    };
  }), {
    postLink: SELECTORS.postLink, author: SELECTORS.author, video: SELECTORS.video, sponsoredLabel: SELECTORS.sponsoredLabel,
    invisibleSrc: INVISIBLE_SRC, sponsoredSrc: SPONSORED_RE.source,
  }).catch(() => []);
}

// R2: called immediately before every visible action, and once before any
// passive dwelling at all (the "dwell" action, which needs no permission —
// only the fleet/account checks). `deps.guard` defaults to the real module.
async function checkGuard(action, deps) {
  const guard = deps.guard || guardLive;
  try {
    await guard.assertAllowed({ phone: deps.phone, platform: deps.platform || "facebook", action }, deps);
    return true;
  } catch (e) {
    if (e && e.code === "posting_disabled") return false;
    throw e;
  }
}

async function readSignal(page) {
  const dialogText = await page.locator(SELECTORS.dialog).first().innerText().catch(() => "");
  const alertText = await page.locator(SELECTORS.alert).first().innerText().catch(() => "");
  const hasCaptchaFrame = (await page.locator(SELECTORS.captchaFrame).first().count().catch(() => 0)) > 0;
  return classifySignal({ landedUrl: page.url(), dialogText, alertText, hasCaptchaFrame });
}

// true (and pressed=false/null) -> not yet liked; true (pressed=true) -> skip.
async function readPressed(loc) {
  if (typeof loc.getAttribute === "function") {
    const v = await loc.getAttribute("aria-pressed").catch(() => null);
    if (v === "true") return true;
    if (v === "false") return false;
  }
  const label = await loc.innerText().catch(() => "");
  if (/הסרת לייק|remove like|unlike/i.test(label)) return true;
  if (/^\s*(לייק|like)\s*$/i.test(label)) return false;
  return null; // unreadable — proceed as "not yet liked", confirmed after the click
}

/*
 * dwell(page, opts, deps) -> Array<{action, at, detail?}>
 *
 * Runs on an already-open page (used by posting-driver, Task 18, before
 * composing, and by browseSession below for its own session).
 * opts: { allowVisible, avoidGroupUrl?, avoidGroupIds?, recentlyLikedPostIds? }
 * deps: { phone, platform, conn, guard, db, env, rand, wait }
 */
async function dwell(page, opts = {}, deps = {}) {
  const r = deps.rand || Math.random;
  const wait = deps.wait || ((ms) => page.waitForTimeout(ms));
  const log = [];
  const note = (action, detail) => log.push(Object.assign({ action, at: new Date().toISOString() }, detail ? { detail } : {}));
  const allowVisible = opts.allowVisible === true;
  const recentlyLiked = new Set(opts.recentlyLikedPostIds || []);

  const blocked = async () => {
    const signal = await readSignal(page);
    if (signal !== "ok") { note("halt", { signal }); return true; }
    return false;
  };

  // R2: the passive routine itself still asks once — an account that is
  // disabled, revoked or fleet-off must not even scroll.
  if (!(await checkGuard("dwell", deps))) return log;

  if (!/facebook\.com\/?$/.test(page.url())) {
    if (await checkGuard("navigate", deps)) {
      await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    }
  }
  if (await blocked()) return log;

  const nScroll = pick(r, INTERACTION.scrolls);
  let feed = [];
  for (let i = 0; i < nScroll; i++) {
    await page.mouse.wheel(0, 300 + Math.floor(r() * 700)); note("scroll");
    feed = await readFeed(page);
    const vid = feed.find((f) => f.hasVideo);
    if (vid && i === Math.floor(nScroll / 2)) { await wait(secs(r, INTERACTION.video_watch_s)); note("watch_video"); }
    await wait(secs(r, INTERACTION.scroll_pause_s));
  }

  // Drawn WITHOUT replacement (fix round 1: with replacement, a small feed
  // could draw — and open, and attempt to like — the same post twice in one
  // session). `attempted` additionally remembers every post id whose like
  // button was clicked or attempted, confirmed or uncertain, this session (on
  // top of `recentlyLiked`, the 30-day cross-session record) — belt and
  // suspenders against two different feed entries resolving to the same id.
  const pool = feed.filter((f) => f.href && !isGroupAvoided(f, opts));
  const attempted = new Set(recentlyLiked);
  let likes = 0;
  const toOpen = Math.min(pick(r, INTERACTION.open_posts), pool.length);
  for (let i = 0; i < toOpen; i++) {
    const p = pool.splice(Math.floor(r() * pool.length), 1)[0];
    const postId = postIdFromHref(p.href);
    if (!(await checkGuard("navigate", deps))) continue;
    await page.goto(p.href, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    note("open_post");
    if (await blocked()) return log; // a checkpoint reached mid-session: stop here
    await wait(secs(r, INTERACTION.read_s));

    if (allowVisible && likes < INTERACTION.likes_max && r() < INTERACTION.like_probability
        && postId && !attempted.has(postId) && !filteredFromLikes(p, opts)) {
      const btn = page.locator(SELECTORS.like).first();
      if ((await btn.count()) > 0) {
        const before = await readPressed(btn);
        if (before !== true) {
          attempted.add(postId); // never click this post's like button again this session
          // R2: the guard is the last await before the click itself.
          if (await checkGuard("like", deps)) {
            await btn.click();
            await wait(1200);
            const after = await readPressed(btn);
            if (after === true) { likes++; note("like", { post_id: postId }); }
            else note("like_uncertain", { post_id: postId }); // never retried or toggled
          }
        }
      }
    }
    try {
      await page.goBack();
    } catch {
      // Fix round 2: the fallback is itself a navigation (R2). Denied ->
      // the routine ends here, with whatever was already logged.
      if (!(await checkGuard("navigate", deps))) return log;
      await page.goto("https://www.facebook.com/");
    }
    await wait(secs(r, [2, 5]));
  }

  if (allowVisible && r() < INTERACTION.story_probability && !(await blocked())) {
    const tray = page.locator(SELECTORS.storyTray).first();
    if ((await tray.count()) > 0) {
      const card = page.locator(SELECTORS.storyCard).first();
      if ((await card.count()) > 0) {
        // R2: the guard is the last await before the click itself.
        if (await checkGuard("story", deps)) {
          await card.click();
          for (let i = 0; i < pick(r, INTERACTION.stories); i++) { await wait(secs(r, INTERACTION.story_watch_s)); note("story"); }
          await page.locator(SELECTORS.storyClose).first().click().catch(() => page.keyboard.press("Escape"));
        }
      }
    }
  }
  return log;
}

// The dwell log, folded into the counts posting-store.saveDwellSession will
// accept — never post ids, hrefs or signals.
function summarize(log) {
  const out = {};
  for (const l of log) { if (l.action === "halt") continue; out[l.action] = (out[l.action] || 0) + 1; }
  return out;
}
function aggregate7d(sessions) {
  const out = { sessions: 0 };
  for (const s of sessions) {
    out.sessions += 1;
    // actions_summary.like already carries the like count; likes itself is
    // the (short, post-id) idempotency record, not a count to sum here.
    for (const [k, v] of Object.entries(s.actions_summary || {})) out[k] = (out[k] || 0) + (Number(v) || 0);
  }
  return out;
}

/*
 * browseSession({ phone, profileName, note }, deps) -> Promise<{ summary, signal }>
 *
 * Its own session: dwell, then stop. Saves a dwell_sessions doc (counts only,
 * posting-store.saveDwellSession) and updates the connection's last_browse_at
 * and dwell_summary_7d. A halting signal is returned, never acted on here —
 * Task 16b's haltAccount owns halts; posting-tick.js's browse() (the sweeper
 * call site) reads `signal` and calls haltAccount itself.
 */
const LIKE_LOOKBACK_DAYS = 30;

async function browseSession({ phone, profileName, note } = {}, deps = {}) {
  const withPage = deps.withPage || driver.withPage;
  const db = deps.db || require("./db");
  const store = deps.store || require("./posting-store");
  const conn = deps.conn || (await db.getConnection(phone)) || {};
  const pageDeps = Object.assign({}, deps, { phone, platform: "facebook", conn });

  if (!(await checkGuard("session", pageDeps))) return { summary: {}, signal: "ok" };

  // Both conditions (account permission, fleet toggle) live in one place —
  // posting-guard's own "like" check — asked here, non-throwing, only to
  // decide whether to attempt visible interactions at all; it is asked again,
  // throwing-checked, immediately before every click inside dwell() (R2).
  const allowVisible = await checkGuard("like", pageDeps);
  const since = Date.now() - LIKE_LOOKBACK_DAYS * 86400000;
  const recentlyLikedPostIds = await store.listRecentLikedPostIds(phone, since).catch(() => new Set());

  const { log, signal } = await withPage(
    { duration: 600, note: note || "forly-dwell:", profile: { name: profileName, persist: true } },
    async (page) => {
      // R2: this is a navigation like any other — guarded like the ones
      // inside dwell() itself (fix round 1: this one used to run unguarded,
      // and since it lands the page on facebook.com before dwell() ever
      // looks, dwell()'s own "already there" branch then never navigates
      // either — no navigation in the common path was guarded at all).
      if (!(await checkGuard("navigate", pageDeps))) return { log: [], signal: "ok" };
      await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      let signal = await readSignal(page);
      if (signal !== "ok") return { log: [], signal };
      const log = await dwell(page, { allowVisible, recentlyLikedPostIds }, pageDeps);
      signal = await readSignal(page);
      return { log, signal };
    },
    pageDeps,
  );

  const summary = summarize(log);
  const at = new Date();
  // Only a confirmed like counts as "liked" for idempotency — like_uncertain
  // is neither retried nor recorded as done, per R2.
  const likes = log.filter((l) => l.action === "like" && l.detail && l.detail.post_id)
    .map((l) => ({ post_id: l.detail.post_id, at: l.at })).slice(0, 5);
  await store.saveDwellSession({
    phone, platform: "facebook", at: at.toISOString(),
    actions_summary: summary, likes, halt_related: signal !== "ok",
  }).catch(() => {});
  const week = await store.listDwellSessionsByPhone(phone, at.getTime() - 7 * 86400000).catch(() => []);
  await db.setConnection(phone, { last_browse_at: at.toISOString(), dwell_summary_7d: aggregate7d(week) }).catch(() => {});

  return { summary, signal };
}

// Visit one of the agent's own posts (Task 22): is it still there, and how
// did it do? `state` (not a boolean) lets the caller tell a confirmed removal
// apart from a flaky load or a login wall.
//
// Fix round 2: `deps` is optional and, when it carries `deps.phone`, guards
// the navigation (R2) before it happens — denied means zero gotos and
// state:"unknown". Task 22's own session wrapper (this function is called on
// an already-open page, not through browseSession) MUST pass `deps` — at
// least `{ phone, platform: "facebook" }` — for this navigation to be
// guarded at all; called with no `deps` (as an ad-hoc read, or from a caller
// that predates this), the navigation runs unguarded, exactly as it always
// did. See task-17-report.md's "Fix round 2" section.
async function recheckPost(page, postUrl, deps = {}) {
  if (deps.phone && !(await checkGuard("navigate", deps))) {
    return { state: "unknown", reactions: null, comments: null, signal: "posting_disabled" };
  }
  await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  // The same signal read dwell() uses (dialog/alert text, hasCaptchaFrame,
  // the landed URL) — fix round 1: a bare landedUrl-only check missed
  // /checkpoint/block ("restricted") and any dialog/alert/captcha signal
  // entirely, and would fall through to reading selectors off a restriction
  // or captcha page instead of reporting it. Any non-"ok" signal — checkpoint,
  // its /checkpoint/block form, a login wall, a captcha, a rate limit — is
  // reported as `unknown` with the signal attached, not inferred from
  // selectors failing to match.
  const signal = await readSignal(page);
  if (signal !== "ok") return { state: "unknown", reactions: null, comments: null, signal };
  const body = await page.innerText("body").catch(() => "");
  if (/isn'?t available|content isn'?t available|התוכן אינו זמין|לא זמין כרגע|this content is no longer available/i.test(body)) {
    return { state: "not_found", reactions: null, comments: null };
  }
  const num = (t) => { const m = String(t || "").replace(/[, ]/g, "").match(/\d+/); return m ? Number(m[0]) : null; };
  const reactions = num(await page.innerText(SELECTORS.reactionCount).catch(() => ""));
  const comments = num(await page.innerText(SELECTORS.commentCount).catch(() => ""));
  if (reactions === null && comments === null) return { state: "unknown", reactions: null, comments: null };
  return { state: "visible", reactions, comments };
}

module.exports = { dwell, browseSession, recheckPost, readSignal, INTERACTION, SELECTORS, COMPETITOR_PATTERNS };
