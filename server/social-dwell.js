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
 *    posting_permission.allows_visible_interactions AND the fleet toggle.
 *    dwell() receives `opts.allowVisible` and skips visible steps entirely
 *    when it is false — posting-guard.assertAllowed() is still asked
 *    immediately before each one (R2), belt and suspenders.
 *
 * Writes are limited to likes (<= INTERACTION.likes_max per session), never
 * on a post inside the group we are about to post in, never sponsored,
 * sensitive, a competitor, or under INTERACTION.min_reactions, and never a
 * post whose id we already liked this session (or, when the caller supplies
 * `opts.recentlyLikedPostIds`, in the last 30 days). No comments, no
 * follows, no friend requests, no search, no profiles. Nothing is typed.
 *
 * Idempotency (R2): before clicking, the like button's own aria-pressed/label
 * is read — already liked -> skip; after clicking, re-read once; uncertain ->
 * `like_uncertain`, never retried or toggled.
 *
 * Nothing readable is persisted or logged: no post text, author names, story
 * names, hrefs, cdpUrl or profile names — only action names and, on a like,
 * the numeric Facebook post id, which never leaves this module (browseSession
 * folds the log into counts before it reaches posting-store).
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
// to — exactly the list R2 gives.
const SENSITIVE_RE = /politic|בחירות|ממשלה|war|מלחמה|חדשות|news|תאונה|accident|בריאות|health|דת|religion|הלוויה|died|נפטר/i;
const SPONSORED_RE = /sponsored|ממומן|suggested for you/i;
// No agency catalog lives in this repo yet (see report: task-17). Exported so
// an operator — or a later task — can fill it without touching the filter
// logic; empty means "no competitor is ever matched", not "skip the check".
const COMPETITOR_PATTERNS = [];

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
// sensitive or sponsored content is not.
function filteredFromLikes(p, opts) {
  if (!p || !p.href) return true;
  if (p.sponsored || SPONSORED_RE.test(p.text || "")) return true;
  if (SENSITIVE_RE.test(p.text || "")) return true;
  if (COMPETITOR_PATTERNS.some((re) => re.test(p.text || "") || re.test(p.author || ""))) return true;
  if (isGroupAvoided(p, opts)) return true;
  if (!Number.isFinite(p.reactions) || p.reactions < INTERACTION.min_reactions) return true;
  return false;
}

async function readFeed(page) {
  return page.$$eval(SELECTORS.feedPost, (els, sels) => els.slice(0, 12).map((el) => {
    const link = el.querySelector(sels.postLink), auth = el.querySelector(sels.author);
    const href = link ? link.href : null;
    const text = (el.textContent || "").slice(0, 2000);
    const reactMatch = text.match(/([\d,.]+)\s*(?:reactions|תגובות|לייקים)/i);
    return {
      href, author: auth ? (auth.textContent || "").trim() : null,
      hasVideo: !!el.querySelector(sels.video),
      sponsored: !!el.querySelector(sels.sponsoredLabel),
      reactions: reactMatch ? Number(reactMatch[1].replace(/[,.]/g, "")) : null,
      text,
      group: href && /\/groups\/([^/?#]+)/.test(href) ? href.replace(/(\/groups\/[^/?#]+).*/, "$1") : null,
    };
  }), { postLink: SELECTORS.postLink, author: SELECTORS.author, video: SELECTORS.video, sponsoredLabel: SELECTORS.sponsoredLabel }).catch(() => []);
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

  const openable = feed.filter((f) => f.href && !isGroupAvoided(f, opts));
  let likes = 0;
  for (let i = 0; i < Math.min(pick(r, INTERACTION.open_posts), openable.length); i++) {
    const p = openable[Math.floor(r() * openable.length)];
    const postId = postIdFromHref(p.href);
    if (!(await checkGuard("navigate", deps))) continue;
    await page.goto(p.href, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    note("open_post");
    if (await blocked()) return log; // a checkpoint reached mid-session: stop here
    await wait(secs(r, INTERACTION.read_s));

    if (allowVisible && likes < INTERACTION.likes_max && r() < INTERACTION.like_probability
        && postId && !recentlyLiked.has(postId) && !filteredFromLikes(p, opts)) {
      if (await checkGuard("like", deps)) {
        const btn = page.locator(SELECTORS.like).first();
        if ((await btn.count()) > 0) {
          const before = await readPressed(btn);
          if (before !== true) {
            await btn.click();
            await wait(1200);
            const after = await readPressed(btn);
            if (after === true) { likes++; recentlyLiked.add(postId); note("like", { post_id: postId }); }
            else note("like_uncertain", { post_id: postId }); // never retried or toggled
          }
        }
      }
    }
    await page.goBack().catch(() => page.goto("https://www.facebook.com/"));
    await wait(secs(r, [2, 5]));
  }

  if (allowVisible && r() < INTERACTION.story_probability && !(await blocked())) {
    if (await checkGuard("story", deps)) {
      const tray = page.locator(SELECTORS.storyTray).first();
      if ((await tray.count()) > 0) {
        const card = page.locator(SELECTORS.storyCard).first();
        if ((await card.count()) > 0) {
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
    for (const [k, v] of Object.entries(s.actions_summary || {})) out[k] = (out[k] || 0) + (Number(v) || 0);
    out.like = (out.like || 0) + (Number(s.likes) || 0);
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
async function browseSession({ phone, profileName, note } = {}, deps = {}) {
  const withPage = deps.withPage || driver.withPage;
  const db = deps.db || require("./db");
  const store = deps.store || require("./posting-store");
  const conn = deps.conn || (await db.getConnection(phone)) || {};
  const pageDeps = Object.assign({}, deps, { phone, platform: "facebook", conn });

  if (!(await checkGuard("session", pageDeps))) return { summary: {}, signal: "ok" };

  const allowVisible = !!(conn.posting_permission && conn.posting_permission.allows_visible_interactions === true);
  const { log, signal } = await withPage(
    { duration: 600, note: note || "forly-dwell:", profile: { name: profileName, persist: true } },
    async (page) => {
      await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      let signal = await readSignal(page);
      if (signal !== "ok") return { log: [], signal };
      const log = await dwell(page, { allowVisible }, pageDeps);
      signal = await readSignal(page);
      return { log, signal };
    },
    pageDeps,
  );

  const summary = summarize(log);
  const at = new Date();
  await store.saveDwellSession({
    phone, platform: "facebook", at: at.toISOString(),
    actions_summary: summary, likes: summary.like || 0, halt_related: signal !== "ok",
  }).catch(() => {});
  const week = await store.listDwellSessionsByPhone(phone, at.getTime() - 7 * 86400000).catch(() => []);
  await db.setConnection(phone, { last_browse_at: at.toISOString(), dwell_summary_7d: aggregate7d(week) }).catch(() => {});

  return { summary, signal };
}

// Visit one of the agent's own posts (Task 22): is it still there, and how
// did it do? `state` (not a boolean) lets the caller tell a confirmed removal
// apart from a flaky load or a login wall.
async function recheckPost(page, postUrl) {
  await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  const body = await page.innerText("body").catch(() => "");
  if (/isn'?t available|content isn'?t available|התוכן אינו זמין|לא זמין כרגע|this content is no longer available/i.test(body)) {
    return { state: "not_found", reactions: null, comments: null };
  }
  const signal = classifySignal({ landedUrl: page.url(), dialogText: "", alertText: "" });
  if (signal === "login_required" || signal === "checkpoint") return { state: "unknown", reactions: null, comments: null };
  const num = (t) => { const m = String(t || "").replace(/[, ]/g, "").match(/\d+/); return m ? Number(m[0]) : null; };
  const reactions = num(await page.innerText(SELECTORS.reactionCount).catch(() => ""));
  const comments = num(await page.innerText(SELECTORS.commentCount).catch(() => ""));
  if (reactions === null && comments === null) return { state: "unknown", reactions: null, comments: null };
  return { state: "visible", reactions, comments };
}

module.exports = { dwell, browseSession, recheckPost, INTERACTION, SELECTORS, COMPETITOR_PATTERNS };
