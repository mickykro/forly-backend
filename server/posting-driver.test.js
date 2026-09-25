/* posting-driver.js — one attempt through its durable states, against a fake
   page (posting-driver-fakes.js). The fake matches on the EXPORTED selectors.
   No network, no Driver. reconcile() is in posting-driver-reconcile.test.js. */
const F = require("./posting-driver-fakes");
const assert = require("assert");
const PD = require("./posting-driver");
const { sha } = require("./posting-campaign");
const { profileName } = require("./profile-name");
const S = PD.SELECTORS;
const { PHONE, NAME, GROUP_NAME, PAGE_NAME, COPY, LINK, GROUP_URL, PERMA, PAGE_URL, PAGE_PERMA, connOf, attemptOf, argsOf, harness } = F;

// Every console line the driver writes is captured and checked at the end.
const logged = [];
const real = { log: console.log, error: console.error, warn: console.warn };
for (const k of Object.keys(real)) console[k] = (...a) => logged.push(a.join(" "));

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
    assert.equal(h.transitions[3].d.clicked, false, "M9: recorded as not clicked");
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
  // M3: a real "Join group" at the proof → not_member + membership left; an unreadable marker → markers_missing
  {
    const h = harness({ page: { counts: { [S.joinGroup]: (s) => (s.editor ? 1 : 0) } } });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.deepEqual([out.error_code, out.membership], ["not_member", "left"]);
    const h2 = harness({ page: { counts: { [S.joinGroup]: (s) => { if (s.editor) throw new Error("detached"); return 0; } } } });
    const out2 = await PD.postToGroup(argsOf(), h2.deps);
    assert.deepEqual([out2.state, out2.error_code, out2.membership], ["verified_failed", "markers_missing", undefined]);
    assert.equal(h2.submits(), 0);
  }
  // M5: exactly one composer root — none, or two (a stale draft), and nothing is typed or clicked
  for (const [n, code] of [[0, "composer_not_found"], [2, "destination_mismatch"]]) {
    const h = harness({ page: { counts: { [S.composerRoot]: n } } });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.deepEqual([out.state, out.error_code], ["verified_failed", code], `${n} composer roots`);
    assert.equal(h.page.st.typed.length, 0);
    assert.equal(h.submits(), 0);
  }
  {
    // …and one that appears between typing and the proof is caught by the proof itself
    const h = harness({ page: { counts: { [S.composerRoot]: (s) => (s.editor ? 2 : 1) } } });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.deepEqual([out.state, out.error_code], ["verified_failed", "destination_mismatch"]);
    assert.equal(h.submits(), 0);
    assert.ok(S.submit.includes(S.composerRoot) && S.composerTarget.includes(S.composerRoot) && S.composerAuthor.includes(S.composerRoot), "scoped to the composer root");
  }
  // M8: every keystroke goes through a locator (the editor, then the comment box) — never page.keyboard.type
  {
    const h = harness();
    await PD.postToGroup(argsOf(), h.deps);
    assert.equal(h.page.st.keyboardTyped, undefined);
    assert.ok(h.ev.includes("type:editor") && h.ev.includes("type:commentBox"));
    assert.ok(h.ev.filter((e) => e.startsWith("type:")).every((e) => e === "type:editor" || e === "type:commentBox"));
  }
  {
    // focus cannot be held inside the editor → typing stops, verified_failed, nothing more typed or clicked
    const h = harness({ page: { focusLost: (s) => s.editor.length > 3 } });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.deepEqual([out.state, out.error_code], ["verified_failed", "composer_focus_lost"]);
    assert.equal(h.submits(), 0);
  }
  // M4: dryRun must be a boolean — anything else is refused before any state is written
  for (const dryRun of ["true", 1, "false", null]) {
    const h = harness();
    await assert.rejects(PD.postToGroup(argsOf({ dryRun }), h.deps), (e) => e.code === "invalid_input", String(dryRun));
    assert.equal(h.transitions.length, 0);
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
    // fix round 2 C: the slug URL landed on ANOTHER group (id 555, other name) → the proof fails,
    // and no resolved_group_id is reported (it would merge two groups)
    const hm = harness({ conn: { facebook_groups_member: [{ group_id: "slug:haifa.rent", name: GROUP_NAME }] },
      page: { attrs: { [S.targetIdMeta]: "fb://group/555" }, texts: { [S.targetName]: "Other group" } } });
    const mis = await PD.postToGroup(argsOf({ attempt: a, groupUrl: slugUrl }), hm.deps);
    assert.deepEqual([mis.state, mis.error_code, mis.resolved_group_id], ["verified_failed", "destination_mismatch", undefined]);
    assert.equal(hm.submits(), 0);
    // fix round 2 E: the membership entry is found through its alias
    const P = require("./posting-driver-proof");
    const aliased = connOf({ facebook_groups_member: [{ group_id: "12345", aliases: ["slug:haifa.rent"], name: GROUP_NAME }] });
    assert.equal(P.expectedTarget(a, aliased).name, P.norm(GROUP_NAME));
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
  // ── M1: verified_posted is written BEFORE the comment; the comment's result is a follow-up note ──
  {
    const h = harness();
    await PD.postToGroup(argsOf(), h.deps);
    assert.ok(h.ev.indexOf("t:verified_posted") < h.ev.indexOf("click:commentSubmit"), "state first, then the comment");
    const h2 = harness({ page: { counts: { [S.commentBox]: 0 } } });
    const out = await PD.postToGroup(argsOf(), h2.deps);
    assert.equal(out.state, "verified_posted");
    assert.equal(out.comment_error_code, "comment_box_not_found");
    assert.equal(h2.transitions[4].d.comment_error_code, undefined, "not part of the state write");
    assert.deepEqual(h2.annotations, [{ comment_error_code: "comment_box_not_found" }], "recorded in a follow-up write");
    assert.ok(h2.ev.indexOf("t:verified_posted") < h2.ev.indexOf("annotate"));
    // the tick timed out and moved the attempt: verified_posted is refused → no comment at all
    const h3 = harness({ illegalAt: "verified_posted" });
    const out3 = await PD.postToGroup(argsOf(), h3.deps);
    assert.equal(out3.error_code, "illegal_transition");
    assert.ok(!h3.page.st.clicks.includes(S.commentSubmit), "no comment after a refused state write");
  }
  // ── M2: a halting signal on the permalink page is returned, even when the feed matched ──
  {
    const h = harness({ page: { redirect: (u) => (/\/posts\//.test(u) ? "https://www.facebook.com/checkpoint/1/" : u) } });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.deepEqual([out.state, out.signal, out.error_code], ["verified_posted", "checkpoint", "checkpoint"], "the feed matched exactly; the halt still reaches the tick");
    assert.equal(h.transitions[4].d.signal, "checkpoint");
    assert.ok(!h.page.st.clicks.includes(S.commentSubmit), "no comment on a checkpoint page");
    const h2 = harness({ page: {
      redirect: (u) => (/\/posts\//.test(u) ? "https://www.facebook.com/checkpoint/1/" : u),
      feed: (s) => (s.submitted ? [{ href: PERMA, author: NAME, text: `${COPY.slice(0, 30)}… See more` }] : []),
    } });
    const out2 = await PD.postToGroup(argsOf(), h2.deps);
    assert.deepEqual([out2.state, out2.signal, out2.error_code], ["outcome_unknown", "checkpoint", "checkpoint"]);
  }

  // ── signals: editable content is removed from every region, the copy is stripped,
  // a phrase that is in our own copy is ignored — the composer's chrome still counts ──
  {
    const COPY2 = "דירה בחיפה. You're restricted from posting in groups? לא אצלנו! נחסמת באופן זמני? גם לא. You're temporarily blocked from posting — no.";
    const a = attemptOf({ copy_hash: sha(COPY2) });
    const h = harness({ page: {
      texts: { [S.postMessage]: COPY2 },
      regions: {
        [S.dialog]: (s) => [{ text: "Create post Post", editable: s.editor }, { text: `Preview: ${COPY2}` }],
        // a toast that IS a cut of the copy, one that holds a cut in a span, and the whole copy
        [S.alert]: (s) => (s.submitted ? [
          { text: `${COPY2.slice(0, 60)}…` },
          { text: `Posted: ${COPY2.slice(0, 60)}…`, children: [`${COPY2.slice(0, 60)}…`] },
          { text: COPY2 },
        ] : []),
      },
      feed: (s) => (s.submitted ? [{ href: PERMA, author: NAME, text: COPY2 }] : []),
    } });
    const out = await PD.postToGroup(argsOf({ attempt: a, copy: COPY2 }), h.deps);
    assert.equal(out.state, "verified_posted");
    assert.equal(out.signal, undefined, "the copy never produced a signal");
    assert.equal(h.submits(), 1);
  }
  for (const [label, region, code] of [
    ["an inline error in the composer chrome, outside the editor", (s) => ({ text: "Create post You can't post in this group Post", editable: s.editor }), "group_blocked"],
    ["a restriction dialog wrapping the composer", (s) => ({ text: "Your account is restricted Create post", editable: s.editor }), "restricted"],
  ]) {
    // It appears once the composer is open: pre-submit → verified_failed with that code, zero clicks.
    const h = harness({ page: { regions: { [S.dialog]: (s) => (s.clicks.includes(S.composer) ? [region(s)] : []) } } });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.deepEqual([out.state, out.error_code], ["verified_failed", code], label);
    assert.equal(h.submits(), 0, label);
  }
  {
    // fix round 2 A: the restriction dialog wraps the composer and the root count reads 2 —
    // the signal is read FIRST, so it is `restricted`, not destination_mismatch
    const h = harness({ page: {
      counts: { [S.composerRoot]: (s) => (s.clicks.includes(S.composer) ? 2 : 1) },
      regions: { [S.dialog]: (s) => (s.clicks.includes(S.composer) ? [{ text: "Your account is restricted", editable: s.editor }, { text: "Create post", editable: s.editor }] : []) },
    } });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.deepEqual([out.state, out.error_code, out.signal], ["verified_failed", "restricted", "restricted"]);
    assert.equal(h.submits(), 0);
  }
  {
    // a nested Create-post layer with no signal (one innermost root) posts normally
    const h = harness({ page: { regions: { [S.dialog]: (s) => [{ text: "layer", editable: s.editor }, { text: "Create post", editable: s.editor }] } } });
    assert.equal((await PD.postToGroup(argsOf(), h.deps)).state, "verified_posted");
    assert.equal(h.submits(), 1);
  }
  {
    // fix round 2 B: an ordinary copy sharing a short phrase never hides a real alert
    for (const [copy, alert, code] of [
      ["דירה ברחוב הנביאים. הכביש חסום זמנית בגלל עבודות, חניה בשפע", "אתה חסום זמנית מפרסום בקבוצות", "rate_limited"],
      ["דירה חדשה מקבלן, הנכס ממתין לאישור טאבו, כניסה מיידית", "הפוסט שלך ממתין לאישור מנהל הקבוצה", "pending_approval"],
    ]) {
      const a = attemptOf({ copy_hash: sha(copy) });
      const h = harness({ page: { texts: { [S.postMessage]: copy }, feed: [], regions: { [S.alert]: (s) => (s.submitted ? [{ text: alert }] : []) } } });
      const out = await PD.postToGroup(argsOf({ attempt: a, copy }), h.deps);
      assert.equal(out.state, code === "pending_approval" ? "submitted_for_approval" : "outcome_unknown", code);
      if (code === "rate_limited") assert.equal(out.signal, "rate_limited");
    }
  }
  {
    // after the click, the same restriction wrapping a still-open composer → reported
    const h = harness({ page: { regions: { [S.dialog]: (s) => (s.submitted ? [{ text: "Your account is restricted", editable: s.editor }] : [{ text: "Create post", editable: s.editor }]) } } });
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.deepEqual([out.state, out.signal], ["outcome_unknown", "restricted"]);
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

  // ── nothing identifying was logged ──
  const all = logged.join("\n");
  for (const bad of [PHONE, "facebook.com", "f.ly", NAME, GROUP_NAME, PAGE_NAME, "דירה", "http", profileName("facebook", PHONE, 0)]) {
    assert.ok(!all.includes(bad), `a log line carries ${bad.slice(0, 6)}…`);
  }
  Object.assign(console, real);
  console.log("posting-driver.test.js ok");
})().catch((e) => { Object.assign(console, real); console.error(e); process.exit(1); });
