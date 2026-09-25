/* posting-recheck.js — the 24 h re-check: the session is guarded (R2) and
   recheckPost gets deps.phone; a first absence is not a penalty; a second
   absence >= 24 h later is confirmed_removed and calls haltAccount once;
   unknown / access_denied / session / selector failures are anomalies only;
   skipped accounts and the kill switch open nothing; at most 3 posts. */
const F = require("./posting-driver-fakes"); // sets PROFILE_KEY; load first
const assert = require("assert");
const K = require("./posting-testkit");
const R = require("./posting-recheck");
const S = require("./posting-sweeper");
const guardLive = require("./posting-guard");

const { db, store, NOW, HOUR, DAY, iso, setup } = K;
const PH = "972500000001";
const GROUP = (id) => `https://www.facebook.com/groups/${id}`;
const conn = async () => (await db.getConnection(PH)) || {};
const removals = async () => ((await conn()).posting_halts || []).filter((h) => h.code === "confirmed_removed");
const health = async () => ((await db.getSetting("posting_health")) || {}).recheck_anomalies || {};

// A group attempt driven to verified_posted (or submitted_for_approval) at `at`.
async function posted(id, at = NOW, end = "verified_posted") {
  const r = await store.reserveAttempt({
    phone: PH, page_id: "pg1", target_type: "group", target_id: id, target_url: GROUP(id), publisher: "browser",
    campaign_id: "camp1", post_id: `p${id}`, click_id: id.padStart(32, "a"), now: at, limits: { daily_cap: 20, group_global_daily_cap: 20 },
  });
  assert.ok(r.ok, r.reason);
  for (const s of ["session_started", "composer_ready", "submit_started", "verification_pending"]) await store.transition(r.attempt.key, s, {}, at);
  return store.transition(r.attempt.key, end, { post_url: `${GROUP(id)}/posts/9${id}/` }, at);
}

// deps for recheckOne: a fake Driver session over a fake page, a recording
// recheckPost, and a spy on the real guard.
function harness(deps, { results = {}, page = {}, openThrows = null, real = false } = {}) {
  const realRecheck = require("./social-dwell").recheckPost;
  const ev = [], seen = [], opened = [];
  const guard = {
    assertFleetAllowed: guardLive.assertFleetAllowed,
    assertAllowed: async (i, d) => { ev.push(`guard:${i.action}`); return guardLive.assertAllowed(i, d); },
  };
  const pg = F.fakePage(Object.assign({ attrs: { [require("./posting-driver-proof").SELECTORS.targetIdMeta]: "fb://group/111" } }, page));
  const d = Object.assign({}, deps, {
    guard,
    withPage: async (opts, fn, pd) => { ev.push("open"); opened.push({ opts, pd }); if (openThrows) throw openThrows; try { return await fn(pg, { sessionId: "s" }); } finally { ev.push("close"); } },
    recheckPost: async (p, url, rd) => {
      seen.push({ url, deps: rd });
      ev.push("recheck");
      if (real) return realRecheck(p, url, rd);
      const id = (url.match(/groups\/(\d+)\//) || [])[1];
      const r = typeof results[id] === "function" ? results[id]() : results[id];
      return r || { state: "visible", reactions: 5, comments: 1 };
    },
  });
  return { d, ev, seen, opened, pg };
}

(async () => {
  // ── not due before 24 h; the reservation wrote the click doc and the due time ──
  {
    const { deps } = await setup();
    const a = await posted("111");
    assert.equal(a.recheck_due_at, iso(NOW.getTime() + DAY));
    assert.equal((await store.getClick(a.click_id)).attempt_key, a.key);
    const h = harness(deps);
    assert.equal(await R.recheckOne(h.d, new Date(NOW.getTime() + 23 * HOUR)), "none");
    assert.equal(h.opened.length, 0);
  }

  // ── first absence: no penalty; second absence >= 24 h later: confirmed_removed, haltAccount once ──
  {
    const { deps, notes } = await setup();
    const a = await posted("111");
    const h = harness(deps, { results: { 111: { state: "not_found", reactions: null, comments: null } } });
    const t1 = new Date(NOW.getTime() + 25 * HOUR);
    assert.equal(await R.recheckOne(h.d, t1), "rechecked");
    // R2: the session is guarded before it opens; recheckPost gets deps.phone
    assert.ok(h.ev.indexOf("guard:session") >= 0 && h.ev.indexOf("guard:session") < h.ev.indexOf("open"), h.ev.join(","));
    assert.equal(h.seen[0].deps.phone, PH); assert.equal(h.seen[0].deps.platform, "facebook"); assert.ok(h.seen[0].deps.guard);
    assert.equal(h.seen[0].url, a.post_url);
    const o = h.opened[0];
    assert.ok(/^forly-recheck:/.test(o.opts.note)); assert.ok(o.opts.duration > 0 && o.opts.duration <= 14 * 60);
    assert.equal(o.pd.phone, PH); assert.equal(o.pd.platform, "facebook"); assert.ok(o.pd.conn); assert.equal(o.pd.lockHeld, true);
    assert.ok(o.opts.profile && o.opts.profile.persist === true);
    assert.ok(h.ev.includes("guard:navigate"), "the group check's navigation is guarded too");
    let b = await store.getAttempt(a.key);
    assert.equal(b.visibility, "not_found"); assert.equal(b.first_absent_at, iso(t1)); assert.equal(b.checked_at, iso(t1));
    assert.equal(b.recheck_due_at, iso(t1.getTime() + DAY));
    assert.equal((await removals()).length, 0, "a first absence is never a penalty");
    assert.equal((await health()).not_found, 1);

    assert.equal(await R.recheckOne(h.d, new Date(t1.getTime() + 12 * HOUR)), "none", "not again before 24 h");
    const t2 = new Date(t1.getTime() + DAY + HOUR);
    assert.equal(await R.recheckOne(h.d, t2), "rechecked");
    b = await store.getAttempt(a.key);
    assert.equal(b.visibility, "confirmed_removed"); assert.equal(b.recheck_due_at, null); assert.equal(b.first_absent_at, iso(t1));
    const rm = await removals();
    assert.equal(rm.length, 1); assert.equal(rm[0].group_id, "111");
    assert.ok(((await conn()).posting_group_penalties || {})["111"], "that group is off for 30 days");
    assert.ok(notes.some((m) => /הסירו פוסט/.test(m)));
    assert.equal(await R.recheckOne(h.d, new Date(t2.getTime() + 3 * DAY)), "none");
    assert.equal((await removals()).length, 1, "haltAccount called once");
  }

  // ── anomalies only: access_denied, session / selector failure, a closed group, unknown ──
  {
    const { deps } = await setup();
    const a1 = await posted("111"), a2 = await posted("222"), a3 = await posted("333");
    const h = harness(deps, { results: {
      111: { state: "unknown", reactions: null, comments: null, signal: "not_member" },
      222: { state: "unknown", reactions: null, comments: null },
      333: { state: "unknown", reactions: null, comments: null, signal: "group_blocked" },
    } });
    await R.recheckOne(h.d, new Date(NOW.getTime() + 25 * HOUR));
    assert.equal((await store.getAttempt(a1.key)).visibility, "access_denied");
    assert.equal((await store.getAttempt(a2.key)).visibility, "selector_failure");
    assert.equal((await store.getAttempt(a3.key)).visibility, "access_denied");
    assert.equal((await store.getAttempt(a2.key)).recheck_due_at, iso(NOW.getTime() + 31 * HOUR), "looked at again 6 h later");
    assert.deepEqual(await health(), { access_denied: 2, selector_failure: 1 });
    assert.equal(((await conn()).posting_halts || []).length, 0, "nothing but an anomaly");

    // a checkpoint URL mid-session (the real recheckPost): session_failure, the
    // session stops there, and the account halts with `checkpoint` (R5)
    const { deps: d2 } = await setup();
    const b1 = await posted("111"), b2 = await posted("222");
    const h2 = harness(d2, { real: true, page: { redirect: () => "https://www.facebook.com/checkpoint/1501092823525282/" } });
    await R.recheckOne(h2.d, new Date(NOW.getTime() + 25 * HOUR));
    assert.equal((await store.getAttempt(b1.key)).visibility, "session_failure");
    assert.equal(h2.seen.length, 1, "no further post visited after a checkpoint");
    assert.equal(h2.pg.st.visited.length, 1, "one navigation, then the session stops");
    const c2 = await store.getAttempt(b2.key);
    assert.equal(c2.visibility, undefined); assert.equal(c2.recheck_tries, undefined, "not visited: no try used");
    assert.ok(c2.recheck_due_at > iso(NOW.getTime() + 25 * HOUR));
    const k2 = await conn();
    assert.deepEqual((k2.posting_halts || []).map((h) => h.code), ["checkpoint"], "haltAccount called with checkpoint");
    assert.equal(k2.posting_disabled_until_admin, true);
    assert.equal((await health()).session_failure, 1, "the anomaly is recorded too");
    // seen again later: idempotent (the disabled account is not even opened)
    const h2b = harness(d2, { real: true, page: { redirect: () => "https://www.facebook.com/checkpoint/1/" } });
    await R.recheckOne(h2b.d, new Date(NOW.getTime() + 40 * HOUR));
    assert.equal(h2b.opened.length, 0);
    assert.equal(((await conn()).posting_halts || []).length, 1);

    // fix round 1: the halt comes before the writes — a failing recordRecheck still halts,
    // and the next sweep opens no session
    {
      const { deps: d8 } = await setup();
      const f1 = await posted("111");
      const h8 = harness(d8, { results: { 111: { state: "unknown", reactions: null, comments: null, signal: "checkpoint" } } });
      const real = store.recordRecheck;
      store.recordRecheck = async (k, patch, n) => { if (patch.visibility) throw Object.assign(new Error("unavailable"), { code: "unavailable" }); return real(k, patch, n); };
      try { assert.equal(await R.recheckOne(h8.d, new Date(NOW.getTime() + 25 * HOUR)), "rechecked"); }
      finally { store.recordRecheck = real; }
      const k8 = await conn();
      assert.deepEqual((k8.posting_halts || []).map((h) => h.code), ["checkpoint"], "halted although the write failed");
      assert.equal((await store.getAttempt(f1.key)).visibility, undefined, "the write did fail");
      assert.equal(await R.recheckOne(h8.d, new Date(NOW.getTime() + 25 * HOUR + 60000)), "skipped");
      assert.equal(h8.opened.length, 1, "no session on the halted account");
    }

    // a login wall on the GROUP page after a clean "not found": login_required, no removal
    const { deps: d6 } = await setup();
    const l1 = await posted("111"); await posted("222");
    const h6 = harness(d6, { results: { 111: { state: "not_found", reactions: null, comments: null } }, page: { redirect: (u) => (/\/posts\//.test(u) ? u : "https://www.facebook.com/login/?next=x") } });
    await R.recheckOne(h6.d, new Date(NOW.getTime() + 25 * HOUR));
    const l = await store.getAttempt(l1.key);
    assert.equal(l.visibility, "session_failure"); assert.equal(l.first_absent_at, undefined);
    assert.equal(h6.seen.length, 1, "the session stops at the login wall");
    const k6 = await conn();
    assert.deepEqual((k6.posting_halts || []).map((h) => h.code), ["login_required"]);
    assert.equal(k6.facebook_needs_reconnect, true);
    // a rate-limit signal on the post: a penalty
    const { deps: d7 } = await setup();
    await posted("111");
    const h7 = harness(d7, { results: { 111: { state: "unknown", reactions: null, comments: null, signal: "rate_limited" } } });
    await R.recheckOne(h7.d, new Date(NOW.getTime() + 25 * HOUR));
    assert.ok((await conn()).posting_penalty_until, "rate_limited → penalty");

    // not found, but the group shows Join: access_denied, never a first absence
    const { deps: d3 } = await setup();
    const e1 = await posted("111");
    const S_ = require("./posting-driver-proof").SELECTORS;
    const h3 = harness(d3, { results: { 111: { state: "not_found", reactions: null, comments: null } }, page: { counts: { [S_.joinGroup]: 1 } } });
    await R.recheckOne(h3.d, new Date(NOW.getTime() + 25 * HOUR));
    const e = await store.getAttempt(e1.key);
    assert.equal(e.visibility, "access_denied"); assert.equal(e.first_absent_at, undefined);
    // not found, but the page's group is another group: unknown
    const { deps: d4 } = await setup();
    const f1 = await posted("111");
    const h4 = harness(d4, { results: { 111: { state: "not_found", reactions: null, comments: null } }, page: { attrs: { [S_.targetIdMeta]: "fb://group/999" } } });
    await R.recheckOne(h4.d, new Date(NOW.getTime() + 25 * HOUR));
    assert.equal((await store.getAttempt(f1.key)).visibility, "unknown");
    // pending group approval, not found: pending_approval, never a removal
    const { deps: d5 } = await setup();
    await posted("111", NOW, "submitted_for_approval");
    const pend = (await store.listRecheckDue(new Date(NOW.getTime() + 25 * HOUR)))[0];
    await store.recordRecheck(pend.key, { first_absent_at: iso(NOW) }, NOW); // even with an earlier absence on record
    const h5 = harness(d5, { results: { 111: { state: "not_found", reactions: null, comments: null } } });
    await R.recheckOne(h5.d, new Date(NOW.getTime() + 25 * HOUR));
    assert.equal((await store.getAttempt(pend.key)).visibility, "pending_approval");
    assert.equal((await removals()).length, 0);
  }

  // ── visible: aggregates only; at most 3 posts per session; a session that fails to open ──
  {
    const { deps } = await setup();
    const keys = [];
    for (const id of ["111", "222", "333", "444"]) keys.push((await posted(id)).key);
    const h = harness(deps, { results: { 222: { state: "visible", reactions: 12, comments: 3, who: ["someone"] } } });
    await R.recheckOne(h.d, new Date(NOW.getTime() + 25 * HOUR));
    assert.equal(h.opened.length, 1); assert.equal(h.seen.length, 3, "up to 3 posts per session");
    const v = await store.getAttempt(keys[1]);
    assert.equal(v.visibility, "visible"); assert.equal(v.reactions, 12); assert.equal(v.comments, 3); assert.equal(v.recheck_due_at, null);
    assert.equal(v.who, undefined, "never who reacted");
    assert.equal((await store.getAttempt(keys[3])).visibility, undefined, "the fourth waits for the next sweep");

    const { deps: d2 } = await setup();
    const k = (await posted("111")).key;
    const h2 = harness(d2, { openThrows: Object.assign(new Error("x"), { status: 502 }) });
    await R.recheckOne(h2.d, new Date(NOW.getTime() + 25 * HOUR));
    assert.equal((await store.getAttempt(k)).visibility, "session_failure");
    assert.equal((await health()).session_failure, 1);
  }

  // ── skipped: a disabled / penalised account, the kill switch; the profile lock ──
  {
    for (const c of [{ posting_disabled_until_admin: true }, { posting_owner_review_required: true }, { posting_penalty_until: iso(NOW.getTime() + 5 * DAY) }]) {
      const { deps } = await setup(PH, { conn: c });
      const k = (await posted("111")).key;
      const h = harness(deps);
      assert.equal(await R.recheckOne(h.d, new Date(NOW.getTime() + 25 * HOUR)), "skipped");
      assert.equal(h.opened.length, 0, JSON.stringify(c));
      assert.ok((await store.getAttempt(k)).recheck_due_at > iso(NOW.getTime() + 25 * HOUR), "deferred");
    }
    const { deps } = await setup();
    await posted("111");
    db.mem.settings.set("posting", { enabled: false, version: 2 });
    const h = harness(deps);
    assert.equal(await R.recheckOne(h.d, new Date(NOW.getTime() + 25 * HOUR)), "skipped");
    assert.equal(h.opened.length, 0, "the kill switch opens nothing");
    assert.equal(await S.sweep(h.d, new Date(NOW.getTime() + 40 * HOUR)), 0);
    assert.equal(h.opened.length, 0);
    db.mem.settings.set("posting", { enabled: true, version: 3 });
    const release = K.locks.tryAcquire(PH, "facebook");
    assert.equal(await R.recheckOne(h.d, new Date(NOW.getTime() + 40 * HOUR)), "skipped");
    assert.equal(h.opened.length, 0, "a held profile is left alone");
    release();
    // the sweeper runs it
    await S.sweep(h.d, new Date(NOW.getTime() + 40 * HOUR));
    assert.equal(h.opened.length, 1, "the sweep runs one re-check session");
  }

  // ── pure mapping ──
  {
    const { classify } = R._test;
    const at = new Date(NOW.getTime() + 2 * DAY);
    const a = { state: "verified_posted", first_absent_at: iso(NOW.getTime() + DAY) };
    assert.equal(classify(a, { r: { state: "not_found" }, inGroup: true, g: "accessible" }, at).visibility, "confirmed_removed");
    assert.equal(classify(a, { r: { state: "not_found" }, inGroup: true, g: "accessible" }, new Date(at.getTime() - HOUR)).visibility, "not_found");
    assert.equal(classify(a, { r: { state: "not_found" }, inGroup: false }, at).visibility, "unknown");
    assert.equal(classify(a, { r: { state: "not_found" }, inGroup: true, g: "session_failure" }, at).visibility, "session_failure");
    assert.equal(classify(a, { r: { state: "unknown", signal: "posting_disabled" } }, at), null, "the kill switch observes nothing");
    assert.equal(classify(a, { r: { state: "unknown", signal: "pending_approval" } }, at).visibility, "pending_approval");
    assert.equal(classify(a, { err: "x" }, at).visibility, "session_failure");
  }

  console.log("posting-recheck.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
