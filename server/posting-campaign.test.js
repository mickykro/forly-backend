/* posting-campaign.js — create, enroll, the planner, approval, stop. No
   browser: the driver is a fake that walks the attempt's states. Every time
   derives from NOW (posting-testkit.js). */
const assert = require("assert");
const K = require("./posting-testkit");
const C = require("./posting-campaign");
const S = require("./posting-sweeper");

const { db, store, NOW, MIN, HOUR, DAY, iso, cfg, G, PERM, member, page, base, dueOf, setup } = K;
const PH = "972500000001";

(async () => {
  // ── create: running at once (consent is the approval), idempotent, nothing scheduled yet ──
  {
    const { deps } = await setup();
    const c = await C.create(base(), deps);
    assert.equal(c.status, "running");
    assert.equal(c.id, store.campaignId(PH, "pg1"));
    assert.equal(c.posts.length, 0);
    assert.ok(c.consent_at && c.expires_at);
    assert.deepEqual(c.groups.map((g) => g.group_id), ["111", "222"]);
    assert.ok(c.groups.every((g) => g.is_member && g.catalog_policy && g.listing_type_allowed && g.posting_currently_available));
    assert.deepEqual(c.targets, ["groups"], "no Page known → groups only");
    await C.pause(c.id, "agent", deps);
    const again = await C.create(base({ mode: "per_post" }), deps);
    assert.equal(again.status, "paused", "a retried create returns the existing campaign untouched");
    assert.equal(again.mode, "standing");
    assert.equal((await store.listPostingCampaignsByPhone(PH)).length, 1);
    await assert.rejects(C.create(base({ consent: null }), deps), (e) => e.code === "consent_required");
  }

  // ── the first tick schedules one post: copy built NOW from the page, no link in the body ──
  {
    const { deps, at } = await setup();
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(NOW));
    assert.equal(c.posts.length, 1);
    const p = c.posts[0];
    assert.equal(p.status, "scheduled");
    assert.equal(p.group_id, "111");
    assert.ok(p.copy.includes("חיפה"));
    assert.ok(!/https?:\/\//.test(p.copy), "no link in the body");
    assert.ok(/^[0-9a-f]{32}$/.test(p.copy_hash));
    assert.equal(p.group_token, undefined, "no s=/g= token on campaign posts (R4)");

    // ── due: it posts; the copy is replaced by its hash; the attempt carries a click id (R4) ──
    c = await S.tick(c, deps, at(dueOf(c)));
    assert.equal(c.posts[0].status, "posted");
    assert.equal(c.posts[0].post_url, `${G(111)}/posts/999`);
    assert.equal(c.posts[0].copy, undefined);
    assert.ok(c.posts[0].copy_hash);
    const a = await store.getAttempt(c.posts[0].attempt_key);
    assert.equal(a.state, "verified_posted");
    assert.equal(a.publisher, "browser");
    assert.ok(/^[0-9a-f]{32}$/.test(a.click_id));
    assert.equal(new Date(a.click_expires_at) - new Date(a.click_issued_at), 30 * DAY);
    assert.equal(deps.post.calls[0].comment, `https://f.ly/p/pg1?c=${a.click_id}`, "the link carries only ?c=");
    assert.equal(deps.post.calls[0].groupUrl, G(111));
    const ga = (await store.getGroupActivityFor(["111"], NOW))["111"];
    assert.equal(ga.posts_today, 1, "the reservation bumped the cross-account bucket");
    assert.equal(ga.fingerprints[0].weak, K.safety.fingerprint(page().property).weak);

    // ── same day: one a day (cap 1) → nothing new; the price changes; tomorrow's copy reflects it ──
    c = await S.tick(c, deps, at(new Date(dueOf(c).getTime() + MIN)));
    assert.equal(c.posts.length, 1);
    assert.equal(c.wait_reason, "daily_cap");
    await db.updatePage("pg1", { "property.price": 1900000 });
    c = await S.tick(c, deps, at(new Date(NOW.getTime() + DAY)));
    assert.equal(c.posts.length, 2);
    assert.ok(c.posts[1].copy.includes("1,900,000"));
    assert.equal(c.posts[1].group_url, G(222));
    assert.ok(new Date(c.posts[1].scheduled_at) - new Date(c.posts[0].posted_at) >= cfg.min_gap_minutes * MIN);

    // ── one pass over the groups completes a non-repeating campaign ──
    c = await S.tick(c, deps, at(dueOf(c, 1)));
    assert.equal(c.posts[1].status, "posted");
    c = await S.tick(c, deps, at(new Date(dueOf(c, 1).getTime() + MIN)));
    assert.equal(c.status, "completed", "every group posted once; repeat=false");
  }

  // ── restart (controller ruling 4): create on a completed/stopped campaign
  //    reactivates it with the new terms; history stays; only future posts ──
  {
    const { deps, at } = await setup();
    let c = await C.create(base(), deps);
    for (let d = 0; d < 2; d++) {
      c = await S.tick(c, deps, at(new Date(NOW.getTime() + d * DAY)));
      c = await S.tick(c, deps, at(dueOf(c, d)));
    }
    c = await S.tick(c, deps, at(new Date(dueOf(c, 1).getTime() + MIN)));
    assert.equal(c.status, "completed");
    at(new Date(NOW.getTime() + 3 * DAY));
    const r = await C.create(base({ mode: "per_post", days: 30, consent: { at: iso(NOW.getTime() + 3 * DAY), version: "2026-10-01" }, groups: [{ url: G(222) }] }), deps);
    assert.equal(r.id, c.id);
    assert.equal(r.status, "running");
    assert.equal(r.mode, "per_post");
    assert.equal(r.consent_version, "2026-10-01");
    assert.equal(r.pause_reason, null);
    assert.deepEqual(r.groups.map((g) => g.group_id), ["222"]);
    assert.equal(r.expires_at, iso(NOW.getTime() + 33 * DAY));
    assert.equal(r.posts.length, 2, "the posted history is kept");
    assert.ok(r.posts.every((p) => p.status === "posted"));
    // the group was posted 2 days ago: the property→group cooldown holds the next post back
    let t = await S.tick(r, deps, at(new Date(NOW.getTime() + 3 * DAY)));
    assert.equal(t.posts.length, 2);
    assert.equal(t.wait_reason, "no_eligible_group");
    t = await S.tick(t, deps, at(new Date(NOW.getTime() + 16 * DAY)));
    assert.equal(t.posts.length, 3, "after the cooldown, a new post for the new pass");
    assert.equal(t.posts[2].group_id, "222");
    assert.equal(t.posts[2].status, "pending_approval", "per the new mode");
    // running (and paused) campaigns are returned unchanged: still idempotent
    assert.equal((await C.create(base({ mode: "standing" }), deps)).mode, "per_post");
    // a stopped campaign restarts too
    await C.stop(c.id, deps);
    assert.equal((await C.create(base(), deps)).status, "running");
  }

  // ── enrollment never restarts a campaign the agent (or anyone) stopped (fix round 1) ──
  {
    const { deps } = await setup();
    const c = await C.enrollNewPage(page(), deps);
    assert.equal(c.status, "running");
    const s1 = await C.stop(c.id, deps);
    assert.equal(s1.pause_reason, "agent");
    const again = await C.enrollNewPage(page(), deps); // pages.js: re-created page, or an extension
    assert.equal(again.status, "stopped", "the agent's STOP stands");
    assert.equal(again.restarted_at, undefined);
    for (const reason of ["permission", "account", "internal"]) {
      await store.updatePostingCampaign(c.id, { status: "stopped", pause_reason: reason });
      assert.equal((await C.enrollNewPage(page(), deps)).status, "stopped", `${reason}: not restarted by enrollment`);
    }
    await store.updatePostingCampaign(c.id, { status: "completed", pause_reason: null });
    assert.equal((await C.enrollNewPage(page(), deps)).status, "completed", "a finished pass is not restarted by enrollment");
    // it may reactivate one that ended by itself
    for (const reason of ["page_gone", "expired"]) {
      await store.updatePostingCampaign(c.id, { status: reason === "expired" ? "completed" : "stopped", pause_reason: reason });
      const r = await C.enrollNewPage(page(), deps);
      assert.equal(r.status, "running", `${reason}: reactivated`);
      assert.equal(r.pause_reason, null);
    }
    // a direct create (Task 19's route: the agent asks) still restarts an agent-stopped campaign
    await C.stop(c.id, deps);
    assert.equal((await C.create(base(), deps)).status, "running");
  }

  // ── the page is archived mid-campaign: stop, say why, skip what was open ──
  {
    const { deps, at, notes } = await setup();
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(NOW));
    await db.updatePage("pg1", { status: "archived" });
    c = await S.tick(c, deps, at(dueOf(c)));
    assert.equal(c.status, "stopped");
    assert.equal(c.pause_reason, "page_gone");
    assert.equal(c.posts[0].status, "skipped");
    assert.equal(deps.post.calls.length, 0);
    assert.ok(notes.some((m) => m.includes("נעצר")));
  }

  // ── per_post: waits for approval; approval at night re-times the post to the morning ──
  {
    const { deps, at, notes } = await setup();
    let c = await C.create(base({ mode: "per_post" }), deps);
    c = await S.tick(c, deps, at(NOW));
    assert.equal(c.posts[0].status, "pending_approval");
    assert.equal(notes.length, 1, "the agent is shown the exact copy");
    assert.ok(notes[0].includes(c.posts[0].copy.slice(0, 20)));
    c = await S.tick(c, deps, at(new Date(NOW.getTime() + HOUR)));
    assert.equal(c.posts[0].status, "pending_approval", "unapproved: still waiting, nothing reserved");
    assert.equal(deps.post.calls.length, 0);
    const night = new Date("2026-09-23T23:40:00+03:00");
    c = await C.approvePost(c.id, c.posts[0].id, Object.assign({}, deps, { now: night }));
    assert.equal(c.posts[0].status, "scheduled");
    assert.ok(new Date(c.posts[0].scheduled_at) > night);
    assert.equal(K.safety.jerusalemDate(c.posts[0].scheduled_at), "2026-09-24", "approved at night → posts the next day");
    assert.ok(K.safety.isActiveTime(new Date(c.posts[0].scheduled_at), cfg));
    // the page changed after approval: the post goes back for approval instead of posting stale text
    await db.updatePage("pg1", { "property.price": 1700000 });
    c = await S.tick(c, deps, at(dueOf(c)));
    assert.equal(c.posts[0].status, "pending_approval");
    assert.ok(c.posts[0].copy.includes("1,700,000"));
    assert.equal(deps.post.calls.length, 0);
    c = await C.skipPost(c.id, c.posts[0].id, deps);
    assert.equal(c.posts[0].status, "skipped");
    assert.equal(c.posts[0].error_code, "agent");
  }

  // ── stop cancels what is scheduled; a later tick posts nothing; stop(id, { db }) works too ──
  {
    const { deps, at } = await setup();
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(NOW));
    const s = await C.stop(c.id, { db });
    assert.equal(s.status, "stopped");
    assert.equal(s.posts[0].status, "skipped");
    await S.tick(s, deps, at(new Date(NOW.getTime() + DAY)));
    assert.equal(deps.post.calls.length, 0);
    // routes/connections-browser.js lists campaigns through db.js
    assert.equal((await db.listPostingCampaignsByPhone(PH)).length, 1);
  }

  // ── two campaigns on one account: the second paces against the first's reservation ──
  {
    // This phone's day plan allows 3 posts on 2026-09-23 (daily_cap 3, planSeed per phone).
    const P2 = "972500000002";
    const { deps, at } = await setup(P2, { config: Object.assign({}, cfg, { daily_cap: 3 }) });
    await db.savePage(page("pg1", P2));
    await db.savePage(page("pg2", P2));
    const a = await C.create(base({ phone: P2, page: page("pg1", P2) }), deps);
    const b = await C.create(base({ phone: P2, page: page("pg2", P2) }), deps);
    const early = new Date("2026-09-23T07:00:00+03:00"); // before the day's window: nothing is due yet
    await S.tick(a, deps, at(early));
    await S.tick(a, deps, at(new Date(early.getTime() + MIN)));
    const [ca, cb] = [await store.getPostingCampaign(a.id), await store.getPostingCampaign(b.id)];
    assert.equal(ca.posts.length + cb.posts.length, 2, "one post planned per tick, one per campaign");
    const gap = Math.abs(new Date(cb.posts[0].scheduled_at) - new Date(ca.posts[0].scheduled_at)) / MIN;
    assert.ok(gap >= cfg.min_gap_minutes, `two campaigns scheduled ${gap} min apart`);
    assert.notEqual(ca.posts[0].group_id, cb.posts[0].group_id, "and never into the same group");
  }

  // ── auto-enroll: default groups ∩ member groups; idempotent under a retried activation ──
  {
    const { deps } = await setup(PH, { conn: { posting_permission: Object.assign({}, PERM, { default_group_ids: ["111", "notmember", "222"] }), facebook_groups_member: [member("111"), member("222", { membership_state: "left" })] } });
    const pg = page("pgNew");
    const c = await C.enrollNewPage(pg, deps);
    assert.ok(c && c.status === "running");
    assert.deepEqual(c.groups.map((g) => g.url), [G(111)], "default groups ∩ member groups (not left)");
    assert.deepEqual(c.targets, ["groups"]);
    const again = await C.enrollNewPage(pg, deps);
    assert.equal(again.id, c.id);
    assert.equal((await store.listPostingCampaignsByPhone(PH)).length, 1, "a retried activation makes no second campaign");
    // an imported Yad2 listing the agent did not turn into a page never enrolls; one they did, does
    await db.saveListing({ listing_id: "L1", business_phone: PH, source: "yad2", listing_draft_id: null });
    assert.equal(await C.enrollNewPage(page("pgImp", PH, { listing_id: "L1" }), deps), null);
    await db.saveListing({ listing_id: "L2", business_phone: PH, source: "yad2", listing_draft_id: "d1" });
    assert.ok(await C.enrollNewPage(page("pgMine", PH, { listing_id: "L2" }), deps));
    // no permission → nothing
    await db.setConnection(PH, { posting_permission: { enabled: false } });
    assert.equal(await C.enrollNewPage(page("pgNew2"), deps), null);
    // a failure never throws: it is stored on the page
    await db.setConnection(PH, { posting_permission: PERM });
    await db.savePage(page("pgBad"));
    const broken = Object.assign({}, deps, { store: Object.assign({}, store, { createPostingCampaignIfAbsent: async () => { throw Object.assign(new Error("x"), { code: "unavailable" }); } }) });
    assert.equal(await C.enrollNewPage(page("pgBad"), broken), null);
    assert.equal((await db.getPage("pgBad")).posting_enroll_error.code, "unavailable");
  }

  // ── the account planner: a price drop outranks a fresh listing, which outranks an old one ──
  {
    const { deps } = await setup();
    const mk = (id, o) => Object.assign(page(id), o);
    await db.savePage(mk("old", {}));
    await db.savePage(mk("new", { created_at: new Date(NOW.getTime() - DAY) }));
    await db.savePage(mk("drop", { property: Object.assign({}, page().property, { price: 1800000, price_history: [{ price: 2000000, at: iso(NOW.getTime() - 3 * DAY) }] }) }));
    for (const id of ["old", "new", "drop"]) await C.create(base({ page: await db.getPage(id) }), deps);
    const pick = await C.planAccount(PH, deps, NOW);
    assert.equal((await store.getPostingCampaign(pick.campaignId)).page_id, "drop");
    assert.ok(pick.at instanceof Date && pick.group_id);
    await C.stop(pick.campaignId, deps);
    assert.equal((await store.getPostingCampaign((await C.planAccount(PH, deps, NOW)).campaignId)).page_id, "new");
  }

  // ── page target: the Page is opt-in and needs the agent's explicit choice,
  //    even when only one was discovered ──
  {
    const onePage = { facebook_pages: [{ id: "61550000000001", url: "https://www.facebook.com/dana.nadlan", name: "Dana" }], page_publisher: "browser" };
    {
      const { deps } = await setup(PH, { conn: onePage });
      const c0 = await C.create(base({ targets: ["page", "groups"] }), deps);
      assert.deepEqual(c0.targets, ["groups"], "one discovered Page, no explicit choice → no Page target");
    }
    const { deps, at } = await setup(PH, { conn: Object.assign({}, onePage, { posting_permission: Object.assign(structuredClone(PERM), { page_id: "61550000000001" }) }) });
    let c = await C.create(base({ targets: ["page", "groups"] }), deps);
    assert.deepEqual(c.targets, ["page", "groups"]);
    c = await S.tick(c, deps, at(NOW));
    assert.equal(c.posts[0].target, "page");
    assert.equal(c.posts[0].group_url, "https://www.facebook.com/dana.nadlan");
    c = await S.tick(c, deps, at(dueOf(c)));
    assert.equal(deps.post.calls[0].pageUrl, "https://www.facebook.com/dana.nadlan");
    const a = await store.getAttempt(c.posts[0].attempt_key);
    assert.equal(a.target_type, "page");
    assert.equal(a.publisher, "browser", "R6: the publisher is bound at reservation");
    await db.setConnection(PH, { page_publisher: "graph" });
    await db.savePage(page("pg2"));
    assert.deepEqual((await C.create(base({ page: page("pg2") }), deps)).targets, ["groups"], "graph keeps the Page out of the browser pipeline");
    // two Pages and none confirmed → no Page target (R3)
    await db.setConnection(PH, { page_publisher: "browser", facebook_pages: [{ url: "https://www.facebook.com/a1" }, { url: "https://www.facebook.com/b2" }] });
    await db.savePage(page("pg3"));
    assert.deepEqual((await C.create(base({ page: page("pg3") }), deps)).targets, ["groups"]);
    // I4: a Page whose numeric id connect could not read is never a target (R3 could not prove it)
    await db.setConnection(PH, { facebook_pages: [{ url: "https://www.facebook.com/dana.nadlan", name: "Dana" }] });
    await db.savePage(page("pg4"));
    assert.deepEqual((await C.create(base({ page: page("pg4") }), deps)).targets, ["groups"]);
    assert.equal(require("./posting-account").pageTarget(await db.getConnection(PH)), null);
  }

  // ── an ineligible group (any of the four booleans false) is never planned ──
  {
    const { deps, at } = await setup(PH, { conn: {
      facebook_groups_member: ["111", "444", "555", "666"].map((id) => member(id)),
      posting_group_penalties: { 666: { code: "confirmed_removed", at: iso(NOW), until: iso(NOW.getTime() + 20 * DAY) } },
    } });
    await db.addGroupCatalogEntry({ url: G(444), active: false });
    await db.addGroupCatalogEntry({ url: G(555), listing_types: ["rent"] });
    let c = await C.create(base({ groups: ["333", "444", "555", "666", "111"].map((id) => ({ url: G(id) })) }), deps);
    const flags = Object.fromEntries(c.groups.map((g) => [g.group_id, [g.is_member, g.catalog_policy, g.listing_type_allowed, g.posting_currently_available]]));
    assert.deepEqual(flags, { 333: [false, true, true, true], 444: [true, false, true, true], 555: [true, true, false, true], 666: [true, true, true, false], 111: [true, true, true, true] });
    for (let d = 0; d < 4; d++) {
      c = await S.tick(c, deps, at(new Date(NOW.getTime() + d * DAY)));
      if (c.posts.some((p) => p.status === "scheduled")) c = await S.tick(c, deps, at(dueOf(c, c.posts.length - 1)));
    }
    assert.deepEqual(c.posts.map((p) => p.group_id), ["111"]);
    assert.equal(c.wait_reason, "no_eligible_group");
    assert.equal(c.status, "running", "666's penalty is temporary: the campaign waits");
  }

  // ── pause / resume; revoking the permission cancels open attempts and pauses campaigns ──
  {
    const { deps, at } = await setup();
    let c = await C.create(base(), deps);
    c = await C.pause(c.id, "agent", deps);
    assert.equal(c.status, "paused");
    c = await C.resume(c.id, deps);
    assert.equal(c.status, "running");
    c = await S.tick(c, deps, at(NOW));
    const r = await store.reserveAttempt({ phone: PH, page_id: "pgX", target_type: "group", target_id: "999", publisher: "browser", limits: { daily_cap: 5, group_global_daily_cap: 5 }, now: NOW });
    const out = await C.revokePermission(PH, deps);
    assert.deepEqual(out, { cancelled: 1, paused: 1 });
    assert.equal((await store.getAttempt(r.attempt.key)).state, "cancelled");
    assert.equal((await store.getPostingCampaign(c.id)).pause_reason, "permission");
  }

  // ── the driver's first-hand findings reach the connection and the campaign (Task 18) ──
  const walk = (end, detail, extra) => { const fn = async (args, d) => {
    fn.calls.push(args);
    const k = args.attempt.key;
    await d.attempts.transition(k, "session_started");
    if (end === "verified_posted") for (const s of ["composer_ready", "submit_started", "verification_pending"]) await d.attempts.transition(k, s);
    await d.attempts.transition(k, end, detail);
    return Object.assign({ state: end }, detail.error_code ? { error_code: detail.error_code } : {}, extra);
  }; fn.calls = []; return fn; };
  {
    // "Join group" was showing: the entry is `left`, the campaign group off, the planner moves on
    const { deps, at } = await setup(PH, { post: walk("verified_failed", { error_code: "not_member" }, { membership: "left" }) });
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(NOW));
    c = await S.tick(c, deps, at(dueOf(c)));
    const m = (await db.getConnection(PH)).facebook_groups_member;
    assert.equal(m.find((e) => e.group_id === "111").membership_state, "left");
    assert.equal(m.find((e) => e.group_id === "222").membership_state, "member");
    assert.equal(c.groups.find((g) => g.group_id === "111").is_member, false);
    assert.equal(c.groups.find((g) => g.group_id === "222").is_member, true);
    c = await S.tick(c, deps, at(new Date(NOW.getTime() + DAY)));
    assert.equal(c.posts[c.posts.length - 1].group_id, "222", "the left group is never chosen again");
  }
  {
    // a vanity slug resolved to its numeric id: the connection and the campaign both follow
    const slugUrl = G("haifa.rent");
    const { deps, at } = await setup(PH, {
      post: walk("verified_posted", { post_url: `${slugUrl}/posts/1` }, { resolved_group_id: "12345" }),
      conn: { facebook_groups_member: [member("slug:haifa.rent", { canonical_url: slugUrl, slug: "haifa.rent", id_verified: false })] },
    });
    let c = await C.create(base({ groups: [{ url: slugUrl, agent_policy: "explicitly_allowed" }] }), deps);
    assert.equal(c.groups[0].group_id, "slug:haifa.rent");
    c = await S.tick(c, deps, at(NOW));
    c = await S.tick(c, deps, at(dueOf(c)));
    assert.equal(c.posts[0].status, "posted");
    const m = (await db.getConnection(PH)).facebook_groups_member;
    assert.deepEqual(m.map((e) => [e.group_id, e.id_verified]), [["12345", true]]);
    assert.equal(c.groups[0].group_id, "12345");
    assert.equal(c.posts[0].group_id, "12345");
  }
  {
    // a failed connection write never escapes the tick, and its log line is redacted
    const lines = [];
    const orig = console.error;
    console.error = (...a) => lines.push(a.join(" "));
    try {
      const { deps, at } = await setup(PH, { post: walk("verified_failed", { error_code: "not_member" }, { membership: "left" }) });
      deps.store = Object.assign({}, store, { mutateConnection: async () => { throw Object.assign(new Error("down"), { code: "unavailable" }); } });
      let c = await C.create(base(), deps);
      c = await S.tick(c, deps, at(NOW));
      c = await S.tick(c, deps, at(dueOf(c)));
      assert.equal(c.posts[0].status, "failed");
      assert.equal(c.groups.find((g) => g.group_id === "111").is_member, false, "the campaign half still applied");
      assert.equal((await db.getConnection(PH)).facebook_groups_member.find((e) => e.group_id === "111").membership_state, "member");
    } finally { console.error = orig; }
    assert.ok(lines.some((l) => /membership update .*unavailable/.test(l)));
    assert.ok(!lines.join("\n").includes(PH), "no full phone in the log");
  }

  console.log("posting-campaign.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
