/* posting-listing-groups.js: groups chosen while the page builds, applied
   when it exists, held until the agent approves each group's text. */
const assert = require("assert");
const K = require("./posting-testkit");
const C = require("./posting-campaign");
const LG = require("./posting-listing-groups");
const PH = "972500000001";

const listing = (id, o = {}) => Object.assign({ listing_id: id, business_phone: PH, city: "חיפה", listing_type: "sale", page_id: null, created_at: K.NOW.toISOString() }, o);
const withDefaults = (ids) => ({ posting_permission: Object.assign({}, K.PERM, { default_group_ids: ids }) });

(async () => {
  // ── not connected: nothing to choose ──
  {
    const { deps } = await K.setup(PH, { conn: { facebook_browser_connected_at: null } });
    await K.db.saveListing(listing("L0"));
    assert.deepEqual(LG.offerOf((await K.db.getConnection(PH)) || {}), { connected: false, defaults: 0 });
    assert.equal((await LG.choose({ listing: await K.db.getListing("L0"), phone: PH, choice: ["111"] }, deps)).error, "facebook_not_connected");
  }

  // ── choosing before the page exists: stored on the listing only ──
  {
    const { deps } = await K.setup(PH, { conn: withDefaults(["111"]) });
    await K.db.saveListing(listing("L1"));
    assert.deepEqual(LG.offerOf((await K.db.getConnection(PH)) || {}), { connected: true, defaults: 1 });
    assert.equal((await LG.choose({ listing: await K.db.getListing("L1"), phone: "972500000099", choice: ["111"] }, deps)).error, "not_found", "another agent's listing");
    assert.equal((await LG.choose({ listing: await K.db.getListing("L1"), phone: PH, choice: ["999"] }, deps)).error, "invalid_groups", "a group the agent is not in");
    assert.equal((await LG.choose({ listing: await K.db.getListing("L1"), phone: PH, choice: [] }, deps)).error, "invalid_groups");
    const out = await LG.choose({ listing: await K.db.getListing("L1"), phone: PH, choice: ["111", "222"], consentVersion: "v" }, deps);
    assert.deepEqual(out, { ok: true, choice: ["111", "222"] });
    const l = await K.db.getListing("L1");
    assert.deepEqual(l.posting_groups, ["111", "222"]);
    assert.equal(l.posting_consent.version, "v");
    assert.equal(await LG.review(l, deps), null, "no page yet: nothing to review");

    // ── the page is built: a campaign on exactly those groups, held for the texts ──
    await K.db.setListingPageId("L1", "pg1");
    const c = await LG.apply(K.page("pg1", PH), await K.db.getListing("L1"), deps);
    assert.deepEqual(c.groups.map((g) => g.group_id), ["111", "222"]);
    assert.equal(c.awaiting_texts, true);
    assert.equal(await C.planAccount(PH, deps), null, "the planner leaves it alone until the texts are approved");

    const r = await LG.review(await K.db.getListing("L1"), deps);
    assert.equal(r.awaiting, true);
    assert.equal(r.groups.length, 2);
    assert.ok(r.groups.every((g) => g.copy.length > 0), "a built text per group to edit");

    const done = await LG.approveTexts(await K.db.getListing("L1"), { 111: "  הטקסט שלי לקבוצה A  " }, deps);
    assert.equal(done.awaiting_texts, false);
    assert.equal(done.groups.find((g) => g.group_id === "111").copy, "הטקסט שלי לקבוצה A");
    assert.equal(done.groups.find((g) => g.group_id === "222").copy, undefined, "an untouched group keeps the built text");
    assert.equal((await LG.review(await K.db.getListing("L1"), deps)).awaiting, false);
  }

  // ── "default": the account's default groups, no text review ──
  {
    const { deps } = await K.setup(PH, { conn: withDefaults(["111"]) });
    await K.db.saveListing(listing("L2", { page_id: "pg1" }));
    const out = await LG.choose({ listing: await K.db.getListing("L2"), phone: PH, choice: LG.DEFAULT }, deps);
    assert.equal(out.choice, "default");
    const c = await K.store.getPostingCampaign(K.store.campaignId(PH, "pg1"));
    assert.ok(c, "chosen after the page exists: applied at once");
    assert.deepEqual(c.groups.map((g) => g.group_id), ["111"]);
    assert.ok(!c.awaiting_texts, "default groups go without a text review");
  }
  {
    const { deps } = await K.setup(PH, { conn: withDefaults([]) });
    await K.db.saveListing(listing("L3"));
    assert.equal((await LG.choose({ listing: await K.db.getListing("L3"), phone: PH, choice: LG.DEFAULT }, deps)).error, "no_defaults");
  }

  // ── "ברירת מחדל" after the chat draft is gone: the newest listing of the day with no campaign ──
  {
    const { deps } = await K.setup(PH, { conn: withDefaults(["111"]) });
    await K.db.saveListing(listing("Lold", { created_at: new Date(K.NOW.getTime() - 3 * K.DAY).toISOString() }));
    await K.db.saveListing(listing("Lnew", { created_at: new Date(K.NOW.getTime() - K.HOUR).toISOString() }));
    assert.equal((await LG.latestUnchosen(PH, deps)).listing_id, "Lnew");
    await K.db.updateListing("Lnew", { posting_groups: "default" });
    assert.equal(await LG.latestUnchosen(PH, deps), null, "a chosen one and a stale one are left alone");
  }

  // ── the WhatsApp link: a groups-only sign-in to the picker ──
  {
    const url = LG.link("https://f.ly/", "secret", PH, "L1");
    assert.match(url, /^https:\/\/f\.ly\/api\/posting\/groups-link\?t=.+&l=L1$/);
    const t = decodeURIComponent(url.split("t=")[1].split("&")[0]);
    const auth = require("./auth");
    assert.equal(auth.verifySession("secret", t, ["groups"]).userId, PH);
    assert.equal(auth.verifySession("secret", t), null, "never a full session");
  }

  console.log("posting-listing-groups.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
