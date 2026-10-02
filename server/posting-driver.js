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
 * With a videoUrl the property's video is attached in the composer
 * (posting-media.js) and the copy is its description; a video that cannot
 * be fetched or attached fails the attempt before Post — never text only.
 *
 * After verified_posted the link goes in as the first comment; its result
 * is a follow-up note (attempts.annotate), never part of the state write.
 *
 * Returns { state, error_code?, permalink?, signal?, membership?,
 * resolved_group_id?, comment_error_code?, dry_run?, media? } for business outcomes;
 * only infrastructure errors throw (posting-tick's settle closes the attempt).
 * A halting signal is reported (`signal`), never acted on here: 16b's
 * haltAccount does that from the attempt's error_code.
 *
 * Nothing is logged: no phone, URL, name, post text, cdpUrl or profile name.
 */
const driver = require("./driver-browser");
const guardLive = require("./posting-guard");
const social = require("./social-dwell");
const localMode = require("./posting-local");
const { profileName } = require("./profile-name");
const { SIGNAL_DISABLES, SIGNAL_PENALISES } = require("./posting-signals");
const P = require("./posting-driver-proof");
const media = require("./posting-media");
const shots = require("./posting-shots");
const chain = require("./posting-chain");
const diag = require("./posting-diag");

const S = P.SELECTORS;
const FEED_URL = "https://www.facebook.com/";
// Driver's `duration` (seconds): Driver itself ends the browser before
// posting-tick's 15-min timeout and the 20-min profile lock / lease expire.
const POST_SESSION_S = 14 * 60;
const RECHECK_SESSION_S = 5 * 60;
const VERIFY_ROUNDS = 3;
const VERIFY_ROUNDS_VIDEO = 10; // Facebook processes a video for minutes before the post shows
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
    page: null, reached: "reserved", // the open page and the last step reached: a failure's screenshot (posting-shots)
    conn: deps.conn || {},
    // R1. `illegal_transition` → a Stop that unwinds everything (no click after it).
    async step(to, detail) {
      try { await attempts.transition(attempt.key, to, detail || {}); }
      catch (e) { if (e && e.code === "illegal_transition") throw Object.assign(new Error("stopped"), { stop: true }); throw e; }
      if (to === "submit_started") x.submitted = true;
      x.reached = to;
    },
    // A follow-up note without a state change (posting-attempts.annotate);
    // best-effort — a note never changes what happened.
    async annotate(detail) {
      if (typeof attempts.annotate !== "function") return;
      try { await attempts.annotate(attempt.key, detail); } catch { /* the result still carries it */ }
    },
    // detail.check names the check that failed: kept on the attempt (error_check,
    // failed_step: names only, posting-diag.safeDetail); the full diagnostic —
    // x.diag and a snapshot of the page — goes to the local/staging note only.
    async end(to, detail = {}, extra = {}) {
      const step = x.reached;
      const failed = to === "verified_failed" || to === "outcome_unknown";
      const { check, ...rest } = detail;
      await x.step(to, failed ? { ...rest, ...diag.safeDetail({ check, step }) } : rest);
      if (failed && shots.enabled(deps.env || process.env)) {
        const facts = await diag.snapshot(x.page, x).catch(() => null);
        await shots.capture(x.page, { kind, error_code: detail.error_code || to, step, check, diag: x.diag || null, facts, attempt_key: attempt.key, campaign_id: attempt.campaign_id, phone }, deps.env || process.env);
      }
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
  } catch (e) {
    // The reason is kept (it used to be swallowed), and a goto that threw on a
    // page that did arrive — the load event missed, or a redirect inside
    // Facebook interrupting it — is not a failed navigation: the address and
    // the document's own state decide. Every read after this still fails closed.
    const first = String((e && e.message) || e).split("\n")[0].slice(0, 160);
    const here = (() => { try { return new URL(page.url()); } catch { return null; } })();
    const want = new URL(url);
    const arrived = !!here && here.hostname === want.hostname && here.pathname.replace(/\/+$/, "").startsWith(want.pathname.replace(/\/+$/, ""));
    const state = () => Promise.resolve().then(() => page.evaluate(() => document.readyState)).catch(() => "");
    let ready = arrived && ["interactive", "complete"].includes(await state());
    // At the right address and still loading (a remote session can take more than 45 s): one more minute.
    if (arrived && !ready) ready = await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).then(() => true, () => false);
    console.warn(`posting nav …${String(x.attempt.key).slice(-6)}: ${first} (arrived=${arrived}, ready=${ready})`);
    if (!ready) return false;
  }
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
    // A word at a time: over a remote browser every key is several round
    // trips (a second a character, measured), and a post took five minutes
    // to type. Line breaks stay real Enter presses.
    if (/[\r\n]/.test(w) || typeof page.keyboard.insertText !== "function") await target.pressSequentially(w, { delay: x.typingDelay() });
    else { await page.keyboard.insertText(w); await page.waitForTimeout(w.length * x.typingDelay()); }
    if (/\s/.test(w) && x.rand() < 0.06) await x.wait(page, 0.4, 1.5);
  }
}

// Pre-submit: every halting signal ends the attempt as verified_failed with
// that code (this releases its reservation, 16a) and is reported.
async function preSubmitSignal(page, x, known) {
  const sig = known || (await P.readSignal(page, x.copy));
  if (HALTING.has(sig)) return x.end("verified_failed", { error_code: sig, check: "page_signal" }, { signal: sig });
  if (sig === "not_member") return x.end("verified_failed", { error_code: sig, check: "join_text_on_page" }, { membership: "left" });
  if (sig === "group_blocked") return x.end("verified_failed", { error_code: sig, check: "group_blocked_text" });
  if (sig === "unreadable") return x.end("verified_failed", { error_code: "markers_missing", check: "page_unreadable" }); // fail closed, pre-submit
  return null;
}

// The Post click is irreversible. Prove that exactly one enabled control is
// inside the verified composer *before* submit_started: a missing/disabled
// button is a selector or UI-state failure, not an ambiguous attempted post.
async function submitReady(page, x) {
  const count = await P.countOf(page, S.submit);
  if (count !== 1) { x.diag = { expected: 1, found: count }; return false; }
  const disabled = await page.locator(S.submit).first().getAttribute("aria-disabled").catch(() => null);
  if (String(disabled || "").toLowerCase() === "true") { x.diag = { aria_disabled: true }; return false; }
  return true;
}

async function drive(page, x, want, args, opts = {}) {
  const { attempt, kind } = x;
  x.page = page;
  const copy = args.copy;
  let done;
  const env = x.deps.env || process.env;
  // Watched local tests open Facebook first, in the SAME browser session that
  // will publish. This is a passive readiness/observation preflight only: no
  // scrolling, post-opening, likes, stories or synthetic "human" actions. The
  // separate calendar warm-up and idle browser sessions remain disabled.
  // opts.warm: a later post in the same session (posting-chain) — the feed and the dwell are already behind it.
  if (opts.warm) { /* straight to the destination */ } else if (localMode.enabled(env)) {
    if (!(await nav(page, x, FEED_URL))) return x.end("verified_failed", { error_code: "navigation_failed", check: "open_feed" });
    done = await preSubmitSignal(page, x);
    if (done) return done;
    await x.guard("dwell");
    const seconds = localMode.sessionPreflightSeconds(env);
    if (seconds > 0) await page.waitForTimeout(seconds * 1000);
    done = await preSubmitSignal(page, x);
    if (done) return done;
  } else {
    // Production/staging keep their existing guarded social-dwell policy.
    if (!(await nav(page, x, FEED_URL))) return x.end("verified_failed", { error_code: "navigation_failed", check: "open_feed" });
    done = await preSubmitSignal(page, x);
    if (done) return done;
    const allowVisible = await x.allows("like");
    const socialDwell = x.deps.socialDwell || social.dwell;
    const log = await socialDwell(page, { allowVisible, avoidGroupUrl: kind === "group" ? attempt.target_url : null, avoidGroupIds: kind === "group" ? want.ids : [] }, x.dwellDeps);
    const halt = (Array.isArray(log) ? log : []).find((l) => l && l.action === "halt");
    const dwellSig = halt && halt.detail && halt.detail.signal;
    if (HALTING.has(dwellSig)) return x.end("verified_failed", { error_code: dwellSig }, { signal: dwellSig });
  }

  // 2. the destination: signals, membership, its canonical id
  if (!(await nav(page, x, attempt.target_url))) return x.end("verified_failed", { error_code: "navigation_failed", check: "open_group" });
  // Facebook serves the header first and its splash screen stays up while the
  // rest loads (a minute, on a slow session): the composer entry or the Join
  // button is what says the page is really there. Not there in time → the
  // checks below fail closed, as before.
  // Seen stuck on the splash for good: then one reload, what anyone does with
  // a page that will not load.
  const there = () => page.locator(`${S.composer}, ${S.joinGroup}`).first().waitFor({ timeout: 45000 }).then(() => true, () => false);
  if (!(await there()) && (await P.countOf(page, S.composer)) === 0 && (await P.countOf(page, S.joinGroup)) === 0) {
    await x.guard("navigate");
    console.warn(`posting nav …${String(attempt.key).slice(-6)}: destination still loading, reloading once`);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await there();
  }
  const landed = await P.readSignal(page, x.copy);
  done = await preSubmitSignal(page, x, landed);
  if (done) return done;
  x.pendingBefore = landed === "pending_approval"; // an old banner never reads as ours
  if (kind === "group") {
    const join = await P.countOf(page, S.joinGroup);
    if (join > 0) return x.end("verified_failed", { error_code: "not_member", check: "join_button_on_group_page" }, { membership: "left" });
    if (join < 0) return x.end("verified_failed", { error_code: "markers_missing", check: "join_button_unreadable" });
  }
  const id = await P.readTargetId(page, kind);
  if (!want.id) {
    if (!id) return x.end("verified_failed", { error_code: "destination_mismatch", check: "group_id_unresolved" }); // unresolved slug: fail closed
    x.resolvedId = id; // reported only once the R3 proof has passed (fix round 2 C)
    want.id = id;
    want.ids = [...new Set([id, ...want.ids])];
  } else if (id !== want.id) { x.diag = { expected: want.id, found: id }; return x.end("verified_failed", { error_code: "destination_mismatch", check: "group_id_on_page" }); }
  x.targetId = want.id;
  await page.mouse.wheel(0, Math.round(200 + x.rand() * 400));
  await x.wait(page, 3, 8);

  // 3. compose
  const composer = page.locator(S.composer).first();
  if ((await composer.count().catch(() => 0)) === 0) return x.end("verified_failed", { error_code: "composer_not_found", check: "composer_button" });
  await composer.click();
  const editor = page.locator(S.editor).first();
  const opened = () => editor.waitFor({ timeout: 45000 }).then(() => true, () => false);
  if (!(await opened())) {
    // Seen live: the dialog opens as an empty shell and its editor never
    // arrives. Nothing is typed yet — close it and open it once more.
    // Reopening the same dialog did not help when tried: the page is loaded afresh.
    await x.guard("navigate");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await composer.waitFor({ timeout: 60000 }).catch(() => {});
    await x.wait(page, 2, 4);
    await composer.click().catch(() => {});
    if (!(await opened())) return x.end("verified_failed", { error_code: "composer_not_found", check: "editor_did_not_open" });
  }
  // What the page says comes first (fix round 2): a restriction dialog that
  // opened around the composer is `restricted`, not a composer problem.
  done = await preSubmitSignal(page, x);
  if (done) return done;
  const roots = await P.countOf(page, S.composerRoot);
  if (roots !== 1) { x.diag = { expected: 1, found: roots }; return x.end("verified_failed", { error_code: roots < 1 ? "composer_not_found" : "destination_mismatch", check: "composer_count" }); }
  await x.step("composer_ready");
  // The property's video first (it uploads while the text is typed); the copy is its description.
  if (x.media) {
    const bad = await media.attach(page, x, x.media);
    if (bad) return x.end("verified_failed", { error_code: bad, check: "video_attach" });
    x.extra.media = "video";
  }
  await editor.click();
  try { await humanType(page, editor, copy, x); }
  catch (e) { if (e && e.code === "composer_focus_lost") return x.end("verified_failed", { error_code: e.code, check: "typing_focus" }); throw e; }
  await x.wait(page, 5, 20); // re-read before posting, like anyone would
  if (x.media) {
    const bad = await media.waitUploaded(page, x);
    if (bad) return x.end("verified_failed", { error_code: bad, check: "video_upload" });
  }

  // 4. R3 — prove who, where and what, immediately before Post
  const proof = await P.proveIdentityAndDestination(page, attempt, x.conn, { copy, resolvedGroupId: x.resolvedId });
  if (!proof.ok) { x.diag = { expected: proof.expected, found: proof.found }; return x.end("verified_failed", { error_code: proof.code, check: proof.check }, proof.code === "not_member" ? { membership: "left" } : {}); }
  if (x.resolvedId) x.extra.resolved_group_id = x.resolvedId; // the proof matched this id to the target
  x.author = kind === "group" ? P.norm(x.conn.facebook_identity_label) : await P.textOf(page, S.targetName);

  if (!(await submitReady(page, x))) return x.end("verified_failed", { error_code: "submit_unavailable", check: "submit_button" });

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
  // The post's own dialog first (the feed behind it holds other posts), else the page.
  const text = (await P.textOf(page, S.postDialogMessage)) || (await P.textOf(page, S.postMessage));
  const author = (await P.textOf(page, S.postDialogAuthor)) || (await P.textOf(page, S.postAuthor));
  // In a group the post's header names the GROUP where the author was expected;
  // who wrote it is in the dialog's own title ("הפוסט של Micky Kroitoro").
  const titled = (await P.dialogHeadings(page)).some((h) => h === `הפוסט של ${x.author}` || h.toLowerCase() === `${x.author}'s post`.toLowerCase());
  const hit = { id: id === x.targetId, text: P.fingerprint(text) === P.fingerprint(copy), author: author === x.author || titled };
  x.diag = { permalink_read: { id: !!id, id_ok: hit.id, text_chars: text.length, text_ok: hit.text, author_read: !!author, author_ok: hit.author } }; // names and lengths only
  if (hit.id && hit.text && hit.author) return { seen: "confirmed" };
  // Only what was actually read can contradict: an empty read is "could not read", not "different".
  // (The target's id is the exception: a page whose content was read but whose id is missing or disputed is not ours.)
  return { seen: (!hit.id && (id || text || author)) || (text && !hit.text) || (author && !hit.author) ? "contradicted" : "unread" };
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
    // No send button under the box (today's Facebook): Enter sends a comment.
    if ((await P.countOf(page, S.commentSubmit)) > 0) await page.locator(S.commentSubmit).first().click();
    else await page.keyboard.press("Enter");
    await x.wait(page, 2, 4);
    return null;
  } catch { return "comment_failed"; }
}

async function verify(page, x, copy, comment, clickError) {
  const ids = x.want.ids;
  const rounds = x.media ? VERIFY_ROUNDS_VIDEO : VERIFY_ROUNDS;
  for (let round = 0; round < rounds; round++) {
    // A post with a video is not in the feed until Facebook has processed it
    // ("מעבד את הסרטון"), and the feed does not refresh itself: wait, and
    // reload every fourth look — twice at most, each reload a full page of
    // traffic. Only ever looking — never a second click.
    if (x.media && round > 0) {
      await x.wait(page, 12, 18);
      if (round % 4 === 0 && (await x.allows("navigate"))) await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    }
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
    // A failed click submitted nothing: a pending banner then is not ours either.
    if (sig === "pending_approval" && !x.pendingBefore && !clickError) return x.end("submitted_for_approval", {});
  }
  return x.end("outcome_unknown", { error_code: clickError ? "click_error" : "not_verified" });
}

// Checks that need no browser: the target, the identity label, the copy.
function preflight(kind, x, args) {
  const { attempt, conn } = x;
  if (attempt.target_type !== kind) return { ok: false, code: "destination_mismatch", check: "target_kind" };
  const urlArg = kind === "group" ? args.groupUrl : args.pageUrl;
  if (urlArg !== undefined && urlArg !== null && urlArg !== attempt.target_url) return { ok: false, code: "destination_mismatch", check: "target_url" };
  const want = P.expectedTarget(attempt, conn);
  if (!want.ok) return want;
  if (!P.norm(conn.facebook_identity_label)) return { ok: false, code: "identity_mismatch", check: "no_identity_label" };
  if (typeof args.copy !== "string" || !P.norm(args.copy) || P.sha(args.copy) !== attempt.copy_hash) return { ok: false, code: "copy_mismatch", check: "copy_hash" };
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
    if (!want.ok) return await x.end("verified_failed", { error_code: want.code, check: want.check || "preflight" });
    x.want = want;
    await x.guard("session"); // R2
    // The video is fetched before any browser opens: one we cannot serve costs no session.
    if (args.videoUrl) {
      try { x.media = await media.fetchVideo(args.videoUrl, deps); }
      catch (e) { x.diag = (e && e.detail) || null; return await x.end("verified_failed", { error_code: /^media_/.test((e && e.code) || "") ? e.code : "media_unavailable", check: "video_download" }); }
    }
    const withPage = deps.withPage || driver.withPage;
    const duration = chain.enabled(deps) ? Math.round(chain.SESSION_MS(deps.env) / 1000) : POST_SESSION_S;
    return await withPage(sessionOpts(x, "forly-post:", duration), async (page) => {
      let out;
      try { out = await drive(page, x, want, args); } catch (e) { out = await settleError(x, e); }
      return more(page, out, x, deps);
    }, pageDepsOf(x));
  } catch (e) {
    return settleError(x, e);
  }
}

// The same session, the account's next ready post (posting-chain): the tick
// settles the post just made (deps.next); the browser dwells on the feed for
// 1.5–5.8 minutes; then the next one, prepared and reserved now, is posted
// here — straight to its group, the feed already behind it.
async function more(page, out, x0, deps) {
  let next = typeof deps.next === "function" ? deps.next : null;
  while (next) {
    let prepare = null;
    try { prepare = await next(out); } catch { prepare = null; }
    if (!prepare) break;
    if (!(await between(page, x0))) break;
    let call = null;
    try { call = await prepare(); } catch { call = null; }
    if (!call) break;
    const x = context(call.kind, call.args, call.deps);
    x.page = page;
    try {
      await x.step("session_started");
      const want = preflight(call.kind, x, call.args);
      if (!want.ok) out = await x.end("verified_failed", { error_code: want.code, check: want.check || "preflight" });
      else {
        x.want = want;
        await x.guard("session");
        if (call.args.videoUrl) x.media = await media.fetchVideo(call.args.videoUrl, call.deps);
        out = await drive(page, x, want, call.args, { warm: true });
      }
    } catch (e) { out = await settleError(x, e).catch(() => ({ state: null, error_code: "chain_error" })); }
    next = call.deps.next;
  }
  // The session's housekeeping on the same page (posting-tick): yesterday's
  // checks, a stale groups sync. Not after a halting page.
  if (typeof deps.afterPosts === "function" && !(out && HALTING.has(out.signal))) {
    try { await deps.afterPosts(page); } catch { /* never in the way of the posts */ }
  }
  if (next === null && typeof deps.next !== "function") return out;
  return Object.assign({}, out, { chained: true });
}

// Between two posts: on the feed, reading, for 1.5–5.8 minutes. → false when
// the page says stop (a halting signal) or the switches do.
async function between(page, x) {
  if (!(await x.allows("dwell")) || !(await nav(page, x, FEED_URL).catch(() => false))) return false;
  const until = Date.now() + (typeof x.deps.chainDwellMs === "number" ? x.deps.chainDwellMs : chain.dwellMs(x.rand)); // tests: chainDwellMs
  while (Date.now() < until) {
    await page.mouse.wheel(0, Math.round(250 + x.rand() * 650)).catch(() => {});
    // A video is scrolled past; a text or image post is read (social-dwell).
    await page.waitForTimeout(social.readFor(await social.centered(page), x.rand));
    const sig = await P.readSignal(page, "");
    if (HALTING.has(sig) || sig === "login_required") return false;
  }
  return true;
}

// postToGroup / postToPage({ attempt, copy, comment, videoUrl, dryRun, groupUrl|pageUrl }, deps)
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
  _test: { preflight, humanType, guardOf, submitReady },
};
