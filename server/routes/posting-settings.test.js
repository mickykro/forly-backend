/* routes/posting-settings.js — the structured permission, revocation before
   the response, what GET /settings shows (and hides), the resync's rate limit
   and error mapping, and forgetting a group. */
const assert = require("assert");
const R = require("./posting-routes-kit");
const { DriverError } = require("../driver-browser");

const { K, PH, G, setup, call, globalOff, globalOn, createRouter } = R;
const { db, store } = K;
const put = (app, b) => call(app, "PUT", "/api/posting/settings", b);
const enable = (b) => Object.assign({ enabled: true, consent: true, consent_version: createRouter.CONSENT_VERSION, default_group_ids: ["111"] }, b);

(async () => {
  // ── PUT: consent required; default groups must be member groups; the structured permission ──
  {
    const { app } = await setup({ noPermission: true });
    assert.equal((await put(app, { enabled: true, default_group_ids: ["111"] })).body.error, "consent_required");
    assert.equal((await put(app, enable({ auto_mode: "sometimes" }))).status, 400);
    assert.equal((await put(app, { consent: true })).status, 400, "enabled must be a boolean");
    const bad = await put(app, enable({ default_group_ids: ["111", "333", "555"] }));
    assert.equal(bad.status, 422); assert.equal(bad.body.error, "not_member"); assert.deepEqual(bad.body.group_ids, ["333", "555"]);
    const ok = await put(app, enable({ default_group_ids: ["111", "slug:haifa.homes"], auto_mode: "per_post", allows_visible_interactions: false, consent_version: createRouter.CONSENT_VERSION }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const perm = (await db.getConnection(PH)).posting_permission;
    assert.equal(perm.enabled, true); assert.equal(perm.consent_version, createRouter.CONSENT_VERSION); assert.ok(perm.granted_at);
    assert.deepEqual(perm.platforms, ["facebook"]); assert.deepEqual(perm.targets, ["groups"], "the Page is opt-in");
    assert.deepEqual(perm.default_group_ids, ["111", "777"], "stored by canonical id");
    assert.equal(perm.allows_dwell, true); assert.equal(perm.allows_visible_interactions, false); assert.equal(perm.auto_mode, "per_post");
    assert.equal(perm.page_id, null);
    assert.equal(ok.body.permission.consent_current, true);
    // Re-saving under the same consent keeps granted_at.
    const again = await put(app, enable({ default_group_ids: ["222"] }));
    assert.equal(again.status, 200);
    const perm2 = (await db.getConnection(PH)).posting_permission;
    assert.equal(perm2.granted_at, perm.granted_at); assert.deepEqual(perm2.default_group_ids, ["222"]); assert.equal(perm2.auto_mode, "per_post");
    assert.equal((await put(app, enable({ consent_version: "old" }))).body.error, "consent_outdated");
    const missing = await put(app, enable({ consent_version: undefined }));
    assert.equal(missing.status, 409); assert.equal(missing.body.error, "consent_outdated"); assert.equal(missing.body.consent_version, createRouter.CONSENT_VERSION);
  }

  // ── two Pages: a page target needs the confirmed Page; the card picks it by its handle ──
  {
    const pages = [{ url: "https://www.facebook.com/agentone", name: "One" }, { id: "12345", url: "https://www.facebook.com/agenttwo", name: "Two" }];
    const { app } = await setup({ conn: { facebook_pages: pages } });
    const r = await put(app, enable({ targets: ["page", "groups"] }));
    assert.equal(r.status, 409); assert.equal(r.body.error, "page_not_confirmed");
    assert.equal((await put(app, enable())).status, 200, "no targets asked → groups only");
    const s = await call(app, "GET", "/api/posting/settings");
    assert.equal(s.body.pages.length, 2); assert.equal(s.body.pages[1].id, "12345");
    assert.ok(/^u:[0-9a-f]{16}$/.test(s.body.pages[0].id)); assert.ok(!s.raw.includes("agentone"), "no Page URL in the response");
    assert.equal((await put(app, enable({ page_id: "nope" }))).body.error, "unknown_page");
    // I4: a Page is a target only with its numeric id, and the card says which ones are
    assert.equal(s.body.page_target_available, true);
    assert.deepEqual(s.body.pages.map((p) => p.available), [false, true]);
    const noId = await put(app, enable({ page_id: s.body.pages[0].id, targets: ["page", "groups"] }));
    assert.equal(noId.status, 409); assert.equal(noId.body.error, "page_target_unavailable");
    assert.equal((await put(app, enable({ page_id: s.body.pages[0].id, targets: ["groups"] }))).status, 200, "choosing it for later is fine");
    const ok = await put(app, enable({ page_id: s.body.pages[1].id, targets: ["page", "groups"] }));
    assert.equal(ok.status, 200); assert.equal(ok.body.permission.page_id, s.body.pages[1].id);
    assert.equal((await db.getConnection(PH)).posting_permission.page_id, "12345", "stored as posting-account.pageTarget() reads it");
    await db.setConnection(PH, { facebook_pages: [{ url: "https://www.facebook.com/agentone", name: "One" }] });
    assert.equal((await call(app, "GET", "/api/posting/settings")).body.page_target_available, false, "no numeric id: no Page option");
  }

  // ── enabled:false: works with posting switched off, and before the response
  //    running campaigns leave planning and pre-submit attempts are cancelled ──
  {
    const env = await setup();
    const C = require("../posting-campaign");
    const c = await C.create(K.base(), env.deps);
    const r1 = await store.reserveAttempt({ phone: PH, page_id: "pg1", campaign_id: c.id, target_type: "group", target_id: "111", publisher: "browser", limits: { daily_cap: 5, group_global_daily_cap: 5 }, now: K.NOW });
    await store.transition(r1.attempt.key, "session_started");
    const r2 = await store.reserveAttempt({ phone: PH, page_id: "pg2", target_type: "group", target_id: "222", publisher: "browser", limits: { daily_cap: 5, group_global_daily_cap: 5 }, now: K.NOW });
    await store.transition(r2.attempt.key, "session_started"); await store.transition(r2.attempt.key, "composer_ready"); await store.transition(r2.attempt.key, "submit_started");
    globalOff();
    const off = await put(env.app, { enabled: false });
    assert.equal(off.status, 200); assert.equal(off.body.permission.enabled, false);
    assert.equal((await store.getAttempt(r1.attempt.key)).state, "cancelled");
    assert.equal((await store.getAttempt(r2.attempt.key)).state, "submit_started", "past the Post click: left for reconciliation (R1)");
    const cc = await store.getPostingCampaign(c.id);
    assert.equal(cc.status, "paused"); assert.equal(cc.pause_reason, "permission");
    const perm = (await db.getConnection(PH)).posting_permission;
    assert.equal(perm.enabled, false); assert.ok(perm.revoked_at); assert.deepEqual(perm.default_group_ids, ["111", "222"], "the rest is kept");
    // Switching on while the fleet switch is off is refused; with it on, allowed.
    assert.equal((await put(env.app, enable())).body.reason, "global_off");
    globalOn();
    assert.equal((await put(env.app, enable())).status, 200);
  }

  // ── GET: member groups (hashed ones nameless, no URLs), suggestions, halt state, estimate ──
  {
    // db.js has no memory path for businesses: this one answers getBusiness.
    const bizDb = Object.assign(Object.create(db), { getBusiness: async (ph) => (ph === PH ? { activity_areas: ["חיפה"] } : null) });
    const env = await setup({ deps: { db: bizDb }, conn: { posting_penalty_until: K.iso(K.NOW.getTime() + 3 * K.DAY), facebook_needs_reconnect: true, facebook_needs_reconnect_at: K.iso(K.NOW) } });
    const s = await call(env.app, "GET", "/api/posting/settings?page_id=pg1");
    assert.equal(s.status, 200);
    const b = s.body;
    assert.equal(b.consent_version, createRouter.CONSENT_VERSION);
    assert.equal(b.member_groups.length, 4);
    assert.ok(!b.member_groups.some((g) => g.group_id === "999"), "a group that is not real estate (no such name, not in the catalog) is not shown");
    assert.ok(!s.raw.includes("abcd"), "no name hash");
    const g111 = b.member_groups.find((g) => g.group_id === "111");
    assert.equal(g111.name, "דירות בחיפה G111"); assert.equal(g111.agent_policy, "explicitly_allowed"); assert.equal(g111.is_default, true);
    assert.equal(b.member_groups.find((g) => g.group_id === "777").in_catalog, true, "found through its canonical URL");
    // Suggestions: in the agent's area (Haifa ≡ חיפה), not a member (777 is haifa.homes), by size.
    assert.deepEqual(b.suggested_groups.map((g) => g.group_id), ["333"]);
    assert.equal(b.suggested_groups[0].url, G(333));
    assert.equal(b.halt_state.needs_reconnect, true); assert.equal(b.halt_state.disabled_until_admin, false);
    assert.ok(b.halt_state.penalty_until); assert.equal(b.halt_state.owner_review_required, false);
    assert.equal(b.page_publisher, "browser"); assert.deepEqual(b.pages, []);
    assert.equal(b.permission.enabled, true); assert.deepEqual(b.permission.default_group_ids, ["111", "222"]);
    assert.ok("first_post_estimate" in b && "first_post_wait_reason" in b);
    const members = (await db.getConnection(PH)).facebook_groups_member.filter((m) => m.canonical_url);
    for (const m of members) assert.ok(!s.body.member_groups.some((g) => JSON.stringify(g).includes(m.canonical_url)), "no member group URL");
  }
  // ── GET: the halt classes behind the flags (Task 23's boxes), codes only ──
  {
    const H = K.NOW.getTime() - 3600e3;
    const env = await setup({ conn: {
      posting_disabled_until_admin: true, posting_disabled_class: "suspected_compromise",
      posting_penalty_until: K.iso(K.NOW.getTime() + 13 * K.DAY), posting_penalty_class: "rate_limited",
      posting_halts: [{ at: K.iso(H), code: "rate_limited" }, { at: K.iso(H), code: "suspected_compromise" }],
    } });
    const h = (await call(env.app, "GET", "/api/posting/settings")).body.halt_state;
    assert.equal(h.disabled_class, "suspected_compromise"); assert.equal(h.penalty_class, "rate_limited");
    assert.equal(h.penalty_blocks_posts, true, "day one of a penalty stops posts (posting-guard)"); assert.equal(h.posting_off, null);
    globalOff();
    assert.equal((await call(env.app, "GET", "/api/posting/settings")).body.halt_state.posting_off, "global_off");
    globalOn();
    // Day two: the penalty only slows; an unknown stored class is never echoed; no disable → no class.
    const env2 = await setup({ conn: {
      posting_disabled_until_admin: false, posting_disabled_class: "checkpoint",
      posting_penalty_until: K.iso(K.NOW.getTime() + 12 * K.DAY), posting_penalty_class: "Facebook said: slow down",
      posting_halts: [{ at: K.iso(K.NOW.getTime() - 2 * K.DAY), code: "feature_blocked" }],
    } });
    const h2 = (await call(env2.app, "GET", "/api/posting/settings")).body.halt_state;
    assert.equal(h2.disabled_class, null); assert.equal(h2.penalty_class, null); assert.equal(h2.penalty_blocks_posts, false);
  }
  {
    // A running campaign: the estimate is the planner's slot.
    const env = await setup();
    await require("../posting-campaign").create(K.base(), env.deps);
    const s = await call(env.app, "GET", "/api/posting/settings");
    assert.ok(s.body.first_post_estimate && new Date(s.body.first_post_estimate) >= K.NOW, JSON.stringify(s.body));
  }

  // ── resync: runs, then at most once per 10 minutes; busy/refused runs give the time back ──
  {
    let mode = "ok";
    const sync = { runSync: async ({ phone }) => {
      if (mode === "busy") throw Object.assign(new Error("x"), { code: "profile_busy" });
      if (mode === "driver") throw new DriverError(429, "local concurrency budget");
      if (mode === "boom") throw new Error("https://www.facebook.com/groups/secret");
      await db.setConnection(phone, { facebook_groups_synced_at: K.iso(K.NOW) });
      return 1;
    } };
    const env = await setup({ groupsSync: sync });
    const clk = env.clk;
    mode = "busy";
    const b1 = await call(env.app, "POST", "/api/posting/groups/resync");
    assert.equal(b1.status, 409); assert.equal(b1.body.error, "profile_busy");
    mode = "driver";
    const b2 = await call(env.app, "POST", "/api/posting/groups/resync");
    assert.equal(b2.status, 503); assert.equal(b2.body.error, "driver_busy");
    mode = "ok";
    const ok = await call(env.app, "POST", "/api/posting/groups/resync");
    assert.equal(ok.status, 200, "busy runs did not use up the 10 minutes"); assert.equal(ok.body.member_groups.length, 4, "the one that is not real estate is not shown");
    const soon = await call(env.app, "POST", "/api/posting/groups/resync");
    assert.equal(soon.status, 429); assert.equal(soon.body.error, "too_soon"); assert.ok(soon.body.retry_after_s > 0);
    clk.t = new Date(K.NOW.getTime() + 11 * K.MIN);
    mode = "boom";
    const errs = []; const orig = console.error; console.error = (m) => errs.push(String(m));
    const bad = await call(env.app, "POST", "/api/posting/groups/resync");
    console.error = orig;
    assert.equal(bad.status, 503); assert.equal(bad.body.error, "sync_failed");
    assert.ok(errs.length && errs.every((m) => !m.includes("facebook.com")), "no URL in the log line");
    assert.equal((await call(env.app, "POST", "/api/posting/groups/resync")).status, 429, "a sync that ran keeps the stamp");
    // On a local box the limit is off: the owner re-reads groups while testing.
    const local = R.makeApp({ deps: Object.assign({}, env.deps, { env: Object.assign({}, env.deps.env, { FORLY_ENV: "local", POSTING_SWEEPER: "1" }) }) });
    assert.notEqual((await call(local, "POST", "/api/posting/groups/resync")).body.error, "too_soon", "FORLY_ENV=local resyncs at once");
    clk.t = new Date(K.NOW.getTime() + 30 * K.MIN);
    globalOff();
    const off = await call(env.app, "POST", "/api/posting/groups/resync");
    assert.equal(off.status, 409); assert.equal(off.body.reason, "global_off");
    globalOn();
    mode = "ok";
    assert.equal((await call(env.app, "POST", "/api/posting/groups/resync")).status, 200, "a refused call did not stamp");
    const nc = await setup({ conn: { facebook_browser_connected_at: null } });
    assert.equal((await call(nc.app, "POST", "/api/posting/groups/resync")).body.error, "facebook_not_connected");
  }

  // ── DELETE a group: gone from the members and from the defaults, aliases included ──
  {
    const env = await setup({ conn: { posting_permission: Object.assign({}, K.PERM, { default_group_ids: ["111", "777"] }) } });
    globalOff(); // a privacy removal is never blocked by a switch
    const r = await call(env.app, "DELETE", "/api/posting/groups/slug:haifa.homes");
    assert.equal(r.status, 200); assert.equal(r.body.removed, true);
    globalOn();
    const conn = await db.getConnection(PH);
    assert.ok(!conn.facebook_groups_member.some((m) => m.group_id === "777"));
    assert.equal(conn.facebook_groups_member.length, 4);
    assert.deepEqual(conn.posting_permission.default_group_ids, ["111"]);
    assert.equal(conn.posting_permission.enabled, true, "the rest of the permission is untouched");
    assert.equal((await call(env.app, "DELETE", "/api/posting/groups/777")).status, 404);
    assert.equal((await call(env.app, "DELETE", "/api/posting/groups/a%2Fb")).status, 400);
    // A campaign that still lists the group no longer plans it.
    const C = require("../posting-campaign");
    const c = await C.create(K.base({ groups: [{ url: G(111), name: "A" }] }), env.deps);
    await call(env.app, "DELETE", "/api/posting/groups/111");
    const A = require("../posting-account");
    const cat = await A.catalogIndex(db);
    const e = A.eligibility(c.groups[0], { conn: await db.getConnection(PH), catalog: cat, listingType: "sale", now: K.NOW });
    assert.equal(e.is_member, false);
  }

  // ── a deleted group stays deleted: a sync that still sees it on Facebook
  //    (the route's resync, or the weekly sweep's runSync) does not bring it back ──
  {
    const sync = require("../facebook-groups-sync");
    const scrape = [["111", "דירות להשכרה"], ["222", "נדלן קריות"], ["haifa.homes", "דירות בחיפה"], ["999", "משהו"]]
      .map(([slug, text]) => ({ href: `https://www.facebook.com/groups/${slug}/?ref=x`, text }));
    const page = { evaluate: async () => ({ regions: [[], []], count: 0 }), url: () => "https://www.facebook.com/groups/joins/", goto: async () => {}, waitForLoadState: async () => {}, waitForTimeout: async () => {}, mouse: { wheel: async () => {} }, $$eval: async () => scrape };
    const env = await setup({ groupsSync: sync, deps: { withPage: async (opts, fn) => fn(page) } });
    const del = await call(env.app, "DELETE", "/api/posting/groups/777");
    assert.equal(del.status, 200); assert.deepEqual(del.body.hidden_group_ids, ["777"]);
    const hidden = (await db.getConnection(PH)).facebook_groups_hidden;
    assert.deepEqual(hidden[0].ids.sort(), ["777", "slug:haifa.homes"]);
    assert.ok(!JSON.stringify(hidden).includes("בחיפה"), "ids only, never a name");
    const rs = await call(env.app, "POST", "/api/posting/groups/resync");
    assert.equal(rs.status, 200, JSON.stringify(rs.body));
    assert.ok(!rs.body.member_groups.some((g) => g.group_id === "777" || g.group_id === "slug:haifa.homes"), "not re-added by the resync");
    const stored = (await db.getConnection(PH)).facebook_groups_member;
    assert.ok(!stored.some((m) => m.group_id === "slug:haifa.homes" || m.group_id === "777"));
    assert.ok(stored.some((m) => m.group_id === "111"), "the others were synced");
    // The weekly sweep's sync (same runSync, its own deps) does not re-add it either.
    await sync.runSync({ phone: PH }, { db, env: env.deps.env, withPage: async (o, fn) => fn(page), lockHeld: true });
    const s1 = await call(env.app, "GET", "/api/posting/settings");
    assert.ok(!s1.body.member_groups.some((g) => g.group_id === "777" || g.group_id === "slug:haifa.homes"));
    assert.deepEqual(s1.body.hidden_group_ids, ["777"]);
    // The member gate ignores it even if a stale write put it back in the list.
    await db.setConnection(PH, { facebook_groups_member: stored.concat([K.member("777", { aliases: ["slug:haifa.homes"] })]) });
    const cr = await call(env.app, "POST", "/api/posting/campaigns", R.consented({ group_ids: ["111", "slug:haifa.homes"] }));
    assert.equal(cr.status, 422); assert.deepEqual(cr.body.group_ids, ["slug:haifa.homes"]);
    assert.equal((await put(env.app, enable({ default_group_ids: ["777"] }))).status, 422);
    assert.ok(!(await call(env.app, "GET", "/api/posting/settings")).body.member_groups.some((g) => g.group_id === "777"));
    // Unhide: only on the agent's explicit choice; the next sync brings it back.
    await db.setConnection(PH, { facebook_groups_member: stored });
    assert.equal((await call(env.app, "POST", "/api/posting/groups/nope/unhide")).status, 400);
    assert.equal((await call(env.app, "POST", "/api/posting/groups/111/unhide")).status, 404);
    const un = await call(env.app, "POST", "/api/posting/groups/slug:haifa.homes/unhide");
    assert.equal(un.status, 200); assert.deepEqual(un.body.hidden_group_ids, []);
    env.clk.t = new Date(K.NOW.getTime() + 11 * K.MIN);
    const back = await call(env.app, "POST", "/api/posting/groups/resync");
    assert.ok(back.body.member_groups.some((g) => g.group_id === "slug:haifa.homes"), "back after an explicit unhide");
    // Suggestions skip a hidden catalog group.
    const bizDb = Object.assign(Object.create(db), { getBusiness: async () => ({ activity_areas: ["חיפה"] }) });
    const env2 = await setup({ deps: { db: bizDb }, conn: { facebook_groups_hidden: [{ ids: ["333"], hidden_at: K.iso(K.NOW) }] } });
    assert.ok(!(await call(env2.app, "GET", "/api/posting/settings")).body.suggested_groups.some((g) => g.group_id === "333"));
    // mergeMembership itself: a hidden id is neither observed nor carried.
    const merged = sync.mergeMembership([K.member("5"), K.member("6")], [{ slug: "5", url: G(5), name: "x" }, { slug: "7", url: G(7), name: "y" }], { hidden: new Set(["5", "6", "7"]), catalog: [] });
    assert.deepEqual(merged, []);
  }

  // ── routes/distribution.js mergedCatalog, lifted to module scope ──
  {
    K.reset();
    const { mergedCatalog } = require("./distribution");
    db.mem.groupCatalog.push({ url: "https://www.facebook.com/groups/88888/?ref=x", name: "חדש", city: "חיפה", listing_types: ["rent"] });
    const all = await mergedCatalog(db, "sale");
    const added = all.find((g) => g.url === G(88888));
    assert.ok(added); assert.equal(added.match, false); assert.equal(added.agent_policy, "unknown");
    assert.ok(all.length > 1);
  }

  console.log("routes/posting-settings.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
