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

  // ── fix rounds 3-4: the echo rule, directly — per region, per match ──
  {
    const { echoed, classifySignal } = require("./posting-signals");
    const copy = "דירה ברחוב הנביאים. הכביש חסום זמנית בגלל עבודות, חניה בשפע";
    const at = (t, phrase) => [t.indexOf(phrase), t.indexOf(phrase) + phrase.length];
    const toast = "Posted: הכביש חסום זמנית בגלל עבודות…";
    assert.equal(echoed(toast, copy, ...at(toast, "חסום זמנית")), true, "a match inside a >= 20-char run shared with the copy is excused");
    const alert = "אתה חסום זמנית מפרסום בקבוצות";
    assert.equal(echoed(alert, copy, ...at(alert, "חסום זמנית")), false, "a short shared phrase is not");
    const echo = "הכביש חסום זמנית בגלל עבודות", real = "אתה חסום זמנית מפרסום בקבוצות עד מחר";
    assert.equal(classifySignal({ regions: [echo, real], ownText: copy }), "rate_limited", "one region never excuses another");
    assert.equal(classifySignal({ regions: [`${echo} ${real}`], ownText: copy }), "rate_limited", "an echo beside a real alert in ONE region: the real match is not excused");
    assert.equal(classifySignal({ regions: [echo], ownText: copy }), "ok");
    assert.equal(classifySignal({ regions: ["הפוסט שלך ממתין לאישור מנהל הקבוצה"], ownText: "הנכס ממתין לאישור טאבו, כניסה מיידית" }), "pending_approval");
    assert.equal(classifySignal({ regions: [echo], ownText: copy, landedUrl: "https://www.facebook.com/checkpoint/1/" }), "checkpoint", "the URL always counts");
    assert.equal(classifySignal({ regions: [echo], ownText: copy, hasCaptchaFrame: true }), "captcha", "a captcha frame always counts");
    assert.equal(classifySignal({ regions: ["Confirm you're human"], ownText: "Confirm you're human, then read on: 3 rooms" }), "captcha", "fix round 5: the exact captcha sentence is a whole region, no room for context: never excused");
    assert.equal(classifySignal({ regions: ["Confirm you're human"], ownText: "3 rooms" }), "captcha");
    assert.equal(classifySignal({ dialogText: "You can't use this feature right now" }), "feature_blocked", "the old string form is unchanged");

    // round-3 regression: a shared run that only CUTS INTO Facebook's sentence never hides it
    const enAlert = "You're temporarily blocked from posting in this group";
    const enCopy = "Quiet street, never temporarily blocked from post office traffic. 3 rooms";
    assert.equal(classifySignal({ regions: [enAlert], ownText: enCopy }), "rate_limited", "EN bisect: the 29-char shared run cuts 'posting'");
    const heAlert = "דירה למכירה. נחסמת באופן זמני מפרסום";
    const heCopy = "דירה למכירה. נחסמת באופנוע בדרך לדירה? יש חניה";
    assert.equal(classifySignal({ regions: [heAlert], ownText: heCopy }), "rate_limited", "HE bisect: the 23-char shared run cuts 'באופן זמני'");
    assert.equal(classifySignal({ regions: [`Posted: ${enCopy.slice(0, 50)}… ${enAlert}`], ownText: enCopy }), "rate_limited", "echo toast and a real alert in one region");

    // fix round 5: the phrase alone never excuses itself — ECHO_CONTEXT more characters of the copy must be echoed around it
    for (const [label, region, own, want] of [
      ["EN: the copy holds the phrase alone", "You're temporarily blocked from posting in this group", "x You're temporarily blocked from posting y", "rate_limited"],
      ["EN: the copy is exactly the phrase", "Your account is restricted", "Your account is restricted", "restricted"],
      ["HE: the copy holds the phrase alone", "לא ניתן לפרסם בקבוצה הזו כרגע", "דירה. לא ניתן לפרסם בקבוצה! יש חניה", "group_blocked"],
      ["9 characters of context (25 in all) are not enough", "Hi. xxxx posting too fast yyy!", "axxxx posting too fast yyyb", "rate_limited"],
      ["10 characters of context (26 in all) are enough", "Hi. xxxx posting too fast yyyy!", "axxxx posting too fast yyyyb", "ok"],
      ["a long phrase needs its own length + 10", "Toast: we limit how often you can do this. 3 rooms, sea view", "Honestly, we limit how often you can do this. 3 rooms, sea view!", "ok"],
      ["the whole copy echoed", "Posted: x You're temporarily blocked from posting y", "x You're temporarily blocked from posting y", "rate_limited"],
    ]) assert.equal(classifySignal({ regions: [region], ownText: own }), want, label);
    // accepted edge (fail-safe): an echo whose phrase sits within 10 characters of the copy's end reads as the signal
    assert.equal(classifySignal({ regions: ["Posted: Nice! posting too fast"], ownText: "Nice! posting too fast" }), "rate_limited");
    // fix round 5: whitespace is collapsed before the raw cut
    assert.equal(classifySignal({ regions: [" ".repeat(9000) + "posting too fast"], ownText: "x" }), "rate_limited", "9000 spaces, then an alert");
    assert.equal(classifySignal({ regions: ["\n\t ".repeat(5000) + "Your account is restricted"], ownText: "x" }), "restricted");

    // bounded: a megabyte comment-thread dialog, and a long copy, classify fast
    const thread = "Nice flat! temporarily blocked from post office? ".repeat(21000); // ~1M characters
    assert.ok(thread.length >= 1e6);
    const longCopy = "Quiet street, never temporarily blocked from post office traffic. ".repeat(2000);
    const heEcho = "הכביש חסום זמנית בגלל עבודות, הבניין ממתין לאישור. ".repeat(500);
    for (const [label, regions, own, want] of [
      ["1M-char region, no signal", [thread], longCopy, "ok"],
      ["1M-char region with a real alert at the top", [enAlert + " " + thread], longCopy, "rate_limited"],
      ["1M-char region that is all echo", [longCopy.repeat(8)], longCopy, "ok"],
      ["1M-char region of echoed signal phrases", [heEcho.repeat(40)], heEcho, "ok"],
      ["1M-char region, a shared phrase in a different context", ["x חסום זמנית y ".repeat(70000)], "a חסום זמנית b ".repeat(1000), "rate_limited"],
    ]) {
      const t0 = process.hrtime.bigint();
      const got = classifySignal({ regions, ownText: own });
      const took = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.equal(got, want, label);
      assert.ok(took < 50, `${label}: ${took.toFixed(1)} ms`);
    }
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
