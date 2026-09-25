/* listing-sweep.test.js — the my-ads → draft flow. No network, no browser:
   withPage, the store, and the extract-jobs queue are fakes. */
process.env.FORLY_ENV = "local";
const assert = require("assert");
const sweep = require("./listing-sweep");
const { profileName } = require("./profile-name");

function fakeDb({ listings = [], connected = true } = {}) {
  const drafts = new Map();
  return {
    drafts,
    getConnection: async () => (connected ? { yad2_browser_connected_at: "2026-01-01T00:00:00.000Z" } : {}),
    listListingsByPhone: async () => listings,
    getListingDraft: async (id) => drafts.get(id) || null,
    saveListingDraft: async (d) => drafts.set(d.id, d),
  };
}

const PLATFORMS = { yad2: { checkUrl: "https://www.yad2.co.il/my-ads" } };

(async () => {
  // ── three ads on the page: one already a page (by fingerprint), one already
  //    a known draft, one new → {found:3, queued:1, skipped:2} ──
  const db = fakeDb({ listings: [{ address: "רוטשילד 1", price: 5000 }] });
  const existingDraftId = sweep.draftKey("0500000000", "yad2", "already-known");
  db.drafts.set(existingDraftId, { id: existingDraftId, status: "ready" });

  const created = [];
  const extractJobs = { create: async (input) => { created.push(input); return { id: `job-${created.length}` }; } };

  const ads = [
    { url: "https://www.yad2.co.il/item/already-known", title: "דירה חדשה", price: 6000 }, // dup draft
    { url: "https://www.yad2.co.il/item/dup-page", title: "רוטשילד 1", price: 5000 }, // dup page (fingerprint)
    { url: "https://www.yad2.co.il/item/fresh-one", title: "דירה 3 חדרים", price: 7000 }, // new
  ];
  let sweepDeps = null;
  const withPage = async (opts, fn, d) => {
    assert.equal(opts.profile.name, profileName("yad2", "0500000000"));
    sweepDeps = d;
    return fn({ goto: async () => {}, url: () => "https://www.yad2.co.il/my-ads", innerText: async () => "המודעות שלי", myAds: async () => ads });
  };

  const result = await sweep.sweep({ platform: "yad2", phone: "0500000000" }, { db, extractJobs, withPage, platforms: PLATFORMS });
  assert.deepEqual(result, { found: 3, queued: 1, skipped: 2 });
  // the sweep holds the profile lock itself; withPage must know whose profile it is
  assert.equal(sweepDeps.phone, "0500000000");
  assert.equal(sweepDeps.platform, "yad2");
  assert.equal(sweepDeps.lockHeld, true);
  assert.ok(sweepDeps.conn && sweepDeps.conn.yad2_browser_connected_at, "the connection rides along for the revoked/quarantined check");
  assert.equal(created.length, 1, "only the new ad gets a real extract job");
  assert.equal(created[0].url, "https://www.yad2.co.il/item/fresh-one");
  assert.equal(created[0].forceSource, "driver");
  assert.equal(created[0].profileName, undefined, "no profile: the extract must not touch the agent's session");
  assert.ok(created[0].draftId);

  const freshDraft = db.drafts.get(sweep.draftKey("0500000000", "yad2", "fresh-one"));
  assert.ok(freshDraft, "the new ad was saved as a draft");
  assert.equal(freshDraft.status, "queued");
  assert.equal(freshDraft.title, "דירה 3 חדרים");
  assert.equal(freshDraft.price, 7000);

  // ── not connected: refuses before ever opening a browser ──
  await assert.rejects(
    () => sweep.sweep({ platform: "yad2", phone: "p" }, {
      db: fakeDb({ connected: false }), extractJobs, platforms: PLATFORMS,
      withPage: async () => { throw new Error("must not open a browser"); },
    }),
    (e) => e.code === "invalid_input",
  );

  // ── an unknown platform is rejected ──
  await assert.rejects(() => sweep.sweep({ platform: "instagram", phone: "p" }, { db: fakeDb(), platforms: PLATFORMS }), (e) => e.code === "invalid_input");

  // ── a login wall is reported, not swallowed ──
  await assert.rejects(
    () => sweep.sweep({ platform: "yad2", phone: "p" }, {
      db: fakeDb(), extractJobs, platforms: PLATFORMS,
      withPage: async (opts, fn) => fn({ goto: async () => {}, url: () => "https://www.yad2.co.il/auth/login", innerText: async () => "יש להתחבר כדי להמשיך", myAds: async () => [] }),
    }),
    (e) => e.code === "social_login_required",
  );

  // ── a scraped ad href outside the allowlist is rejected, never followed ──
  await assert.rejects(
    () => sweep.sweep({ platform: "yad2", phone: "p" }, {
      db: fakeDb(), extractJobs, platforms: PLATFORMS,
      withPage: async (opts, fn) => fn({
        goto: async () => {}, url: () => "https://www.yad2.co.il/my-ads", innerText: async () => "x",
        myAds: async () => [{ url: "https://evil.example.com/x", title: "t", price: 1 }],
      }),
    }),
    (e) => e.code === "invalid_input",
  );

  // ── the profile lock is held elsewhere: sweep yields instead of running twice ──
  const locks = require("./profile-lock");
  const release = locks.acquire("locked-phone", "yad2");
  const held = await sweep.sweep({ platform: "yad2", phone: "locked-phone" }, {
    db: fakeDb(), extractJobs, platforms: PLATFORMS,
    withPage: async () => { throw new Error("must not run while locked"); },
  });
  assert.deepEqual(held, { found: 0, queued: 0, skipped: 0 });
  release();

  // ── fingerprint ignores whitespace/case, but not price ──
  assert.equal(sweep.fingerprint("  Dirah   Yafa ", 100), sweep.fingerprint("dirah yafa", 100));
  assert.notEqual(sweep.fingerprint("dirah yafa", 100), sweep.fingerprint("dirah yafa", 200));

  // ── I2: the profile generation. With the real withPage's ownership check
  //    (Driver itself faked): at gen 1 the sweep opens the gen-1 profile and
  //    works; a quarantined connection is refused before any session ──
  {
    const D = require("./driver-browser");
    const sessions = [];
    const fakeDriver = {
      apiKey: "k", sleep: async () => {},
      fetchFn: async (url, init) => {
        sessions.push(init.method);
        return { ok: true, headers: { get: () => null }, json: async () => (init.method === "DELETE" ? { success: true } : { sessionId: "s1", status: "active", cdpUrl: "wss://x/y" }) };
      },
      connectOverCDP: async () => ({ contexts: () => [{ pages: () => [{ goto: async () => {}, url: () => "https://www.yad2.co.il/my-ads", innerText: async () => "המודעות שלי", myAds: async () => [] }] }], close: async () => {} }),
    };
    let opened = null;
    const real = (o, fn, d) => { opened = o.profile.name; return D.withPage(o, fn, Object.assign({}, d, fakeDriver)); };
    const gen1 = Object.assign(fakeDb(), { getConnection: async () => ({ yad2_browser_connected_at: "2026-01-01T00:00:00.000Z", yad2_profile_gen: 1, yad2_profile_state: "active" }) });
    const r1 = await sweep.sweep({ platform: "yad2", phone: "0500000001" }, { db: Object.assign(gen1, { listListingsByPhone: async () => [] }), extractJobs, withPage: real, platforms: PLATFORMS });
    assert.deepEqual(r1, { found: 0, queued: 0, skipped: 0 });
    assert.equal(opened, profileName("yad2", "0500000001", 1), "the gen-1 name");
    assert.deepEqual(sessions, ["POST", "DELETE"], "one session, stopped");
    // the old generation's name would have been refused by the same check
    assert.throws(() => require("./profile-name").assertOwnership(profileName("yad2", "0500000001"), "0500000001", "yad2", { yad2_profile_gen: 1 }), (e) => e.code === "profile_ownership");
    sessions.length = 0;
    const quarantined = Object.assign(fakeDb(), { getConnection: async () => ({ yad2_browser_connected_at: "2026-01-01T00:00:00.000Z", yad2_profile_state: "quarantined" }) });
    await assert.rejects(() => sweep.sweep({ platform: "yad2", phone: "0500000001" }, { db: quarantined, extractJobs, withPage: real, platforms: PLATFORMS }), (e) => e.code === "profile_ownership");
    assert.deepEqual(sessions, [], "no Driver session for a quarantined profile");
  }

  console.log("listing-sweep.test.js ok");
})();
