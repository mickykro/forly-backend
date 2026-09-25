/* posting-account.eligibility — the catalog is matched by every id and alias
   of a group, then by URL, so a group the catalog lists under its numeric URL
   (or its vanity URL) cannot slip past a disallowed policy or a listing-type
   restriction; and a group the agent removed (facebook_groups_hidden) is never
   a member. Exercised through create(), enrollNewPage(), planAccount() and the
   tick — the planner never chooses such a group. */
const assert = require("assert");
const K = require("./posting-testkit");
const A = require("./posting-account");
const C = require("./posting-campaign");
const S = require("./posting-sweeper");

const { db, store, NOW, DAY, iso, G, PERM, member, page, base, setup } = K;
const PH = "972500000001";
// The Task 18 case: a vanity slug resolved to 777; the old id stays an alias.
const vanity = () => member("777", { slug: "haifa.homes", canonical_url: G("haifa.homes"), aliases: ["slug:haifa.homes"] });
const conn = (o = {}) => Object.assign({ facebook_groups_member: [member("111"), vanity()] }, o);
const catalogEntry = (url, o) => db.addGroupCatalogEntry(Object.assign({ url, name: "x", city: "חיפה", active: true }, o));

(async () => {
  // ── the catalog lists the NUMERIC url; the campaign's group carries the VANITY url ──
  {
    const { deps } = await setup(PH, { conn: conn() });
    await catalogEntry(G(777), { agent_policy: "no_agents", listing_types: ["rent"] });
    const c = await C.create(base({ groups: [{ group_id: "777", url: G("haifa.homes"), name: "V" }] }), deps);
    const g = c.groups[0];
    assert.equal(g.url, G("haifa.homes"));
    assert.equal(g.catalog_policy, false, "no_agents found through the numeric id");
    assert.equal(g.listing_type_allowed, false, "rent-only found through the numeric id (a sale page)");
    assert.equal(g.agent_policy, "no_agents", "the catalog's policy is recorded");
    assert.equal(await C.planAccount(PH, deps).then((p) => p && p.group_id), undefined, "never planned");
    const ticked = await S.tick(c, deps, NOW);
    assert.equal((ticked.posts || []).length, 0, "the tick schedules nothing");
  }

  // ── the reverse split: the catalog lists the VANITY url, the group the numeric one ──
  {
    const { deps } = await setup(PH, { conn: conn() });
    await catalogEntry(G("haifa.homes"), { agent_policy: "explicitly_allowed", listing_types: ["rent"] });
    const c = await C.create(base({ groups: [{ group_id: "777", url: G(777) }, { group_id: "111", url: G(111) }] }), deps);
    assert.equal(c.groups[0].listing_type_allowed, false, "found through the slug alias");
    assert.equal(c.groups[0].catalog_policy, true);
    const plan = await C.planAccount(PH, deps);
    assert.equal(plan.group_id, "111");
    // A rent page may use it.
    const e = A.eligibility(c.groups[0], { conn: await db.getConnection(PH), catalog: await A.catalogIndex(db), listingType: "rent", now: NOW });
    assert.equal(e.listing_type_allowed, true);
  }

  // ── an operator-disabled entry (active:false) under the other URL also keeps it off ──
  {
    const { deps } = await setup(PH, { conn: conn() });
    await catalogEntry(G(777), { agent_policy: "explicitly_allowed", active: false });
    const c = await C.create(base({ groups: [{ group_id: "777", url: G("haifa.homes") }] }), deps);
    assert.equal(c.groups[0].catalog_policy, false);
  }

  // ── enrollNewPage builds groups from the default ids: the same lookup applies ──
  {
    const { deps } = await setup(PH, { conn: conn({ posting_permission: Object.assign({}, PERM, { default_group_ids: ["777"], targets: ["groups"] }) }) });
    await catalogEntry(G(777), { agent_policy: "no_agents" });
    const p = page("pg7", PH, { created_at: new Date(NOW.getTime() - DAY) });
    await db.savePage(p);
    const c = await C.enrollNewPage(p, deps);
    assert.ok(c, "enrolled");
    assert.equal(c.groups[0].group_id, "777"); assert.equal(c.groups[0].catalog_policy, false);
    assert.equal(await C.planAccount(PH, deps).then((x) => x && x.group_id), undefined, "never planned");
  }

  // ── a hidden group is not a member: never planned, and a post already scheduled there is skipped ──
  {
    const { deps, at } = await setup(PH, { conn: conn() });
    let c = await C.create(base({ groups: [{ group_id: "111", url: G(111) }, { group_id: "777", url: G("haifa.homes") }] }), deps);
    c = await S.tick(c, deps, at(NOW));
    assert.equal(c.posts[0].group_id, "111", "planned while visible");
    // Hidden by its alias; the member list still (stale write) lists it.
    await store.mutateConnection(PH, () => ({ facebook_groups_hidden: [{ ids: ["111"], hidden_at: iso(NOW) }] }));
    const cn = await db.getConnection(PH);
    assert.equal(A.eligibility(c.groups[0], { conn: cn, catalog: await A.catalogIndex(db), listingType: "sale", now: NOW }).is_member, false);
    assert.equal(A.isHidden(cn, { group_id: "777" }), false);
    c = await S.tick(c, deps, at(new Date(c.posts[0].scheduled_at).getTime() + 1000));
    assert.equal(c.posts[0].status, "skipped", "the scheduled post to the hidden group is not run");
    assert.equal(deps.post.calls.length, 0, "the driver never opened it");
    assert.equal(c.groups.find((g) => g.group_id === "111").is_member, false);
    // Hiding by an alias works too.
    await store.mutateConnection(PH, () => ({ facebook_groups_hidden: [{ ids: ["slug:haifa.homes"], hidden_at: iso(NOW) }] }));
    assert.equal(A.isHidden(await db.getConnection(PH), { group_id: "777" }), true);
    const plan = await C.planAccount(PH, deps, new Date(NOW.getTime() + 2 * DAY));
    assert.ok(!plan || plan.group_id !== "777", "a hidden alias is never planned");
  }

  console.log("posting-eligibility.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
