/* posting-driver.js — one attempt through its durable states, against a fake
   page. The fake matches on the EXPORTED selectors. No network, no Driver. */
process.env.FORLY_ENV = "local";
process.env.PROFILE_KEY = "test-profile-key";
const assert = require("assert");
const PD = require("./posting-driver");
const P = require("./posting-driver-proof");
const { sha } = require("./posting-campaign");
const { profileName } = require("./profile-name");
const S = PD.SELECTORS;

// Every console line the driver writes is captured and checked at the end.
const logged = [];
const real = { log: console.log, error: console.error, warn: console.warn };
for (const k of Object.keys(real)) console[k] = (...a) => logged.push(a.join(" "));

const PHONE = "972501234567";
const NAME = "Dana Cohen";
const GROUP_NAME = "דירות להשכרה בחיפה";
const PAGE_NAME = "Dana Nadlan";
const COPY = "🏠 דירה בחיפה 4 חדרים\nמרפסת שמש, קומה 3, חניה פרטית ומחסן";
const LINK = `https://f.ly/p/pg1?c=${"a".repeat(32)}`;
const GROUP_URL = "https://www.facebook.com/groups/111";
const PERMA = "https://www.facebook.com/groups/111/posts/999/";
const PAGE_URL = "https://www.facebook.com/dana.nadlan";
const PAGE_PERMA = "https://www.facebook.com/dana.nadlan/posts/77/";

const connOf = (o) => Object.assign({ facebook_identity_label: NAME, facebook_profile_gen: 0, facebook_groups_member: [{ group_id: "111", name: GROUP_NAME }] }, o);
const attemptOf = (o) => Object.assign({
  key: "0123456789abcdef0123456789abcdef", phone: PHONE, page_id: "pg1", campaign_id: "c1", post_id: "p1",
  target_type: "group", target_id: "111", target_url: GROUP_URL, publisher: "browser", copy_hash: sha(COPY), confirm_membership: false, click_id: "a".repeat(32),
}, o);
const argsOf = (o) => Object.assign({ attempt: attemptOf(), copy: COPY, comment: LINK, dryRun: false, campaignId: "c1", phone: PHONE, groupUrl: GROUP_URL }, o);
const nameOf = (sel) => Object.keys(S).find((k) => S[k] === sel) || "other";
const denied = (reason) => Object.assign(new Error("posting not allowed"), { code: "posting_disabled", reason });

function fakePage(o = {}) {
  const ev = o.ev || [];
  const st = { url: "about:blank", submitted: false, editor: "", typed: [], clicks: [], visited: [], pressed: [] };
  const v = (x) => (typeof x === "function" ? x(st) : x);
  const texts = Object.assign({
    [S.identity]: NAME, [S.targetName]: GROUP_NAME, [S.composerTarget]: GROUP_NAME, [S.composerAuthor]: NAME,
    [S.editor]: (s) => s.editor, [S.postMessage]: COPY, [S.postAuthor]: NAME, [S.dialog]: "", [S.alert]: "",
  }, o.texts);
  const counts = Object.assign({ [S.composer]: 1, [S.editor]: 1, [S.joinGroup]: 0, [S.commentBox]: 1, [S.discard]: 1, [S.captchaFrame]: 0 }, o.counts);
  const attrs = Object.assign({ [S.targetIdMeta]: "fb://group/111", [S.targetUrlMeta]: "" }, o.attrs);
  const feed = o.feed !== undefined ? o.feed : (s) => (s.submitted ? [{ href: `${PERMA}?__cft__=x`, author: NAME, text: COPY }] : []);
  const node = (sel) => {
    const n = {
      count: async () => v(counts[sel]) || 0,
      click: async () => { st.clicks.push(sel); ev.push(`click:${nameOf(sel)}`); if (sel === S.submit) st.submitted = true; },
      waitFor: async () => { if (!(v(counts[sel]) > 0)) throw new Error("timeout"); },
      innerText: async () => String(v(texts[sel]) ?? ""),
      getAttribute: async () => v(attrs[sel]) ?? null,
    };
    n.first = () => n; n.nth = () => n;
    return n;
  };
  return {
    st, ev,
    goto: async (u) => { st.visited.push(u); ev.push("goto"); st.url = (o.redirect && o.redirect(u)) || u; },
    url: () => st.url,
    goBack: async () => { st.url = "https://www.facebook.com/"; },
    locator: node,
    innerText: async () => "",
    keyboard: { type: async (t) => { st.typed.push(t); if (!st.submitted) st.editor += t; }, press: async (k) => { st.pressed.push(k); } },
    mouse: { wheel: async () => {}, move: async () => {} },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    $$eval: async (sel) => (sel === S.feedPost ? v(feed) : []),
  };
}

// posting-tick's postDeps shape: attempts.transition(k, state, detail), guard(action), lockHeld, phone, platform, conn.
function harness(o = {}) {
  const ev = [];
  const page = fakePage(Object.assign({ ev }, o.page));
  const transitions = [], opened = [], guardCalls = {};
  const deps = {
    attempts: {
      transition: async (k, to, d) => {
        ev.push(`t:${to}`);
        transitions.push({ k, to, d, submitClicks: page.st.clicks.filter((s) => s === S.submit).length });
        if (o.illegalAt === to) throw Object.assign(new Error("x"), { code: "illegal_transition" });
        return { key: k, state: to };
      },
    },
    guard: async (action) => {
      guardCalls[action] = (guardCalls[action] || 0) + 1;
      ev.push(`g:${action}`);
      if (o.deny && o.deny(action, guardCalls[action])) throw denied("test");
      return true;
    },
    lockHeld: true, phone: PHONE, platform: "facebook", conn: connOf(o.conn),
    withPage: async (opts, fn, pd) => { opened.push({ opts, pd }); ev.push("open"); try { return await fn(page, { sessionId: "s" }); } finally { ev.push("close"); } },
    socialDwell: o.socialDwell || (async () => []),
    typingDelay: () => 0, rand: () => 0.5,
  };
  return { ev, page, transitions, opened, deps, states: () => transitions.map((t) => t.to), submits: () => page.st.clicks.filter((s) => s === S.submit).length };
}

(async () => {
  // ── happy path: every state in order, submit_started durable before the one click, guard last ──
  {
    const h = harness();
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.deepEqual(h.states(), ["session_started", "composer_ready", "submit_started", "verification_pending", "verified_posted"]);
    const sub = h.transitions.find((t) => t.to === "submit_started");
    assert.equal(sub.submitClicks, 0, "submit_started is recorded before the click");
    assert.equal(h.submits(), 1, "exactly one Post click");
    const i = h.ev.indexOf("click:submit");
    assert.equal(h.ev[i - 1], "g:post", "the post guard is the last await before the click");
    assert.equal(h.ev[i - 2], "t:submit_started");
    assert.ok(h.ev.indexOf("t:session_started") < h.ev.indexOf("open"), "session_started before any browser");
    assert.ok(h.ev.indexOf("g:session") < h.ev.indexOf("open") && h.ev.indexOf("g:navigate") < h.ev.indexOf("goto"));
    assert.equal(out.state, "verified_posted");
    assert.equal(out.permalink, PERMA, "the canonical permalink, tracking stripped");
    const fin = h.transitions[4].d;
    assert.equal(fin.permalink, PERMA); assert.equal(fin.post_url, PERMA); assert.equal(fin.comment_error_code, undefined);
    assert.equal(h.page.st.editor, COPY, "the composer holds exactly the copy");
    assert.ok(h.page.st.typed.filter((t) => !h.page.st.editor.includes(t)).join("").includes("f.ly"), "the link went into a comment");
    assert.ok(h.page.st.typed.length > 3, "typed in word-sized chunks");
    assert.ok(h.page.st.clicks.includes(S.commentSubmit));
    assert.equal(h.page.st.visited[0], "https://www.facebook.com/", "the feed comes first");
    assert.equal(h.page.st.visited[1], GROUP_URL);
    const { opts, pd } = h.opened[0];
    assert.ok(opts.duration <= 14 * 60, "Driver duration at most 14 minutes");
    assert.equal(opts.note, "forly-post:c1");
    assert.deepEqual(opts.profile, { name: profileName("facebook", PHONE, 0), persist: true });
    assert.equal(pd.phone, PHONE); assert.equal(pd.platform, "facebook"); assert.equal(pd.lockHeld, true);
  }

  // ── already cancelled (STOP / revoke / reaper): session_started refused → zero sessions ──
  {
    const h = harness({ illegalAt: "session_started" });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.equal(h.opened.length, 0, "no withPage call");
    assert.equal(out.error_code, "illegal_transition");
  }

  // ── illegal_transition later: stop at once, never click ──
  for (const at of ["composer_ready", "submit_started"]) {
    const h = harness({ illegalAt: at });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.equal(h.submits(), 0, `${at}: zero clicks`);
    assert.equal(h.states()[h.states().length - 1], at, `${at}: no transition after it`);
    assert.equal(out.error_code, "illegal_transition");
    assert.equal(h.ev[h.ev.length - 1], "close", "the session is stopped");
  }
  {
    const h = harness({ illegalAt: "verification_pending" });
    await PD.postToGroup(argsOf(), h.deps);
    assert.equal(h.submits(), 1, "the click had happened; never a second one");
    assert.deepEqual(h.states().slice(-1), ["verification_pending"]);
  }

  // ── R2: a denial before submit_started → cancelled, zero clicks ──
  for (const action of ["session", "navigate", "post"]) {
    const h = harness({ deny: (a) => a === action });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.equal(out.state, "cancelled", action);
    assert.equal(out.error_code, "posting_disabled");
    assert.equal(h.submits(), 0);
    assert.ok(!h.states().includes("submit_started"), `${action}: nothing past cancel`);
  }
  // …and a denial after submit_started (the second, last-moment check) → outcome_unknown, no click
  {
    const h = harness({ deny: (a, n) => a === "post" && n === 2 });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.deepEqual(h.states(), ["session_started", "composer_ready", "submit_started", "outcome_unknown"]);
    assert.equal(out.state, "outcome_unknown");
    assert.equal(h.submits(), 0);
  }

  // ── R3: every mismatch fails closed as verified_failed with its code, zero clicks ──
  for (const [page, code, label] of [
    [{ texts: { [S.identity]: "Someone Else" } }, "identity_mismatch", "header identity"],
    [{ texts: { [S.identity]: "" } }, "identity_mismatch", "unreadable header"],
    [{ texts: { [S.composerAuthor]: "Someone Else" } }, "identity_mismatch", "composer author"],
    [{ attrs: { [S.targetIdMeta]: "fb://group/222" } }, "destination_mismatch", "canonical id"],
    [{ attrs: { [S.targetIdMeta]: "" } }, "destination_mismatch", "no id on the page"],
    [{ texts: { [S.composerTarget]: "קבוצה אחרת" } }, "destination_mismatch", "composer names another group"],
    [{ texts: { [S.targetName]: "שם אחר" } }, "destination_mismatch", "group renamed / other group"],
    [{ texts: { [S.editor]: `${COPY} x` } }, "copy_mismatch", "editor text"],
    [{ counts: { [S.joinGroup]: (s) => (s.editor ? 1 : 0) } }, "not_member", "Join group appears in the composer step"],
  ]) {
    const h = harness({ page });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.equal(out.state, "verified_failed", label);
    assert.equal(out.error_code, code, label);
    assert.equal(h.submits(), 0, `${label}: zero clicks`);
    assert.ok(!h.states().includes("submit_started"));
  }
  // before any browser: the copy is not the attempt's copy, or there is no identity label
  for (const [o, code] of [[{ args: { copy: `${COPY}!` } }, "copy_mismatch"], [{ conn: { facebook_identity_label: null } }, "identity_mismatch"], [{ args: { groupUrl: "https://www.facebook.com/groups/222" } }, "destination_mismatch"]]) {
    const h = harness({ conn: o.conn });
    const out = await PD.postToGroup(argsOf(o.args), h.deps);
    assert.deepEqual([out.state, out.error_code], ["verified_failed", code]);
    assert.equal(h.opened.length, 0, `${code}: no session opened`);
  }

  // ── signals after navigation: halting → verified_failed + signal, nothing typed ──
  for (const [page, sig] of [
    [{ redirect: (u) => (u === GROUP_URL ? "https://www.facebook.com/checkpoint/123/" : u) }, "checkpoint"],
    [{ redirect: (u) => (u === "https://www.facebook.com/" ? "https://www.facebook.com/login/?next=x" : u) }, "login_required"],
    [{ texts: { [S.alert]: "You're temporarily blocked from posting" } }, "rate_limited"],
    [{ counts: { [S.captchaFrame]: 1 } }, "captcha"],
  ]) {
    const h = harness({ page });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.deepEqual([out.state, out.error_code, out.signal], ["verified_failed", sig, sig]);
    assert.equal(h.page.st.typed.length, 0, `${sig}: nothing typed`);
    assert.equal(h.submits(), 0);
  }
  // a halt seen by the dwell routine is honoured too
  {
    const h = harness({ socialDwell: async () => [{ action: "halt", detail: { signal: "feature_blocked" } }] });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.deepEqual([out.state, out.signal], ["verified_failed", "feature_blocked"]);
  }

  // ── membership: "Join group" on the group page → not_member, membership left, no composer ──
  {
    const h = harness({ page: { counts: { [S.joinGroup]: 1 } } });
    const out = await PD.postToGroup(argsOf({ attempt: attemptOf({ confirm_membership: true }) }), h.deps);
    assert.deepEqual([out.state, out.error_code, out.membership], ["verified_failed", "not_member", "left"]);
    assert.ok(!h.page.st.clicks.includes(S.composer));
  }

  // ── slug targets: the numeric id is read on the page and returned; none → fail closed ──
  {
    const slugUrl = "https://www.facebook.com/groups/haifa.rent";
    const a = attemptOf({ target_id: "slug:haifa.rent", target_url: slugUrl });
    const h = harness({ conn: { facebook_groups_member: [] }, page: { feed: (s) => (s.submitted ? [{ href: `${slugUrl}/posts/999`, author: NAME, text: COPY }] : []) } });
    const out = await PD.postToGroup(argsOf({ attempt: a, groupUrl: slugUrl }), h.deps);
    assert.equal(out.state, "verified_posted");
    assert.equal(out.resolved_group_id, "111");
    const h2 = harness({ page: { attrs: { [S.targetIdMeta]: "" } } });
    const out2 = await PD.postToGroup(argsOf({ attempt: a, groupUrl: slugUrl }), h2.deps);
    assert.deepEqual([out2.state, out2.error_code], ["verified_failed", "destination_mismatch"]);
    assert.ok(!h2.page.st.clicks.includes(S.composer));
  }

  // ── after the click: pending approval, nothing found, a halting signal ──
  {
    const h = harness({ page: { feed: [], texts: { [S.alert]: (s) => (s.submitted ? "Your post is pending approval" : "") } } });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.equal(out.state, "submitted_for_approval");
    assert.equal(h.submits(), 1);
  }
  {
    // an old "pending" banner that was already there before the click is not ours
    const h = harness({ page: { feed: [], texts: { [S.alert]: "Your post is pending approval" } } });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.equal(out.state, "outcome_unknown");
  }
  {
    const h = harness({ page: { feed: (s) => (s.submitted ? [{ href: `${PERMA}`, author: "Someone Else", text: "other" }] : []) } });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.deepEqual([out.state, out.error_code], ["outcome_unknown", "not_verified"]);
    assert.equal(h.submits(), 1, "exactly one click, never a second");
    assert.deepEqual(h.states().slice(-2), ["verification_pending", "outcome_unknown"]);
  }
  {
    const h = harness({ page: { texts: { [S.dialog]: (s) => (s.submitted ? "You can't use this feature right now" : "") } } });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.deepEqual([out.state, out.signal], ["outcome_unknown", "feature_blocked"], "after submit: reconciliation, the halt reported");
    assert.equal(h.submits(), 1);
  }
  {
    // the permalink page contradicts the feed (another group's post) → outcome_unknown
    const h = harness({ page: { attrs: { [S.targetIdMeta]: (s) => (/\/posts\//.test(s.url) ? "fb://group/222" : "fb://group/111") } } });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.equal(out.state, "outcome_unknown");
  }
  {
    // a cut feed text only selects the candidate; the permalink page's full text verifies it
    const h = harness({ page: { feed: (s) => (s.submitted ? [{ href: PERMA, author: NAME, text: `${COPY.slice(0, 30)}… See more` }] : []) } });
    assert.equal((await PD.postToGroup(argsOf(), h.deps)).state, "verified_posted");
  }
  {
    // the comment fails: the post is still verified_posted, the failure recorded
    const h = harness({ page: { counts: { [S.commentBox]: 0 } } });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.equal(out.state, "verified_posted");
    assert.equal(out.comment_error_code, "comment_box_not_found");
    assert.equal(h.transitions[4].d.comment_error_code, "comment_box_not_found");
  }

  // ── dry run: everything up to and including the proof and typing; no click ──
  {
    const h = harness();
    const out = await PD.postToGroup(argsOf({ dryRun: true }), h.deps);
    assert.deepEqual(h.states(), ["session_started", "composer_ready", "cancelled"]);
    assert.deepEqual([out.state, out.error_code, out.dry_run], ["cancelled", "dry_run", true]);
    assert.equal(h.page.st.editor, COPY);
    assert.equal(h.submits(), 0);
    assert.ok(!h.page.st.clicks.includes(S.commentSubmit));
    assert.ok(h.page.st.pressed.includes("Escape"), "the composer is closed");
  }

  // ── Pages ──
  const pageConn = { facebook_pages: [{ id: "555", url: PAGE_URL, name: PAGE_NAME }], posting_permission: { page_id: "555" } };
  const pageAttempt = attemptOf({ target_type: "page", target_id: "555", target_url: PAGE_URL });
  const pagePage = {
    attrs: { [S.targetIdMeta]: "fb://page/555" },
    texts: { [S.targetName]: PAGE_NAME, [S.composerAuthor]: PAGE_NAME, [S.postAuthor]: PAGE_NAME },
    feed: (s) => (s.submitted ? [{ href: `${PAGE_PERMA}?ref=x`, author: PAGE_NAME, text: COPY }] : []),
  };
  {
    const h = harness({ conn: pageConn, page: pagePage });
    const out = await PD.postToPage(argsOf({ attempt: pageAttempt, groupUrl: undefined, pageUrl: PAGE_URL }), h.deps);
    assert.equal(out.state, "verified_posted");
    assert.equal(out.permalink, PAGE_PERMA);
    assert.equal(h.page.st.editor, COPY, "the body is exactly the copy (copy_hash); the link is in a comment");
    assert.equal(h.submits(), 1);
  }
  {
    // posting as the person instead of the Page
    const h = harness({ conn: pageConn, page: Object.assign({}, pagePage, { texts: Object.assign({}, pagePage.texts, { [S.composerAuthor]: NAME }) }) });
    const out = await PD.postToPage(argsOf({ attempt: pageAttempt, pageUrl: PAGE_URL }), h.deps);
    assert.deepEqual([out.state, out.error_code], ["verified_failed", "identity_mismatch"]);
    assert.equal(h.submits(), 0);
  }
  {
    // two Pages, none confirmed on the card → destination_mismatch, no composer (no browser at all)
    const two = { facebook_pages: [{ id: "555", url: PAGE_URL, name: PAGE_NAME }, { id: "556", url: "https://www.facebook.com/other", name: "Other" }], posting_permission: { enabled: true } };
    const h = harness({ conn: two, page: pagePage });
    const out = await PD.postToPage(argsOf({ attempt: pageAttempt, pageUrl: PAGE_URL }), h.deps);
    assert.deepEqual([out.state, out.error_code], ["verified_failed", "destination_mismatch"]);
    assert.equal(h.opened.length, 0);
    assert.ok(!h.page.st.clicks.includes(S.composer));
  }
  {
    // a group attempt handed to postToPage is refused
    const h = harness();
    const out = await PD.postToPage(argsOf(), h.deps);
    assert.deepEqual([out.state, out.error_code], ["verified_failed", "destination_mismatch"]);
    assert.equal(h.opened.length, 0);
  }

  // ── the real social-dwell routine runs through the guard adapter ──
  {
    const h = harness({ deny: (a) => a === "like" || a === "story" });
    h.deps.socialDwell = undefined;
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.equal(out.state, "verified_posted");
    assert.ok(h.ev.includes("g:dwell"), "dwell asked the guard through the adapter");
    assert.ok(!h.page.st.clicks.includes(require("./social-dwell").SELECTORS.like), "no like without permission");
    assert.equal(h.submits(), 1);
  }

  // ── reconcile: only ever looks ──
  const unknown = attemptOf({ state: "outcome_unknown" });
  const recon = (o = {}) => {
    const h = harness(o);
    h.deps.copy = o.copy === undefined ? COPY : o.copy;
    return h;
  };
  const feedWithOurs = [{ href: "https://www.facebook.com/groups/111/posts/1", author: "A", text: "x" }, { href: `${PERMA}?x=1`, author: NAME, text: COPY }, { href: "https://www.facebook.com/groups/111/posts/2", author: "B", text: "y" }];
  const feedWithout = [1, 2, 3, 4].map((n) => ({ href: `https://www.facebook.com/groups/111/posts/${n}`, author: "Other", text: `post ${n}` }));
  {
    const h = recon({ page: { feed: feedWithOurs } });
    const out = await PD.reconcile(unknown, h.deps);
    assert.deepEqual(h.states(), ["verified_posted"]);
    assert.equal(out.permalink, PERMA);
    assert.equal(h.submits(), 0); assert.equal(h.page.st.typed.length, 0, "reconcile never types");
    assert.equal(h.page.st.clicks.length, 0, "reconcile never clicks");
    assert.ok(h.opened[0].opts.note.startsWith("forly-recheck:") && h.opened[0].opts.duration <= 14 * 60);
    assert.ok(h.ev.includes("g:retry") && h.ev.indexOf("g:retry") < h.ev.indexOf("open"));
  }
  {
    const h = recon({ page: { feed: feedWithout } });
    const out = await PD.reconcile(unknown, h.deps);
    assert.deepEqual(h.states(), ["verified_failed"]);
    assert.equal(h.transitions[0].d.error_code, "reconciled_absent");
    assert.equal(out.state, "verified_failed");
    assert.equal(h.page.st.clicks.length, 0);
  }
  for (const [o, code] of [
    [{ page: { feed: [] } }, "feed_unread"],
    [{ page: { feed: feedWithout, redirect: () => "https://www.facebook.com/checkpoint/1/" } }, "checkpoint"],
    [{ page: { feed: feedWithout, attrs: { [S.targetIdMeta]: "fb://group/222" } } }, "destination_mismatch"],
    [{ page: { feed: feedWithOurs, attrs: { [S.targetIdMeta]: (s) => (/\/posts\//.test(s.url) ? "fb://group/222" : "fb://group/111") } } }, "not_verified"],
  ]) {
    const h = recon(o);
    const out = await PD.reconcile(unknown, h.deps);
    assert.deepEqual([out.state, out.error_code], ["outcome_unknown", code]);
    assert.equal(h.transitions.length, 0, `${code}: left for operator review`);
  }
  for (const [o, code] of [[{ copy: null }, "copy_unavailable"], [{ copy: "something else" }, "copy_unavailable"], [{ deny: (a) => a === "retry" }, "posting_disabled"]]) {
    const h = recon(o);
    const out = await PD.reconcile(unknown, h.deps);
    assert.deepEqual([out.state, out.error_code], ["outcome_unknown", code]);
    assert.equal(h.opened.length, 0, `${code}: no session`);
  }
  {
    const h = recon({ page: { feed: feedWithOurs }, illegalAt: "verified_posted" });
    const out = await PD.reconcile(unknown, h.deps);
    assert.equal(out.error_code, "illegal_transition");
  }
  {
    const h = recon();
    assert.deepEqual(await PD.reconcile(attemptOf({ state: "verified_posted" }), h.deps), { state: "verified_posted" });
    assert.equal(h.opened.length, 0);
  }

  // ── the proof, directly: pure over the page reads ──
  {
    const page = fakePage({ texts: { [S.editor]: COPY } });
    assert.deepEqual(await PD.proveIdentityAndDestination(page, attemptOf(), connOf(), { copy: COPY }), { ok: true });
    assert.deepEqual(await PD.proveIdentityAndDestination(page, attemptOf(), connOf(), {}), { ok: false, code: "copy_mismatch" });
    assert.deepEqual(await PD.proveIdentityAndDestination(page, attemptOf({ target_id: "slug:111x", target_url: "https://www.facebook.com/groups/111x" }), connOf(), { copy: COPY }), { ok: false, code: "destination_mismatch" }, "an unresolved slug never passes");
    assert.equal(P.permalinkOf("https://evil.example/groups/111/posts/1", "group", ["111"]), null);
    assert.equal(P.permalinkOf("https://www.facebook.com/groups/222/posts/1", "group", ["111"]), null);
    assert.equal(P.permalinkOf("https://www.facebook.com/permalink.php?story_fbid=9&id=555", "page", ["555"]), "https://www.facebook.com/permalink.php?story_fbid=9&id=555");
    assert.equal(P.norm("  á\n\n b "), "á b", "NFC, whitespace collapsed, trimmed");
  }

  // ── nothing identifying was logged ──
  const all = logged.join("\n");
  for (const bad of [PHONE, "facebook.com", "f.ly", NAME, GROUP_NAME, PAGE_NAME, "דירה", "http", profileName("facebook", PHONE, 0)]) {
    assert.ok(!all.includes(bad), `a log line carries ${bad.slice(0, 6)}…`);
  }
  Object.assign(console, real);
  console.log("posting-driver.test.js ok");
})().catch((e) => { Object.assign(console, real); console.error(e); process.exit(1); });
