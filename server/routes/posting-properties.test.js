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
  console.log("routes/posting-properties.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
