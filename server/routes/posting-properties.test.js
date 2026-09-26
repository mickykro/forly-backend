/* The publishing page's server half: which member groups suit a property
   (posting-account.fitsProperty), enrollment narrowed to them, and
   GET /api/posting/properties. */
const assert = require("assert");
const R = require("./posting-routes-kit");
const A = require("../posting-account");
const { mentionsCity } = require("../distribution/city-normalize");
const C = require("../posting-campaign");

const { K, PH, OTHER, G, setup, call } = R;
const { db, store } = K;

(async () => {
  // ── a group's name naming the city, in any spelling ──
  assert.equal(mentionsCity("דירות להשכרה בהוד השרון כפ״ס ורעננה", "הוד השרון"), true);
  assert.equal(mentionsCity("Apartments Tel Aviv", "תל אביב - יפו"), true);
  assert.equal(mentionsCity("דירות בחיפה", "תל אביב"), false);
  assert.equal(mentionsCity("דירות בכל הארץ", "כל הארץ"), false, "nationwide is not a city a name names");

  // ── fitsProperty: area (catalog city or name), and the kind of deal ──
  const sale = { city: "הוד השרון", listing_type: "sale" }, rent = { city: "הוד השרון", listing_type: "rent" };
  const m = (name) => ({ group_id: "1", name });
  assert.equal(A.fitsProperty(m("דירות להשכרה בהוד השרון"), [], rent), true);
  assert.equal(A.fitsProperty(m("דירות להשכרה בהוד השרון"), [], sale), false, "a rentals group never gets a sale");
  assert.equal(A.fitsProperty(m("דירות למכירה והשכרה בהוד השרון"), [], sale), true, "a group for both takes both");
  assert.equal(A.fitsProperty(m("דירות למכירה בהוד השרון"), [], rent), false);
  assert.equal(A.fitsProperty(m("דירות בכפר סבא"), [], sale), false, "another city");
  assert.equal(A.fitsProperty(m(undefined), [{ city: "Hod Hasharon" }], sale), false, "an unknown spelling does not match");
  assert.equal(A.fitsProperty(m(undefined), [{ city: "הוד השרון" }], sale), true, "a private group the catalog places in the city");
  assert.equal(A.fitsProperty(m(undefined), [{ city: "כל הארץ" }], sale), true, "a nationwide catalog group");
  assert.equal(A.fitsProperty(m("הוד השרון"), [{ city: "הוד השרון", listing_types: ["rent"] }], sale), false, "the catalog excludes sales");
  assert.equal(A.fitsProperty(m("הוד השרון"), [], { listing_type: "sale" }), false, "no city, no pick");

  // ── enrollment posts a new property only where it suits: the pool narrowed by city ──
  {
    const TLV = K.member("444", { name: "דירות בתל אביב" });
    const { deps } = await setup({ conn: { facebook_groups_member: R.members().concat([TLV]) } });
    await db.setConnection(PH, { posting_permission: Object.assign({}, (await db.getConnection(PH)).posting_permission, { default_group_ids: ["111", "444"] }) });
    const c = await C.enrollNewPage(K.page("pgE", PH), deps);
    assert.deepEqual(c.groups.map((g) => g.group_id), ["111"], "the Tel Aviv group is left out of a Haifa property");
    const tlvPage = K.page("pgT", PH, { property: { title: "t", city: "תל אביב", listing_type: "sale", price: 1, rooms: 3 } });
    assert.deepEqual((await C.enrollNewPage(tlvPage, deps)).groups.map((g) => g.group_id), ["444"]);
    const nowhere = K.page("pgN", PH, { property: { title: "n", city: "אילת", listing_type: "sale", price: 1, rooms: 3 } });
    assert.equal(await C.enrollNewPage(nowhere, deps), null, "no group suits it: not enrolled");
  }

  // ── GET /properties: this agent's active properties, their campaign, the groups that suit each ──
  {
    const { app } = await setup();
    const L = (id, page_id, o = {}) => Object.assign({ listing_id: id, business_phone: PH, page_id, city: "חיפה", rooms: 4, status: "active", photos_urls: ["https://img/x.jpg"] }, o);
    await db.saveListing(L("l2", "pg2"));
    await db.savePage(K.page("pgA", PH, { status: "archived" }));
    await db.saveListing(L("lA", "pgA"));
    await db.saveListing(L("lG", null)); // still building: no page yet
    await db.saveListing(L("lX", "pgX", { business_phone: OTHER }));
    await db.saveListing(L("lZ", "pg2", { status: "archived", listing_id: "lZ" }));
    await store.createPostingCampaignIfAbsent({ phone: PH, page_id: "pg2", status: "running", groups: [], posts: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() });

    const r = await call(app, "GET", "/api/posting/properties");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.max_active, 3);
    assert.deepEqual(r.body.properties.map((p) => p.page_id), ["pg2"], "active, this agent's, with a page, not archived");
    const p = r.body.properties[0];
    assert.equal(p.city, "חיפה"); assert.equal(p.listing_type, "sale"); assert.equal(p.thumb_url, "https://img/x.jpg");
    assert.equal(p.campaign.status, "running");
    // 111 (named Haifa, catalog Haifa), 777 (catalog Haifa), 222 (named Haifa by the kit, catalog Krayot) — never 555 (left) or 999 (no name, not in the catalog).
    assert.deepEqual(p.fit_group_ids.slice().sort(), ["111", "222", "777"]);
    assert.ok(!JSON.stringify(r.body).includes(G(111)), "no group URL leaves");
  }
  // ── a group that says "no agents" in its own name is barred everywhere ──
  {
    for (const n of ["דירות 🏢 בשושו רעננה כפר סבא - אין כניסה ⛔ למתווכים!!!", "דירות להשכרה ללא מתווכים", "בלי תיווך - חיפה", "ללא עמלת תיווך", "TLV rentals - no agents"]) assert.equal(A.nameBarsAgents(n), true, n);
    for (const n of ["מתווכים משתפי פעולה \\ תיווך נדל\"ן", "קהילת מתווכי הנדל\"ן, מתווכים עם דרך ארץ", "עולם הנדל\"ן - קבלנים, מתווכים", "דירות להשכרה בכפר סבא"]) assert.equal(A.nameBarsAgents(n), false, n);
    const barred = K.member("888", { name: "דירות בחיפה - אין כניסה למתווכים" });
    assert.equal(A.fitsProperty(barred, [], { city: "חיפה", listing_type: "sale" }), false, "never auto-picked");
    assert.equal(A.eligibility({ group_id: "888", url: G(888), name: barred.name, agent_policy: "unknown" }, { conn: { facebook_groups_member: [barred] }, catalog: [], listingType: "sale", now: new Date() }).catalog_policy, false, "never planned");
    const S_ = require("./posting-shared");
    assert.equal(S_.publicMember(barred, null, new Set()).agent_policy, "no_agents", "shown as barring agents");
    const { app } = await setup({ conn: { facebook_groups_member: R.members().concat([barred]) } });
    const r = await call(app, "POST", "/api/posting/campaigns", R.consented({ group_ids: ["111", "888"], include_unknown: true }));
    assert.equal(r.status, 422); assert.equal(r.body.error, "group_disallowed"); assert.deepEqual(r.body.group_ids, ["888"]);
  }

  // ── Facebook's /groups/<menu> links are never member groups ──
  {
    const S_ = require("./posting-shared");
    const conn = { facebook_groups_member: ["feed", "discover", "joins"].map((s) => K.member(`slug:${s}`, { slug: s })).concat([K.member("111")]) };
    assert.deepEqual(S_.memberList(conn).map((m) => m.group_id), ["111"]);
    const FG = require("../facebook-groups-sync");
    const merged = FG.mergeMembership(conn.facebook_groups_member, [{ url: G(222), slug: "222", name: "x" }], { now: new Date() });
    assert.ok(!merged.some((m) => ["feed", "discover", "joins"].includes(m.slug)), "dropped from storage on the next merge");
  }
  console.log("routes/posting-properties.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
