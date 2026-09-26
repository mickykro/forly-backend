/* routes/posting.js — campaigns: consent and the permission it records, the
   member gate (aliases included), the catalog opt-in, ownership, the kill
   switch (stop/pause/skip always work), resume after a login halt, Page
   confirmation, and that no browser secret or store internal is ever
   returned. Settings/groups: posting-settings.test.js; one-tap links:
   posting-act.test.js. */
const assert = require("assert");
const R = require("./posting-routes-kit");

const { K, PH, OTHER, G, setup, call, consented, globalOff, globalOn, pendingCampaign, createRouter } = R;
const { db, store } = K;

(async () => {
  // ── consent is required; invalid input is refused before anything is read ──
  {
    const { app } = await setup();
    const no = await call(app, "POST", "/api/posting/campaigns", { page_id: "pg1", group_ids: ["111"], mode: "standing" });
    assert.equal(no.status, 400); assert.equal(no.body.error, "consent_required");
    for (const bad of [{ mode: "fast" }, { group_ids: "111" }, { group_ids: ["https://www.facebook.com/groups/111"] }, { page_id: "a/b" }, { days: 90 }, { group_ids: Array.from({ length: 21 }, (_, i) => String(i + 1)) }]) {
      const r = await call(app, "POST", "/api/posting/campaigns", consented(bad));
      assert.equal(r.status, 400, JSON.stringify(bad)); assert.equal(r.body.error, "invalid_input");
    }
    const stale = await call(app, "POST", "/api/posting/campaigns", consented({ consent_version: "2020-01-v0" }));
    assert.equal(stale.status, 409); assert.equal(stale.body.consent_version, createRouter.CONSENT_VERSION);
    const missing = await call(app, "POST", "/api/posting/campaigns", consented({ consent_version: undefined }));
    assert.equal(missing.status, 409); assert.equal(missing.body.error, "consent_outdated"); assert.equal(missing.body.consent_version, createRouter.CONSENT_VERSION);
  }

  // ── the member gate: ids the account is not a member of (or left) → 422 with those ids ──
  {
    const { app } = await setup();
    const r = await call(app, "POST", "/api/posting/campaigns", consented({ group_ids: ["111", "333", "555"] }));
    assert.equal(r.status, 422); assert.equal(r.body.error, "not_member");
    assert.deepEqual(r.body.group_ids, ["333", "555"]);
    assert.equal((await store.listPostingCampaignsByPhone(PH)).length, 0);
  }

  // ── a member group outside the catalog needs include_unknown: true ──
  {
    const { app } = await setup();
    const r = await call(app, "POST", "/api/posting/campaigns", consented({ group_ids: ["111", "999"] }));
    assert.equal(r.status, 422); assert.equal(r.body.error, "unknown_group"); assert.deepEqual(r.body.group_ids, ["999"]);
    const ok = await call(app, "POST", "/api/posting/campaigns", consented({ group_ids: ["111", "999"], include_unknown: true }));
    assert.equal(ok.status, 201);
    const g999 = ok.body.campaign.groups.find((g) => g.group_id === "999");
    assert.equal(g999.agent_policy, "unknown"); assert.equal(g999.name, "קבוצה פרטית"); assert.equal(g999.private, true);
  }

  // ── create: 201, groups by canonical id (an old slug id finds its resolved entry),
  //    the eligibility booleans, the consent version, and the account's answers ──
  {
    const { app } = await setup({ noPermission: true });
    const r = await call(app, "POST", "/api/posting/campaigns", consented({ group_ids: ["111", "slug:haifa.homes", "777"], days: 7, account_aged: false, posted_manually: true }));
    assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.existing, false);
    const c = r.body.campaign;
    assert.deepEqual(c.groups.map((g) => g.group_id), ["111", "777"], "the slug alias and its numeric id are one group");
    for (const g of c.groups) for (const k of ["is_member", "catalog_policy", "listing_type_allowed", "posting_currently_available"]) assert.equal(g[k], true, k);
    assert.equal(c.groups[0].agent_policy, "explicitly_allowed");
    assert.equal(c.consent_version, createRouter.CONSENT_VERSION);
    assert.equal(c.status, "running");
    const stored = await store.getPostingCampaign(c.id);
    assert.equal(stored.groups[1].url, G("haifa.homes"));
    // The campaign's own consent created the permission the guard's "reserve" needs
    // — groups-only and without default groups, so new listings are not auto-enrolled.
    const conn = await db.getConnection(PH);
    const perm = conn.posting_permission;
    assert.equal(perm.enabled, true); assert.deepEqual(perm.platforms, ["facebook"]);
    assert.equal(perm.consent_version, createRouter.CONSENT_VERSION); assert.ok(perm.granted_at);
    assert.deepEqual(perm.default_group_ids, []); assert.deepEqual(perm.targets, ["groups"]); assert.equal(perm.allows_dwell, true);
    assert.equal(conn.posting_account_aged, false); assert.equal(conn.posting_posted_manually, true);
    // No URL of a member group, no store internals in the response.
    assert.ok(!r.raw.includes("facebook.com/groups"), "no member group URL in the response");
    // A retried create returns the same campaign, 200.
    const again = await call(app, "POST", "/api/posting/campaigns", consented({ group_ids: ["111"] }));
    assert.equal(again.status, 200); assert.equal(again.body.existing, true); assert.equal(again.body.campaign.id, c.id);
    assert.equal(again.body.campaign.groups.length, 2, "unchanged");
    // An existing permission in force is left as it was.
    const before = JSON.stringify((await db.getConnection(PH)).posting_permission);
    await call(app, "POST", "/api/posting/campaigns", consented({ page_id: "pg2" }));
    assert.equal(JSON.stringify((await db.getConnection(PH)).posting_permission), before);
  }

  // ── the catalog refuses at creation, matched by id and alias (the real mergedCatalog):
  //    a no_agents group, and a rent-only group for a sale page, even when the catalog
  //    lists the numeric URL and the member entry carries the vanity one ──
  {
    const env = await setup();
    const app = R.makeApp({ deps: env.deps, catalog: (w) => require("./distribution").mergedCatalog(db, w) });
    await db.addGroupCatalogEntry({ url: G(777), name: "rent only", city: "חיפה", agent_policy: "no_agents", listing_types: ["rent"], active: true });
    await db.addGroupCatalogEntry({ url: G(111), name: "rent", city: "חיפה", agent_policy: "explicitly_allowed", listing_types: ["rent"], active: true });
    await db.addGroupCatalogEntry({ url: G(222), name: "no agents", city: "חיפה", agent_policy: "no_agents", listing_types: [], active: true });
    for (const id of ["777", "slug:haifa.homes"]) {
      const r = await call(app, "POST", "/api/posting/campaigns", consented({ group_ids: [id], targets: ["groups"] }));
      assert.equal(r.status, 422, id); assert.equal(r.body.error, "group_disallowed"); assert.deepEqual(r.body.group_ids, ["777"]);
    }
    const dis = await call(app, "POST", "/api/posting/campaigns", consented({ group_ids: ["222"] }));
    assert.equal(dis.status, 422); assert.equal(dis.body.error, "group_disallowed"); assert.deepEqual(dis.body.group_ids, ["222"]);
    const rent = await call(app, "POST", "/api/posting/campaigns", consented({ group_ids: ["111"] }));
    assert.equal(rent.status, 422); assert.equal(rent.body.error, "listing_type_not_allowed"); assert.deepEqual(rent.body.group_ids, ["111"]);
    assert.equal((await store.listPostingCampaignsByPhone(PH)).length, 0, "nothing created");
    await db.savePage(K.page("pgR", PH, { property: { title: "t", city: "חיפה", listing_type: "rent" } }));
    assert.equal((await call(app, "POST", "/api/posting/campaigns", consented({ page_id: "pgR", group_ids: ["111"] }))).status, 201, "a rent page may use it");
  }

  // ── gates: not connected, someone else's page, too many campaigns ──
  {
    const { app } = await setup({ conn: { facebook_browser_connected_at: null } });
    assert.equal((await call(app, "POST", "/api/posting/campaigns", consented())).body.error, "facebook_not_connected");
  }
  {
    const { app } = await setup();
    const r = await call(app, "POST", "/api/posting/campaigns", consented({ page_id: "pgX" }));
    assert.equal(r.status, 404);
    for (let i = 3; i <= 5; i++) {
      await db.savePage(K.page(`pg${i}`, PH));
      assert.equal((await call(app, "POST", "/api/posting/campaigns", consented({ page_id: `pg${i}` }))).status, 201);
    }
    const busy = await call(app, "POST", "/api/posting/campaigns", consented({ page_id: "pg2" }));
    assert.equal(busy.status, 409); assert.equal(busy.body.error, "too_many_campaigns");
    assert.equal((await call(app, "POST", "/api/posting/campaigns", consented({ page_id: "pg3" }))).status, 200, "its own page's campaign does not count against it");
  }

  // ── two Pages and a page target: the agent must confirm one first (R3) ──
  {
    const pages = [{ url: "https://www.facebook.com/agentone", name: "One" }, { url: "https://www.facebook.com/agenttwo", name: "Two" }];
    const { app } = await setup({ conn: { facebook_pages: pages } });
    const r = await call(app, "POST", "/api/posting/campaigns", consented({ targets: ["page", "groups"] }));
    assert.equal(r.status, 409); assert.equal(r.body.error, "page_not_confirmed");
    const dflt = await call(app, "POST", "/api/posting/campaigns", consented());
    assert.equal(dflt.status, 201, "no targets asked → groups only, the Page is opt-in");
    assert.deepEqual(dflt.body.campaign.targets, ["groups"]);
    await db.setConnection(PH, { posting_permission: { page_id: pages[1].url } });
    // I4: without the Page's numeric id the page target is refused
    const noId = await call(app, "POST", "/api/posting/campaigns", consented({ page_id: "pg2", targets: ["page", "groups"] }));
    assert.equal(noId.status, 409); assert.equal(noId.body.error, "page_target_unavailable");
    await db.setConnection(PH, { facebook_pages: [pages[0], Object.assign({ id: "61550000000002" }, pages[1])] });
    const ok = await call(app, "POST", "/api/posting/campaigns", consented({ page_id: "pg2", targets: ["page", "groups"] }));
    assert.equal(ok.status, 201); assert.deepEqual(ok.body.campaign.targets, ["page", "groups"]);
  }

  // ── R5: an internal pause is the team's to lift — the agent's resume is refused ──
  {
    const env = await setup();
    const c = await pendingCampaign(env);
    await store.mutatePostingCampaign(c.id, () => ({ status: "paused", pause_reason: "internal" }));
    const r = await call(env.app, "POST", `/api/posting/campaigns/${c.id}/resume`);
    assert.equal(r.status, 409); assert.equal(r.body.error, "needs_developer");
    assert.equal((await store.getPostingCampaign(c.id)).status, "paused");
  }

  // ── the kill switch: create/resume/approve refused; stop, pause and skip always work ──
  {
    const env = await setup();
    const { app } = env;
    const c = await pendingCampaign(env);
    globalOff();
    const cr = await call(app, "POST", "/api/posting/campaigns", consented({ page_id: "pg2" }));
    assert.equal(cr.status, 409); assert.equal(cr.body.error, "posting_disabled"); assert.equal(cr.body.reason, "global_off");
    const ap = await call(app, "POST", `/api/posting/campaigns/${c.id}/posts/p1/approve`);
    assert.equal(ap.status, 409); assert.equal(ap.body.reason, "global_off");
    assert.equal((await store.getPostingCampaign(c.id)).posts[0].status, "pending_approval");
    const sk = await call(app, "POST", `/api/posting/campaigns/${c.id}/posts/p1/skip`);
    assert.equal(sk.status, 200); assert.equal(sk.body.campaign.posts[0].status, "skipped");
    const pa = await call(app, "POST", `/api/posting/campaigns/${c.id}/pause`);
    assert.equal(pa.status, 200); assert.equal(pa.body.campaign.status, "paused"); assert.equal(pa.body.campaign.pause_reason, "agent");
    const re = await call(app, "POST", `/api/posting/campaigns/${c.id}/resume`);
    assert.equal(re.status, 409); assert.equal(re.body.reason, "global_off");
    const st = await call(app, "POST", `/api/posting/campaigns/${c.id}/stop`);
    assert.equal(st.status, 200); assert.equal(st.body.campaign.status, "stopped");
    globalOn();
    // Restart: a stopped campaign is reactivated by create with the new consent.
    const again = await call(app, "POST", "/api/posting/campaigns", consented());
    assert.equal(again.status, 201); assert.equal(again.body.campaign.status, "running"); assert.ok(again.body.campaign.restarted_at);
  }

  // ── approve with posting on; unknown post → 404; resume refused while a reconnect is due ──
  {
    const env = await setup();
    const c = await pendingCampaign(env);
    assert.equal((await call(env.app, "POST", `/api/posting/campaigns/${c.id}/posts/nope/approve`)).status, 404);
    const ap = await call(env.app, "POST", `/api/posting/campaigns/${c.id}/posts/p1/approve`);
    assert.equal(ap.status, 200); assert.equal(ap.body.campaign.posts[0].status, "scheduled");
    assert.equal(ap.body.campaign.posts[0].copy, undefined, "copy is shown only while pending");
    await call(env.app, "POST", `/api/posting/campaigns/${c.id}/pause`);
    await db.setConnection(PH, { facebook_needs_reconnect: true, facebook_needs_reconnect_at: K.iso(K.NOW.getTime() + K.HOUR) });
    const re = await call(env.app, "POST", `/api/posting/campaigns/${c.id}/resume`);
    assert.equal(re.status, 409); assert.equal(re.body.error, "needs_reconnect");
    await db.setConnection(PH, { facebook_browser_connected_at: K.iso(K.NOW.getTime() + 2 * K.HOUR) });
    const ok = await call(env.app, "POST", `/api/posting/campaigns/${c.id}/resume`);
    assert.equal(ok.status, 200); assert.equal(ok.body.campaign.status, "running");
    await call(env.app, "POST", `/api/posting/campaigns/${c.id}/stop`);
    const st = await call(env.app, "POST", `/api/posting/campaigns/${c.id}/resume`);
    assert.equal(st.status, 409); assert.equal(st.body.error, "not_paused");
  }

  // ── another phone's campaign reads as missing, for every route ──
  {
    const env = await setup();
    const c = await pendingCampaign(env);
    const other = env.as(OTHER);
    for (const [m, p] of [["GET", ""], ["POST", "/stop"], ["POST", "/pause"], ["POST", "/resume"], ["POST", "/posts/p1/approve"], ["POST", "/posts/p1/skip"]]) {
      assert.equal((await call(other, m, `/api/posting/campaigns/${c.id}${p}`)).status, 404, p);
    }
    assert.equal((await store.getPostingCampaign(c.id)).status, "running");
    assert.deepEqual((await call(other, "GET", "/api/posting/campaigns")).body.campaigns, []);
    const mine = await call(env.app, "GET", "/api/posting/campaigns?page_id=pg1");
    assert.equal(mine.body.campaigns.length, 1);
    assert.equal((await call(env.app, "GET", "/api/posting/campaigns?page_id=pg2")).body.campaigns.length, 0);
  }

  // ── publicView: no browser secret, no store internals, post_url only when posted ──
  {
    const env = await setup();
    const c = await pendingCampaign(env, { copy: "טקסט" });
    await store.mutatePostingCampaign(c.id, (cur) => ({
      page_snapshot: { cdpUrl: "wss://x" }, view_url: "https://viewer.driver.dev?ws=wss://x", cdpUrl: "wss://x",
      posts: cur.posts.concat([
        { id: "p2", status: "posted", group_id: "111", group_name: "דירות בחיפה", post_url: "https://www.facebook.com/groups/111/posts/5", copy_hash: "h", attempt_key: "k".repeat(32), click_id: "c".repeat(32) },
        { id: "p3", status: "failed", group_id: "999", post_url: "https://www.facebook.com/groups/999/posts/6", error_code: "wss://leak" },
      ]),
    }));
    const r = await call(env.app, "GET", `/api/posting/campaigns/${c.id}`);
    assert.equal(r.status, 200);
    for (const s of ["wss://", "viewer.driver.dev", "copy_hash", "attempt_key", "click_id", "page_snapshot", "cdpUrl", "k".repeat(32)]) assert.ok(!r.raw.includes(s), s);
    const [p1, p2, p3] = r.body.campaign.posts;
    assert.equal(p1.copy, "טקסט"); assert.equal(p2.post_url, "https://www.facebook.com/groups/111/posts/5");
    assert.equal(p3.post_url, undefined); assert.equal(p3.group_name, "קבוצה פרטית"); assert.equal(p3.error_code, null);
    const v = createRouter.publicView({ id: "x", posts: [{ id: "a", status: "posted", post_url: "wss://evil" }], groups: [{ group_id: "1", url: "https://www.facebook.com/groups/1" }] });
    assert.ok(!JSON.stringify(v).includes("wss://") && !JSON.stringify(v).includes("facebook.com/groups/1"));
    assert.equal(createRouter.publicView(null), null);
  }

  // ── C1: outside prod (without POSTING_SWEEPER=1, never on staging) every mutation is 503; reads stay ──
  {
    const env = await setup();
    const c = await pendingCampaign(env);
    const before = JSON.stringify(await store.getPostingCampaign(c.id));
    const perm = JSON.stringify((await db.getConnection(PH)).posting_permission);
    for (const e of [{ FORLY_ENV: "staging", POSTING_ENABLED: "1", POSTING_SWEEPER: "1" }, { FORLY_ENV: "local", POSTING_ENABLED: "1" }]) {
      const app = R.makeApp({ deps: Object.assign({}, env.deps, { env: e }) });
      const writes = [
        ["POST", "/api/posting/campaigns", consented()], ["POST", `/api/posting/campaigns/${c.id}/pause`], ["POST", `/api/posting/campaigns/${c.id}/stop`],
        ["POST", `/api/posting/campaigns/${c.id}/resume`], ["POST", `/api/posting/campaigns/${c.id}/posts/p1/approve`], ["POST", `/api/posting/campaigns/${c.id}/posts/p1/skip`],
        ["PUT", "/api/posting/settings", { enabled: false }], ["POST", "/api/posting/groups/resync"], ["DELETE", "/api/posting/groups/111"],
        ["POST", "/api/posting/groups/111/unhide"], ["POST", "/api/posting/act?c=x"],
      ];
      for (const [m, path, body] of writes) {
        const r = await call(app, m, path, body);
        assert.deepEqual([r.status, r.body], [503, { error: "posting_unavailable_in_env" }], `${e.FORLY_ENV} ${m} ${path}`);
      }
      assert.equal((await call(app, "GET", `/api/posting/campaigns/${c.id}`)).status, 200);
      assert.equal((await call(app, "GET", "/api/posting/settings")).status, 200);
    }
    assert.equal(JSON.stringify(await store.getPostingCampaign(c.id)), before, "nothing changed");
    assert.equal(JSON.stringify((await db.getConnection(PH)).posting_permission), perm);
    const local = R.makeApp({ deps: Object.assign({}, env.deps, { env: { FORLY_ENV: "local", POSTING_ENABLED: "1", POSTING_SWEEPER: "1" } }) });
    assert.equal((await call(local, "POST", `/api/posting/campaigns/${c.id}/pause`)).status, 200, "a local box with POSTING_SWEEPER=1 may");
  }

  // ── a started campaign is planned at once: the card shows its post or why it waits ──
  {
    const env = await setup({ planNow: null }); // the real plan-only tick
    const r = await call(env.app, "POST", "/api/posting/campaigns", consented());
    assert.equal(r.status, 201);
    const c = r.body.campaign;
    assert.ok(c.posts.length === 1 || c.wait_reason, "a post or a reason: " + JSON.stringify(c));
    if (c.posts.length) assert.ok(["scheduled", "pending_approval"].includes(c.posts[0].status), "planned, never run: " + c.posts[0].status);
  }
  {
    let calls = 0;
    const env = await setup({ planNow: async () => { calls++; return "profile_busy"; } });
    const r = await call(env.app, "POST", "/api/posting/campaigns", consented());
    assert.equal(r.body.campaign.wait_reason, "profile_busy", "the card says the profile is busy");
    const id = r.body.campaign.id;
    await call(env.app, "GET", `/api/posting/campaigns/${id}`);
    await call(env.app, "GET", `/api/posting/campaigns/${id}`);
    assert.equal(calls, 1, "the start planned; the polling GET plans at most once a minute");
    env.clk.t = new Date(env.clk.t.getTime() + 61000);
    await call(env.app, "GET", `/api/posting/campaigns/${id}`);
    assert.equal(calls, 2, "and again after a minute: a busy reason never blocks the next try");
    const off = R.makeApp({ deps: Object.assign({}, env.deps, { env: { FORLY_ENV: "staging" } }), planNow: async () => { calls++; return "profile_busy"; } });
    env.clk.t = new Date(env.clk.t.getTime() + 61000);
    await call(off, "GET", `/api/posting/campaigns/${id}`);
    assert.equal(calls, 2, "never where posting is not allowed");
  }

  console.log("routes/posting.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
