/* facebook-groups-sync.js — scrape + canonicalise + dedup (syncMembership),
   the R3 merge into stored entries (mergeMembership, resolveGroupId), the
   guard-gated own-session sync (runSync), and staleness (isStale). No
   network: withPage/db/guard are fakes. */
process.env.FORLY_ENV = "local";
process.env.PROFILE_KEY = "k";
const assert = require("assert");
const crypto = require("crypto");
const G = require("./facebook-groups-sync");
const { profileName } = require("./profile-name");

function nameHash(name) {
  return crypto.createHmac("sha256", "k").update(String(name)).digest("hex").slice(0, 16);
}

(async () => {
  // ── syncMembership: scrapes, canonicalises, dedups ──
  const page = {
    goto: async () => {}, url: () => "https://www.facebook.com/groups/joins/",
    mouse: { wheel: async () => {} }, waitForTimeout: async () => {}, waitForLoadState: async () => {},
    $$eval: async () => [
      { href: "https://www.facebook.com/groups/111/?ref=bookmarks", text: "דירות בחיפה" },
      { href: "https://www.facebook.com/groups/111", text: "דירות בחיפה" },
      { href: "https://www.facebook.com/groups/two.words/", text: "Rent TLV" },
      { href: "https://www.facebook.com/marketplace", text: "Marketplace" },
    ],
  };
  const list = await G.syncMembership(page);
  assert.deepEqual(list, [
    { url: "https://www.facebook.com/groups/111", slug: "111", name: "דירות בחיפה" },
    { url: "https://www.facebook.com/groups/two.words", slug: "two.words", name: "Rent TLV" },
  ]);

  // ── runSync: guards first, opens its own session on the agent's profile,
  //    merges the scrape in, and stores it on the connection ──
  {
    const conn = { facebook_groups_member: [] };
    let opts = null, pageDeps = null, guarded = null;
    const n = await G.runSync({ phone: "p" }, {
      guard: { assertAllowed: async (args) => { guarded = args; return true; } },
      withPage: async (o, fn, deps) => { opts = o; pageDeps = deps; return fn(page); },
      db: {
        getConnection: async () => conn,
        setConnection: async (ph, patch) => Object.assign(conn, patch),
        listGroupCatalog: async () => [],
      },
    });
    assert.equal(n, 2);
    assert.equal(conn.facebook_groups_member.length, 2);
    assert.ok(conn.facebook_groups_synced_at);
    assert.equal(opts.profile.name, profileName("facebook", "p"));
    assert.ok(String(opts.note).startsWith("forly-sync:"));
    assert.deepEqual(guarded, { phone: "p", platform: "facebook", action: "session" });
    assert.equal(pageDeps.phone, "p");
    assert.equal(pageDeps.platform, "facebook");
  }

  // ── runSync: the guard throwing means no session is ever opened ──
  {
    let opened = false;
    await assert.rejects(
      () => G.runSync({ phone: "p" }, {
        guard: { assertAllowed: async () => { const e = new Error("no"); e.code = "posting_disabled"; e.reason = "global_off"; throw e; } },
        withPage: async () => { opened = true; },
        db: { getConnection: async () => ({}), setConnection: async () => {}, listGroupCatalog: async () => [] },
      }),
      (e) => e.code === "posting_disabled",
    );
    assert.equal(opened, false, "no browser session when the guard refuses");
  }

  // ── staleness ──
  assert.equal(G.isStale({}, new Date()), true);
  assert.equal(G.isStale({ facebook_groups_synced_at: new Date(Date.now() - 8 * 86400000).toISOString() }, new Date()), true);
  assert.equal(G.isStale({ facebook_groups_synced_at: new Date().toISOString() }, new Date()), false);

  // ── mergeMembership: a fresh sighting is "member", stable IDs, privacy ──
  const NOW = new Date("2026-09-25T12:00:00Z");
  {
    // numeric slug -> id_verified, group_id IS the slug; vanity slug -> "slug:" id
    const scraped = [
      { url: "https://www.facebook.com/groups/999", slug: "999", name: "משהו אחר לגמרי" },
      { url: "https://www.facebook.com/groups/some-club", slug: "some-club", name: "מועדון טיולים" },
    ];
    const merged = G.mergeMembership([], scraped, { now: NOW, catalog: [], selected: [] });
    const byId = Object.fromEntries(merged.map((e) => [e.group_id, e]));
    assert.equal(byId["999"].id_verified, true);
    assert.equal(byId["999"].membership_state, "member");
    assert.equal(byId["999"].observed_at, NOW.toISOString());
    assert.equal(byId["999"].last_confirmed_at, NOW.toISOString());
    assert.equal(byId["slug:some-club"].id_verified, false);
    // neither name matches the real-estate keywords nor a catalog entry -> hashed, no name
    assert.equal(byId["999"].name, undefined);
    assert.equal(byId["999"].name_hash, nameHash("משהו אחר לגמרי"));
    assert.equal(byId["slug:some-club"].name_hash, nameHash("מועדון טיולים"));
  }

  // ── privacy: a real-estate-looking name is kept in the clear ──
  {
    const scraped = [{ url: "https://www.facebook.com/groups/777", slug: "777", name: "דירות להשכרה בתל אביב" }];
    const merged = G.mergeMembership([], scraped, { now: NOW, catalog: [], selected: [] });
    assert.equal(merged[0].name, "דירות להשכרה בתל אביב");
    assert.equal(merged[0].name_hash, undefined);
  }

  // ── privacy: a catalog match (by canonical URL) is kept in the clear even
  //    with a name that matches no keyword ──
  {
    const scraped = [{ url: "https://www.facebook.com/groups/555", slug: "555", name: "קבוצת השכנים שלי" }];
    const catalog = [{ name: "x", url: "https://www.facebook.com/groups/555?ref=x" }];
    const merged = G.mergeMembership([], scraped, { now: NOW, catalog, selected: [] });
    assert.equal(merged[0].name, "קבוצת השכנים שלי");
  }

  // ── privacy: an explicitly selected group_id is kept in the clear ──
  {
    const scraped = [{ url: "https://www.facebook.com/groups/333", slug: "333", name: "לא רלוונטי" }];
    const merged = G.mergeMembership([], scraped, { now: NOW, catalog: [], selected: ["333"] });
    assert.equal(merged[0].name, "לא רלוונטי");
  }

  // ── missing from a scrape -> "stale", observed_at frozen ──
  {
    const prev = [{ group_id: "111", canonical_url: "https://www.facebook.com/groups/111", slug: "111", name_hash: "h", membership_state: "member", observed_at: "2026-09-01T00:00:00.000Z", last_confirmed_at: "2026-09-01T00:00:00.000Z", id_verified: true }];
    const merged = G.mergeMembership(prev, [], { now: NOW, catalog: [], selected: [] });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].membership_state, "stale");
    assert.equal(merged[0].observed_at, "2026-09-01T00:00:00.000Z", "observed_at is not bumped just because it's still missing");
  }

  // ── stale for more than 30 days -> dropped ──
  {
    const old = new Date(NOW.getTime() - 31 * 86400000).toISOString();
    const prev = [{ group_id: "222", canonical_url: "https://www.facebook.com/groups/222", slug: "222", name_hash: "h", membership_state: "stale", observed_at: old, last_confirmed_at: old, id_verified: true }];
    const merged = G.mergeMembership(prev, [], { now: NOW, catalog: [], selected: [] });
    assert.deepEqual(merged, []);
  }

  // ── "left" ages out the same way but is not silently upgraded back to
  //    "member" or "stale" while it survives ──
  {
    const recent = new Date(NOW.getTime() - 5 * 86400000).toISOString();
    const prev = [{ group_id: "444", canonical_url: "https://www.facebook.com/groups/444", slug: "444", name_hash: "h", membership_state: "left", observed_at: recent, last_confirmed_at: recent, id_verified: true }];
    const merged = G.mergeMembership(prev, [], { now: NOW, catalog: [], selected: [] });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].membership_state, "left");
  }

  // ── resolveGroupId: rewrites a provisional "slug:" id to the numeric one ──
  {
    const conn = { facebook_groups_member: [
      { group_id: "slug:some-club", canonical_url: "https://www.facebook.com/groups/some-club", slug: "some-club", name_hash: "h", membership_state: "member", observed_at: NOW.toISOString(), last_confirmed_at: NOW.toISOString(), id_verified: false },
    ] };
    const out = G.resolveGroupId(conn, "slug:some-club", "123456");
    assert.equal(out.length, 1);
    assert.equal(out[0].group_id, "123456");
    assert.equal(out[0].id_verified, true);
  }

  // ── resolveGroupId: merges with an entry that already carries the numeric id ──
  {
    const older = new Date(NOW.getTime() - 86400000).toISOString();
    const conn = { facebook_groups_member: [
      { group_id: "slug:some-club", canonical_url: "https://www.facebook.com/groups/some-club", slug: "some-club", name: "מועדון טיולים", membership_state: "member", observed_at: NOW.toISOString(), last_confirmed_at: NOW.toISOString(), id_verified: false },
      { group_id: "123456", canonical_url: "https://www.facebook.com/groups/123456", slug: "123456", name_hash: "h", membership_state: "stale", observed_at: older, last_confirmed_at: older, id_verified: true },
    ] };
    const out = G.resolveGroupId(conn, "slug:some-club", "123456");
    assert.equal(out.length, 1, "the two entries collapse into one");
    assert.equal(out[0].group_id, "123456");
    assert.equal(out[0].membership_state, "member", "member wins over stale");
    assert.equal(out[0].name, "מועדון טיולים", "a kept name wins over a hash");
  }

  // ── resolveGroupId: an explicit "left" beats a mere "stale" — leaving is
  //    positive evidence, staleness is only absence of evidence ──
  {
    const older = new Date(NOW.getTime() - 86400000).toISOString();
    const conn = { facebook_groups_member: [
      { group_id: "slug:some-club", canonical_url: "https://www.facebook.com/groups/some-club", slug: "some-club", name_hash: "h", membership_state: "stale", observed_at: older, last_confirmed_at: older, id_verified: false },
      { group_id: "123456", canonical_url: "https://www.facebook.com/groups/123456", slug: "123456", name_hash: "h2", membership_state: "left", observed_at: older, last_confirmed_at: older, id_verified: true },
    ] };
    const out = G.resolveGroupId(conn, "slug:some-club", "123456");
    assert.equal(out.length, 1);
    assert.equal(out[0].group_id, "123456");
    assert.equal(out[0].membership_state, "left", "numeric left + vanity stale on the same id stays left");
  }

  // ── resolveGroupId: a member sighting newer than the left determination
  //    wins anyway — a re-join is real once it's the newer fact ──
  {
    const before = new Date(NOW.getTime() - 2 * 86400000).toISOString();
    const after = new Date(NOW.getTime() - 86400000).toISOString();
    const conn = { facebook_groups_member: [
      { group_id: "slug:some-club", canonical_url: "https://www.facebook.com/groups/some-club", slug: "some-club", name_hash: "h", membership_state: "member", observed_at: after, last_confirmed_at: after, id_verified: false },
      { group_id: "123456", canonical_url: "https://www.facebook.com/groups/123456", slug: "123456", name_hash: "h2", membership_state: "left", observed_at: before, last_confirmed_at: before, id_verified: true },
    ] };
    const out = G.resolveGroupId(conn, "slug:some-club", "123456");
    assert.equal(out[0].membership_state, "member", "a re-join newer than the left determination wins");
  }

  // ── mergeMembership: privacy is re-gated on every merge, not only when an
  //    entry is first observed — a name kept because it was `selected` is
  //    hashed away once it is no longer selected AND no longer observed ──
  {
    const prev = [{ group_id: "333", canonical_url: "https://www.facebook.com/groups/333", slug: "333", name: "לא רלוונטי", membership_state: "member", observed_at: NOW.toISOString(), last_confirmed_at: NOW.toISOString(), id_verified: true }];
    const later = new Date(NOW.getTime() + 86400000);
    const merged = G.mergeMembership(prev, [], { now: later, catalog: [], selected: [] });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].membership_state, "stale");
    assert.equal(merged[0].name, undefined, "no longer selected and not re-observed -> the plaintext name is re-gated away");
    assert.equal(merged[0].name_hash, nameHash("לא רלוונטי"));
  }

  console.log("facebook-groups-sync.test.js ok");
})();
