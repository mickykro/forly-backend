/* posting-driver.reconcile() — an outcome_unknown attempt is only ever
   looked at: found → verified_posted; a healthy newest-first read without it
   → reconciled_absent; anything less → left for operator review. Also the
   R3 proof and the permalink helpers, directly. Fake page, no network. */
const F = require("./posting-driver-fakes");
const assert = require("assert");
const PD = require("./posting-driver");
const P = require("./posting-driver-proof");
const { profileName } = require("./profile-name");
const S = PD.SELECTORS;
const { PHONE, NAME, GROUP_NAME, COPY, PERMA, connOf, attemptOf, fakePage, harness } = F;

const logged = [];
const real = { log: console.log, error: console.error, warn: console.warn };
for (const k of Object.keys(real)) console[k] = (...a) => logged.push(a.join(" "));
const PAGE_NAME = F.PAGE_NAME;

(async () => {
  // ── reconcile: only ever looks ──
  const unknown = attemptOf({ state: "outcome_unknown" });
  const recon = (o = {}) => {
    const h = harness(o);
    h.deps.copy = o.copy === undefined ? COPY : o.copy;
    return h;
  };
  const feedWithOurs = [{ href: "https://www.facebook.com/groups/111/posts/1", author: "A", text: "x" }, { href: `${PERMA}?x=1`, author: NAME, text: COPY }, { href: "https://www.facebook.com/groups/111/posts/2", author: "B", text: "y" }];
  const foreign = (n, o = {}) => Array.from({ length: n }, (_, i) => Object.assign({ href: `https://www.facebook.com/groups/111/posts/${100 + i}`, author: `Other ${i}`, text: `post ${i}` }, o));
  const feedWithout = foreign(15);
  {
    // a healthy read of the newest-first feed, and it is not there → reconciled_absent
    const h = recon({ page: { feed: feedWithout } });
    const out = await PD.reconcile(unknown, h.deps);
    assert.deepEqual(h.states(), ["verified_failed"]);
    assert.equal(h.transitions[0].d.error_code, "reconciled_absent");
    assert.equal(out.state, "verified_failed");
    assert.equal(h.page.st.clicks.length, 0);
    assert.ok(/[?&]sorting_setting=CHRONOLOGICAL/.test(h.page.st.visited[0]), "the chronological view was asked for");
  }
  // ── the selector health check: anything short of it stays outcome_unknown, noted feed_unread ──
  for (const [label, o] of [
    ["the text selector drifted (our post is there, unreadable)", { page: { feed: foreign(15).map((p, i) => (i === 0 ? { ...p, author: NAME, text: "" } : { ...p, text: "" })) } }],
    ["the author selector drifted", { page: { feed: foreign(15, { author: "" }) } }],
    ["one post without text", { page: { feed: foreign(15).map((p, i) => (i === 3 ? { ...p, text: "" } : p)) } }],
    ["fewer than 5 posts read", { page: { feed: foreign(4) } }],
    ["nothing read", { page: { feed: [] } }],
    ["the chronological view did not load (Facebook dropped the parameter)", { page: { feed: feedWithout, redirect: (u) => u.split("?")[0] } }],
  ]) {
    const h = recon(o);
    const out = await PD.reconcile(unknown, h.deps);
    assert.deepEqual([out.state, out.error_code, out.reconcile_note], ["outcome_unknown", "feed_unread", "feed_unread"], label);
    assert.equal(h.transitions.length, 0, `${label}: no transition`);
    assert.deepEqual(h.annotations, [{ reconcile_note: "feed_unread" }], `${label}: noted on the attempt`);
  }
  {
    // the same dropped parameter, but the page shows its "New posts" sort marker → trusted
    const h = recon({ page: { feed: feedWithout, redirect: (u) => u.split("?")[0], counts: { [S.chronoMarker]: 1 } } });
    assert.equal((await PD.reconcile(unknown, h.deps)).state, "verified_failed");
  }
  for (const [o, code] of [
    [{ page: { feed: feedWithout, redirect: () => "https://www.facebook.com/checkpoint/1/" } }, "checkpoint"],
    [{ page: { feed: feedWithout, attrs: { [S.targetIdMeta]: "fb://group/222" } } }, "destination_mismatch"],
    [{ page: { feed: feedWithout, counts: { [S.joinGroup]: () => { throw new Error("detached"); } } } }, "markers_missing"],
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
  // M7: only an outcome_unknown attempt — a missing state is not one
  for (const state of ["verified_posted", undefined, "submit_started"]) {
    const h = recon();
    const out = await PD.reconcile(attemptOf(state ? { state } : {}), h.deps);
    assert.equal(out.error_code, "not_outcome_unknown");
    assert.equal(h.opened.length, 0, `${state}: no session`);
  }

  // ── fix round 3: the per-region echo strip, directly ──
  {
    const { stripEcho, classifySignal } = require("./posting-signals");
    const copy = "דירה ברחוב הנביאים. הכביש חסום זמנית בגלל עבודות, חניה בשפע";
    assert.equal(stripEcho("Posted: הכביש חסום זמנית בגלל עבודות…", copy), "Posted: …", "a >= 20-char run shared with the copy is removed");
    assert.equal(stripEcho("אתה חסום זמנית מפרסום בקבוצות", copy), "אתה חסום זמנית מפרסום בקבוצות", "a short shared phrase is not");
    const echo = "הכביש חסום זמנית בגלל עבודות", real = "אתה חסום זמנית מפרסום בקבוצות עד מחר";
    assert.equal(classifySignal({ regions: [echo, real], ownText: copy }), "rate_limited", "one region never excuses another");
    assert.equal(classifySignal({ regions: [echo], ownText: copy }), "ok");
    assert.equal(classifySignal({ regions: ["הפוסט שלך ממתין לאישור מנהל הקבוצה"], ownText: "הנכס ממתין לאישור טאבו, כניסה מיידית" }), "pending_approval");
    assert.equal(classifySignal({ regions: [echo], ownText: copy, landedUrl: "https://www.facebook.com/checkpoint/1/" }), "checkpoint", "the URL always counts");
    assert.equal(classifySignal({ dialogText: "You can't use this feature right now" }), "feature_blocked", "the old string form is unchanged");
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
  console.log("posting-driver-reconcile.test.js ok");
})().catch((e) => { Object.assign(console, real); console.error(e); process.exit(1); });
