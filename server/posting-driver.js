/*
 * posting-driver.js — one reserved post attempt, from a background browser,
 * the way a person would do it (Task 18).
 *
 * This file (with posting-driver-proof.js, its SELECTORS and the R3 proof)
 * is the ONLY code that knows what Facebook's composer looks like.
 *
 * The attempt is the unit of work (R1). Every state is written through
 * deps.attempts.transition and AWAITED before the step it announces:
 *   session_started   before any browser opens
 *   composer_ready    once the composer is open
 *   submit_started    before the Post click
 *   verification_pending → verified_posted | submitted_for_approval | outcome_unknown
 * An `illegal_transition` means someone else (STOP, revoke, the reaper)
 * already moved the attempt: the driver stops at once and never clicks.
 * There is exactly one Post click on any path; nothing here retries, and
 * reconcile() only ever looks.
 *
 * R2: the guard is asked before the session, before every navigation, and
 * immediately before Post — the last await before the click. Denied before
 * submit_started → `cancelled`; denied after it (the click has not happened)
 * → `outcome_unknown`, for reconciliation, never a second submit.
 * R3: posting-driver-proof.proveIdentityAndDestination must pass before the
 * click; any mismatch → `verified_failed` with its code, session stopped.
 *
 * After verified_posted the link goes in as the first comment; its result
 * is a follow-up note (attempts.annotate), never part of the state write.
 *
 * Returns { state, error_code?, permalink?, signal?, membership?,
 * resolved_group_id?, comment_error_code?, dry_run? } for business outcomes;
 * only infrastructure errors throw (posting-tick's settle closes the attempt).
 * A halting signal is reported (`signal`), never acted on here: 16b's
 * haltAccount does that from the attempt's error_code.
 *
 * Nothing is logged: no phone, URL, name, post text, cdpUrl or profile name.
 */
const driver = require("./driver-browser");
const guardLive = require("./posting-guard");
const social = require("./social-dwell");
const { profileName } = require("./profile-name");
const { SIGNAL_DISABLES, SIGNAL_PENALISES } = require("./posting-signals");
const P = require("./posting-driver-proof");

const S = P.SELECTORS;
const FEED_URL = "https://www.facebook.com/";
// Driver's `duration` (seconds): Driver itself ends the browser before
// posting-tick's 15-min timeout and the 20-min profile lock / lease expire.
const POST_SESSION_S = 14 * 60;
const RECHECK_SESSION_S = 5 * 60;
const VERIFY_ROUNDS = 3;
const RECHECK_SCROLLS = 4;
const MIN_FEED_FOR_ABSENT = 5; // posts read, each with text and author, before "absent" is definitive
// [Unverified] the group feed sorted newest-first; Task 24 confirms the parameter.
const CHRONO_PARAM = ["sorting_setting", "CHRONOLOGICAL"];
const HALTING = new Set([...SIGNAL_DISABLES, ...SIGNAL_PENALISES, "login_required"]);

function fail(code, msg) { const e = new Error(msg || code); e.code = code; return e; }

// deps.guard is posting-tick's `(action) => …`, or a module-like
// { assertAllowed }, or absent (the real posting-guard).
function guardOf(deps, phone) {
  if (typeof deps.guard === "function") return (action) => deps.guard(action);
  const g = deps.guard && typeof deps.guard.assertAllowed === "function" ? deps.guard : guardLive;
  return (action) => g.assertAllowed({ phone, platform: "facebook", action }, deps);
}

// The per-run context: the attempt, its transitions, the guard, the clock.
function context(kind, args, deps) {
  const attempt = args.attempt;
  const phone = attempt.phone || deps.phone;
  if (!phone || (deps.phone && attempt.phone && deps.phone !== attempt.phone)) throw fail("invalid_input", "attempt phone");
  const attempts = deps.attempts || { transition: (k, s, d) => require("./posting-attempts").transition(k, s, d, new Date()) };
  const guardFn = guardOf(deps, phone);
  const rand = deps.rand || Math.random;
  const x = {
    kind, attempt, phone, rand, deps, extra: {}, submitted: false, copy: args.copy,
    conn: deps.conn || {},
    // R1. `illegal_transition` → a Stop that unwinds everything (no click after it).
    async step(to, detail) {
      try { await attempts.transition(attempt.key, to, detail || {}); }
      catch (e) { if (e && e.code === "illegal_transition") throw Object.assign(new Error("stopped"), { stop: true }); throw e; }
      if (to === "submit_started") x.submitted = true;
    },
    // A follow-up note without a state change (posting-attempts.annotate);
    // best-effort — a note never changes what happened.
    async annotate(detail) {
      if (typeof attempts.annotate !== "function") return;
      try { await attempts.annotate(attempt.key, detail); } catch { /* the result still carries it */ }
    },
    async end(to, detail = {}, extra = {}) {
      await x.step(to, detail);
      return Object.assign({ state: to }, detail.error_code ? { error_code: detail.error_code } : {}, x.extra, extra);
    },
    // R2, throwing: a denial unwinds the session (see settleError).
    async guard(action) {
      try { await guardFn(action); }
      catch (e) { if (e && e.code === "posting_disabled") throw Object.assign(new Error("denied"), { denied: true, reason: String(e.reason || "").slice(0, 60) }); throw e; }
    },
    // R2, non-throwing: may this happen? Anything but a clean yes is a no.
    async allows(action) { try { await guardFn(action); return true; } catch { return false; } },
    wait: (page, a, b) => page.waitForTimeout(Math.round((a + rand() * (b - a)) * 1000)),
    typingDelay: deps.typingDelay || (() => Math.round(Math.exp(3.9 + rand() * 1.2))), // ~50–165 ms
    dwellDeps: { phone, platform: "facebook", conn: deps.conn || {}, rand, guard: { assertAllowed: ({ action }) => guardFn(action) } },
  };
  return x;
}

async function settleError(x, e) {
  const stopped = () => Object.assign({ state: null, error_code: "illegal_transition" }, x.extra);
  if (e && e.stop) return stopped();
  if (e && e.denied) {
    // After submit_started the click has NOT happened (the guard is the last
    // await before it): recorded as clicked:false for reconciliation.
    const detail = Object.assign({ error_code: "posting_disabled", reason: e.reason }, x.submitted ? { clicked: false } : {});
    try { return await x.end(x.submitted ? "outcome_unknown" : "cancelled", detail); }
    catch (e2) { if (e2 && e2.stop) return stopped(); throw e2; }
  }
  throw e;
}

function sessionOpts(x, notePrefix, duration) {
  const gen = x.conn.facebook_profile_gen || 0;
  return {
    duration, type: x.deps.browserType || process.env.POSTING_BROWSER_TYPE || "hosted",
    note: `${notePrefix}${x.attempt.campaign_id || "adhoc"}`,
    profile: { name: profileName("facebook", x.phone, gen), persist: true },
  };
}
const pageDepsOf = (x) => Object.assign({}, x.deps, { phone: x.phone, platform: "facebook", conn: x.conn });

// → true when the page loaded (guard first — R2).
async function nav(page, x, url) {
  await x.guard("navigate");
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch { return false; }
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  return true;
}

// In the page: is focus inside `el`? If not, focus it with the caret at the
// END (a bare focus() puts a contenteditable's caret at the start).
function ensureFocus(el) {
  const inside = () => el === document.activeElement || el.contains(document.activeElement);
  if (!inside()) {
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  return inside();
}

// Word-sized chunks at a per-character delay, a longer pause at some word
// boundaries. Never one insertText of the whole message. Typed THROUGH the
// target locator (M8), and only while focus is inside it: before every
// chunk — newlines included — focus is checked (and restored, caret at the
// end); if it cannot be held, typing stops (composer_focus_lost) rather
// than a key, or an Enter, landing anywhere else.
async function humanType(page, target, text, x) {
  for (const w of String(text).split(/(\s+)/)) {
    if (!w) continue;
    if (!(await target.evaluate(ensureFocus).catch(() => false))) throw fail("composer_focus_lost", "focus left the editor");
    await target.pressSequentially(w, { delay: x.typingDelay() });
    if (/\s/.test(w) && x.rand() < 0.06) await x.wait(page, 0.4, 1.5);
  }
}

// Pre-submit: every halting signal ends the attempt as verified_failed with
// that code (this releases its reservation, 16a) and is reported.
async function preSubmitSignal(page, x, known) {
  const sig = known || (await P.readSignal(page, x.copy));
  if (HALTING.has(sig)) return x.end("verified_failed", { error_code: sig }, { signal: sig });
  if (sig === "not_member") return x.end("verified_failed", { error_code: sig }, { membership: "left" });
  if (sig === "group_blocked") return x.end("verified_failed", { error_code: sig });
  if (sig === "unreadable") return x.end("verified_failed", { error_code: "markers_missing" }); // fail closed, pre-submit
  return null;
}

async function drive(page, x, want, args) {
  const { attempt, kind } = x;
  const copy = args.copy;
  // 1. the feed first, and a few minutes of being a person (Task 17)
  if (!(await nav(page, x, FEED_URL))) return x.end("verified_failed", { error_code: "navigation_failed" });
  let done = await preSubmitSignal(page, x);
  if (done) return done;
  const allowVisible = await x.allows("like");
  const socialDwell = x.deps.socialDwell || social.dwell;
  const log = await socialDwell(page, { allowVisible, avoidGroupUrl: kind === "group" ? attempt.target_url : null, avoidGroupIds: kind === "group" ? want.ids : [] }, x.dwellDeps);
  const halt = (Array.isArray(log) ? log : []).find((l) => l && l.action === "halt");
  const dwellSig = halt && halt.detail && halt.detail.signal;
  if (HALTING.has(dwellSig)) return x.end("verified_failed", { error_code: dwellSig }, { signal: dwellSig });

  // 2. the destination: signals, membership, its canonical id
  if (!(await nav(page, x, attempt.target_url))) return x.end("verified_failed", { error_code: "navigation_failed" });
  const landed = await P.readSignal(page, x.copy);
  done = await preSubmitSignal(page, x, landed);
  if (done) return done;
  x.pendingBefore = landed === "pending_approval"; // an old banner never reads as ours
  if (kind === "group") {
    const join = await P.countOf(page, S.joinGroup);
    if (join > 0) return x.end("verified_failed", { error_code: "not_member" }, { membership: "left" });
    if (join < 0) return x.end("verified_failed", { error_code: "markers_missing" });
  }
  const id = await P.readTargetId(page, kind);
  if (!want.id) {
    if (!id) return x.end("verified_failed", { error_code: "destination_mismatch" }); // unresolved slug: fail closed
    x.resolvedId = id; // reported only once the R3 proof has passed (fix round 2 C)
    want.id = id;
    want.ids = [...new Set([id, ...want.ids])];
  } else if (id !== want.id) return x.end("verified_failed", { error_code: "destination_mismatch" });
  x.targetId = want.id;
  await page.mouse.wheel(0, Math.round(200 + x.rand() * 400));
  await x.wait(page, 3, 8);

  // 3. compose
  const composer = page.locator(S.composer).first();
  if ((await composer.count().catch(() => 0)) === 0) return x.end("verified_failed", { error_code: "composer_not_found" });
  await composer.click();
  const editor = page.locator(S.editor).first();
  if (!(await editor.waitFor({ timeout: 10000 }).then(() => true, () => false))) return x.end("verified_failed", { error_code: "composer_not_found" });
  // What the page says comes first (fix round 2): a restriction dialog that
  // opened around the composer is `restricted`, not a composer problem.
  done = await preSubmitSignal(page, x);
  if (done) return done;
  const roots = await P.countOf(page, S.composerRoot);
  if (roots !== 1) return x.end("verified_failed", { error_code: roots < 1 ? "composer_not_found" : "destination_mismatch" });
  await x.step("composer_ready");
  await editor.click();
  try { await humanType(page, editor, copy, x); }
  catch (e) { if (e && e.code === "composer_focus_lost") return x.end("verified_failed", { error_code: e.code }); throw e; }
  await x.wait(page, 5, 20); // re-read before posting, like anyone would

  // 4. R3 — prove who, where and what, immediately before Post
  const proof = await P.proveIdentityAndDestination(page, attempt, x.conn, { copy, resolvedGroupId: x.resolvedId });
  if (!proof.ok) return x.end("verified_failed", { error_code: proof.code }, proof.code === "not_member" ? { membership: "left" } : {});
  if (x.resolvedId) x.extra.resolved_group_id = x.resolvedId; // the proof matched this id to the target
  x.author = kind === "group" ? P.norm(x.conn.facebook_identity_label) : await P.textOf(page, S.targetName);

  if (args.dryRun === true) {
    await page.keyboard.press("Escape").catch(() => {});
    const discard = page.locator(S.discard).first();
    if ((await discard.count().catch(() => 0)) > 0) await discard.click().catch(() => {});
    return x.end("cancelled", { error_code: "dry_run" }, { dry_run: true });
  }

  // 5. the one click. Guard (denied → cancelled), then submit_started
  // (durable), then the guard again as the LAST await before the click.
  await x.guard("post");
  await x.step("submit_started");
  await x.guard("post");
  let clickError = null;
  try { await page.locator(S.submit).first().click(); } catch (e) { clickError = e; } // whatever happened, never again
  await x.step("verification_pending");
  return verify(page, x, copy, args.comment, clickError);
}

// → { seen: "confirmed" | "contradicted" | "unread", signal? }: the permalink
// page itself says it is this target's post, by this author, with this
// text. A halting signal there is returned too (M2), whatever the feed said.
async function checkPermalink(page, x, found, copy) {
  if (!(await x.allows("navigate"))) return { seen: "unread" };
  const ok = await page.goto(found.permalink, { waitUntil: "domcontentloaded", timeout: 30000 }).then(() => true, () => false);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  if (!ok) return { seen: "unread" };
  const sig = await P.readSignal(page, copy);
  if (sig !== "ok") return { seen: "unread", signal: HALTING.has(sig) ? sig : undefined };
  const id = await P.readTargetId(page, x.kind);
  const text = await P.textOf(page, S.postMessage);
  const author = await P.textOf(page, S.postAuthor);
  if (!id && !text && !author) return { seen: "unread" };
  return { seen: id === x.targetId && P.fingerprint(text) === P.fingerprint(copy) && author === x.author ? "confirmed" : "contradicted" };
}

// The link, as the first comment. Never throws; → null or a comment_error_code.
async function addComment(page, x, comment) {
  try {
    const box = page.locator(S.commentBox).first();
    if ((await box.count()) === 0) return "comment_box_not_found";
    await x.wait(page, 8, 25);
    await box.click();
    await humanType(page, box, comment, x);
    await x.wait(page, 1, 3);
    if (!(await x.allows("post"))) return "posting_disabled"; // R2: the last await before the click
    await page.locator(S.commentSubmit).first().click();
    await x.wait(page, 2, 4);
    return null;
  } catch { return "comment_failed"; }
}

async function verify(page, x, copy, comment, clickError) {
  const ids = x.want.ids;
  for (let round = 0; round < VERIFY_ROUNDS; round++) {
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await x.wait(page, 2, 5);
    const sig = await P.readSignal(page, copy); // never the composer, never the copy's own words
    if (sig === "unreadable") continue; // a failed read proves nothing: read again, never assume "ok"
    // The post may or may not have gone out: reconciliation decides, never a second click.
    if (HALTING.has(sig)) return x.end("outcome_unknown", { error_code: sig }, { signal: sig });
    if (sig === "group_blocked" || sig === "not_member") return x.end("verified_failed", { error_code: sig }, sig === "not_member" ? { membership: "left" } : {});
    const found = P.findOwnPost(await P.readFeedPosts(page), { kind: x.kind, ids, author: x.author, copy });
    if (found) {
      const { seen, signal } = await checkPermalink(page, x, found, copy);
      const halted = signal ? { signal } : {};
      if (seen === "contradicted" || (seen === "unread" && !found.exact)) return x.end("outcome_unknown", { error_code: signal || "not_verified" }, halted);
      // M1: the post's state is written FIRST; the comment is a follow-up
      // whose result is annotated. An illegal transition here (the tick
      // timed out and moved the attempt) stops before any comment.
      const out = await x.end("verified_posted", Object.assign({ permalink: found.permalink, post_url: found.permalink }, halted),
        Object.assign({ permalink: found.permalink }, signal ? { signal, error_code: signal } : {})); // error_code: the tick's halt hint
      if (!comment) return out;
      const commentCode = seen === "confirmed" && !signal ? await addComment(page, x, comment) : "not_on_permalink";
      if (commentCode) { out.comment_error_code = commentCode; await x.annotate({ comment_error_code: commentCode }); }
      return out;
    }
    if (sig === "pending_approval" && !x.pendingBefore) return x.end("submitted_for_approval", {});
  }
  return x.end("outcome_unknown", { error_code: clickError ? "click_error" : "not_verified" });
}

// Checks that need no browser: the target, the identity label, the copy.
function preflight(kind, x, args) {
  const { attempt, conn } = x;
  if (attempt.target_type !== kind) return { ok: false, code: "destination_mismatch" };
  const urlArg = kind === "group" ? args.groupUrl : args.pageUrl;
  if (urlArg !== undefined && urlArg !== null && urlArg !== attempt.target_url) return { ok: false, code: "destination_mismatch" };
  const want = P.expectedTarget(attempt, conn);
  if (!want.ok) return want;
  if (!P.norm(conn.facebook_identity_label)) return { ok: false, code: "identity_mismatch" };
  if (typeof args.copy !== "string" || !P.norm(args.copy) || P.sha(args.copy) !== attempt.copy_hash) return { ok: false, code: "copy_mismatch" };
  return want;
}

async function run(kind, args = {}, deps = {}) {
  const attempt = args.attempt;
  if (!attempt || typeof attempt.key !== "string" || !attempt.key) throw fail("invalid_input", "attempt required");
  if (args.dryRun !== undefined && typeof args.dryRun !== "boolean") throw fail("invalid_input", "dryRun must be a boolean");
  const x = context(kind, args, deps);
  try {
    // R1: durable before any browser opens. Already cancelled → Stop, zero sessions.
    await x.step("session_started");
    if (!deps.conn) x.conn = x.dwellDeps.conn = (await (deps.db || require("./db")).getConnection(x.phone)) || {};
    const want = preflight(kind, x, args);
    if (!want.ok) return await x.end("verified_failed", { error_code: want.code });
    x.want = want;
    await x.guard("session"); // R2
    const withPage = deps.withPage || driver.withPage;
    return await withPage(sessionOpts(x, "forly-post:", POST_SESSION_S), (page) => drive(page, x, want, args), pageDepsOf(x));
  } catch (e) {
    return settleError(x, e);
  }
}

// postToGroup / postToPage({ attempt, copy, comment, dryRun, groupUrl|pageUrl }, deps)
// → { state, … } (see the header). deps: posting-tick's postDeps.
const postToGroup = (args, deps) => run("group", args, deps);
const postToPage = (args, deps) => run("page", args, deps);

// The destination in newest-first order. A Page's own timeline already is
// ([Unverified], Task 24); a group's needs the sort parameter.
function chronoUrl(url, kind) {
  if (kind !== "group") return url;
  const u = new URL(url);
  u.searchParams.set(CHRONO_PARAM[0], CHRONO_PARAM[1]);
  return u.toString();
}
async function chronoLoaded(page, kind) {
  if (kind !== "group") return true;
  let kept = false;
  try { kept = new URL(page.url()).searchParams.get(CHRONO_PARAM[0]) === CHRONO_PARAM[1]; } catch { kept = false; }
  return kept || (await P.countOf(page, S.chronoMarker)) > 0;
}
const feedHealthy = (posts) => posts.length >= MIN_FEED_FOR_ABSENT && posts.every((p) => P.norm(p.text) && P.norm(p.author));

/*
 * reconcile(attempt, deps) — an outcome_unknown attempt: look at the
 * destination for a post by this account whose text fingerprint is the
 * attempt's copy_hash. NEVER submits, types or clicks anything.
 * Found → outcome_unknown → verified_posted (with its permalink). The
 * newest-first view loaded, at least MIN_FEED_FOR_ABSENT posts were read
 * with text AND author each (the selectors are healthy), and it is not
 * there → verified_failed `reconciled_absent`. Anything less certain → no
 * transition (operator review); a feed that could not be trusted is noted
 * `reconcile_note: "feed_unread"`. Only an attempt whose state IS
 * outcome_unknown is looked at. deps: posting-sweeper's { attempts
 * (transition, annotate), guard, phone, conn, copy, … }.
 */
async function reconcile(attempt, deps = {}) {
  if (!attempt || typeof attempt.key !== "string" || !attempt.key) throw fail("invalid_input", "attempt required");
  if (attempt.state !== "outcome_unknown") return { state: attempt.state || null, error_code: "not_outcome_unknown" };
  const kind = attempt.target_type === "page" ? "page" : "group";
  const x = context(kind, { attempt }, deps);
  const stay = (code, extra) => Object.assign({ state: "outcome_unknown", error_code: code }, extra || {});
  try {
    if (!deps.conn) x.conn = (await (deps.db || require("./db")).getConnection(x.phone)) || {};
    const copy = deps.copy;
    if (typeof copy !== "string" || !P.norm(copy) || P.sha(copy) !== attempt.copy_hash) return stay("copy_unavailable");
    const want = P.expectedTarget(attempt, x.conn);
    if (!want.ok) return stay(want.code);
    if (!P.norm(x.conn.facebook_identity_label)) return stay("identity_mismatch");
    if (!(await x.allows("retry"))) return stay("posting_disabled"); // R2: before any reconciliation
    x.want = want;
    const withPage = deps.withPage || driver.withPage;
    return await withPage(sessionOpts(x, "forly-recheck:", RECHECK_SESSION_S), async (page) => {
      if (!(await x.allows("navigate"))) return stay("posting_disabled");
      const loaded = await page.goto(chronoUrl(attempt.target_url, kind), { waitUntil: "domcontentloaded", timeout: 45000 }).then(() => true, () => false);
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      const sig = await P.readSignal(page, copy);
      if (!loaded || sig !== "ok") return stay(loaded ? sig : "navigation_failed", sig !== "ok" ? { signal: sig } : {});
      const id = await P.readTargetId(page, kind);
      if (!id || (want.id && id !== want.id)) return stay("destination_mismatch");
      const join = kind === "group" ? await P.countOf(page, S.joinGroup) : 0;
      if (join !== 0) return stay(join < 0 ? "markers_missing" : "not_member");
      const name = await P.textOf(page, S.targetName);
      if (!name || (want.name && name !== want.name)) return stay("destination_mismatch");
      x.targetId = id;
      x.author = kind === "group" ? P.norm(x.conn.facebook_identity_label) : name;
      const ids = [...new Set([id, ...want.ids])];
      const seen = new Map();
      let found = null;
      for (let i = 0; i < RECHECK_SCROLLS && !found; i++) {
        for (const p of await P.readFeedPosts(page)) if (p && p.href && !seen.has(p.href)) seen.set(p.href, p);
        found = P.findOwnPost([...seen.values()], { kind, ids, author: x.author, copy });
        if (!found) { await page.mouse.wheel(0, Math.round(600 + x.rand() * 600)); await x.wait(page, 2, 5); }
      }
      if (found) {
        const { seen: check, signal } = await checkPermalink(page, x, found, copy);
        if (!signal && (check === "confirmed" || (check === "unread" && found.exact))) {
          return x.end("verified_posted", { permalink: found.permalink, post_url: found.permalink, reconciled: true }, { permalink: found.permalink });
        }
        return stay(signal || "not_verified", signal ? { signal } : {});
      }
      // "Absent" only from a feed we can trust (fix round 1): the newest-first
      // view actually loaded, and the selectors read at least
      // MIN_FEED_FOR_ABSENT posts, EVERY one with text and an author. Anything
      // less is a feed we could not read, not a post that is not there.
      if (!(await chronoLoaded(page, kind)) || !feedHealthy([...seen.values()])) {
        await x.annotate({ reconcile_note: "feed_unread" });
        return stay("feed_unread", { reconcile_note: "feed_unread" });
      }
      return x.end("verified_failed", { error_code: "reconciled_absent" });
    }, pageDepsOf(x));
  } catch (e) {
    if (e && e.stop) return { state: null, error_code: "illegal_transition" };
    throw e;
  }
}

module.exports = {
  postToGroup, postToPage, reconcile, SELECTORS: S, POST_SESSION_S, RECHECK_SESSION_S,
  proveIdentityAndDestination: P.proveIdentityAndDestination,
  _test: { preflight, humanType, guardOf },
};
