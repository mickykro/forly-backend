/* One group, two ids (Task 18 fix round 1): a vanity "slug:…" group id that
   the driver resolved to its numeric id stays an ALIAS, so every protection
   recorded under the old id — account→group and property→group cooldowns,
   the global group bucket, fingerprints, the property→group dedup — still
   applies after the remap. No browser: the driver is a fake. */
const assert = require("assert");
const K = require("./posting-testkit");
const C = require("./posting-campaign");
const S = require("./posting-sweeper");
const sync = require("./facebook-groups-sync");

const { db, store, NOW, DAY, G, member, page, base, dueOf, setup } = K;
const PH = "972500000001";
const SLUG_URL = G("haifa.rent");
const SLUG = "slug:haifa.rent";
const silence = () => { const orig = console.error; console.error = () => {}; return () => { console.error = orig; }; };

// Walks the attempt to verified_posted and reports the slug's numeric id.
const resolvingDriver = () => {
  const fn = async (args, d) => {
    fn.calls.push(args);
    const k = args.attempt.key;
    for (const s of ["session_started", "composer_ready", "submit_started", "verification_pending"]) await d.attempts.transition(k, s);
    await d.attempts.transition(k, "verified_posted", { post_url: `${args.groupUrl}/posts/${fn.calls.length}` });
    return { state: "verified_posted", resolved_group_id: /^slug:/.test(args.attempt.target_id) ? "12345" : undefined };
  };
  fn.calls = [];
  return fn;
};
const slugConn = { facebook_groups_member: [member(SLUG, { canonical_url: SLUG_URL, slug: "haifa.rent", id_verified: false })] };

// One tick per day (and the due tick when a post was just scheduled); → the
// day index (from 0) of every driver call.
async function runDays(deps, at, days, campaigns) {
  const postedOn = [];
  for (let d = 0; d <= days; d++) {
    const t = new Date(NOW.getTime() + d * DAY);
    for (const id of campaigns) {
      const before = deps.post.calls.length;
      let c = await S.tick(await store.getPostingCampaign(id), deps, at(t));
      const due = (c.posts || []).findIndex((p) => p.status === "scheduled");
      if (due >= 0) c = await S.tick(c, deps, at(dueOf(c, due)));
      if (deps.post.calls.length > before) postedOn.push(d);
    }
  }
  return postedOn;
}

(async () => {
  const restore = silence();
  try {
    // ── the reviewer's repro: a repeating campaign, the slug resolved on its first post ──
    {
      const { deps, at } = await setup(PH, { post: resolvingDriver(), conn: slugConn });
      const c = await C.create(base({ groups: [{ url: SLUG_URL, agent_policy: "explicitly_allowed" }], repeat: true, days: 30 }), deps);
      const postedOn = await runDays(deps, at, 16, [c.id]);
      assert.equal(postedOn[0], 0, "the first post goes out on day 0");
      assert.ok(postedOn.slice(1).every((d) => d >= 14), `no second post within the 7- and 14-day windows (posted on days ${postedOn.join(",")})`);
      assert.ok(postedOn.length === 2, "and the group is used again once the property→group cooldown is over");
      const cur = await store.getPostingCampaign(c.id);
      assert.equal(cur.groups[0].group_id, "12345");
      assert.deepEqual(cur.groups[0].aliases, [SLUG], "the campaign group keeps the slug as an alias");
      const m = (await db.getConnection(PH)).facebook_groups_member;
      assert.deepEqual(m.map((e) => [e.group_id, e.aliases]), [["12345", [SLUG]]], "so does the membership entry");
      // fix round 2 D: and the global registry, which every account's caps read
      assert.deepEqual((await store.groupIdsFor(SLUG)).sort(), ["12345", SLUG].sort());
      assert.deepEqual((await store.groupIdsFor("12345")).sort(), ["12345", SLUG].sort());
    }

    // ── fix round 2 D: the registry is global — another account reserving under the slug shares the cap ──
    {
      const limits = { daily_cap: 5, group_global_daily_cap: 1, dedup_days: 14 };
      const reserve = (phone, target_id, now = NOW, page_id = "pg1") => store.reserveAttempt({ phone, page_id, target_type: "group", target_id, publisher: "browser", limits, now });
      // control: without the registry, account 2's slug reservation would slip past account 1's numeric one
      K.reset();
      assert.ok((await reserve(PH, "12345")).ok);
      assert.ok((await reserve("972500000002", SLUG, NOW, "pg2")).ok, "(the reviewer's overshoot)");
      // with it: account 1 resolved the slug, reserved under the numeric id; account 2 knows only the slug
      K.reset();
      await store.recordGroupAlias(SLUG, "12345", NOW);
      assert.ok((await reserve(PH, "12345")).ok);
      assert.deepEqual(await reserve("972500000002", SLUG, NOW, "pg2"), { ok: false, reason: "group_cap" }, "the global cap of 1 holds across ids");
      // the property→group dedup folds through it too
      assert.deepEqual(await reserve(PH, SLUG, new Date(NOW.getTime() + DAY)), { ok: false, reason: "duplicate" });
      // and group activity, from either id
      assert.equal((await store.getGroupActivityFor([SLUG], NOW))[SLUG].posts_today, 1);
      K.reset();
      await store.recordGroupAlias(SLUG, "12345", NOW);
      assert.ok((await reserve("972500000002", SLUG, NOW, "pg2")).ok);
      assert.equal((await store.getGroupActivityFor(["12345"], NOW))["12345"].posts_today, 1, "the numeric id sees the slug's bucket");
    }

    // ── a different listing to the same group within 7 days is refused, whichever id its campaign holds ──
    for (const createdAfterRemap of [false, true]) {
      const { deps, at } = await setup(PH, { post: resolvingDriver(), conn: slugConn });
      await db.savePage(page("pg2"));
      const c1 = await C.create(base({ groups: [{ url: SLUG_URL, agent_policy: "explicitly_allowed" }] }), deps);
      let c2 = createdAfterRemap ? null : await C.create(base({ page: page("pg2"), groups: [{ url: SLUG_URL, agent_policy: "explicitly_allowed" }] }), deps);
      let postedOn = await runDays(deps, at, 0, c2 ? [c1.id, c2.id] : [c1.id]);
      assert.deepEqual(postedOn, [0]);
      if (!c2) {
        c2 = await C.create(base({ page: page("pg2"), groups: [{ url: SLUG_URL, agent_policy: "explicitly_allowed" }] }), deps);
        assert.equal(c2.groups[0].group_id, "12345", "a campaign made after the remap uses the numeric id");
      }
      const later = [];
      for (let d = 1; d <= 9; d++) {
        const t = new Date(NOW.getTime() + d * DAY);
        const before = deps.post.calls.length;
        for (const id of [c1.id, c2.id]) {
          let c = await S.tick(await store.getPostingCampaign(id), deps, at(t));
          const due = (c.posts || []).findIndex((p) => p.status === "scheduled");
          if (due >= 0) await S.tick(c, deps, at(dueOf(c, due)));
        }
        if (deps.post.calls.length > before) later.push(d);
      }
      assert.ok(later.length >= 1 && later[0] >= 7, `${createdAfterRemap ? "numeric" : "slug"} campaign: the other listing waits out the 7-day group cooldown (posted on day ${later.join(",")})`);
    }

    // ── reserveAttempt: the dedup doc and the group bucket under the alias still count ──
    {
      K.reset();
      const limits = { daily_cap: 5, group_global_daily_cap: 1, dedup_days: 14 };
      const r1 = await store.reserveAttempt({ phone: PH, page_id: "pg1", target_type: "group", target_id: SLUG, publisher: "browser", limits, now: NOW });
      assert.ok(r1.ok);
      const tomorrow = new Date(NOW.getTime() + DAY);
      const dup = await store.reserveAttempt({ phone: PH, page_id: "pg1", target_type: "group", target_id: "12345", target_aliases: [SLUG], publisher: "browser", limits, now: tomorrow });
      assert.deepEqual(dup, { ok: false, reason: "duplicate" }, "property→group dedup under the alias");
      const control = await store.reserveAttempt({ phone: PH, page_id: "pg1", target_type: "group", target_id: "12345", publisher: "browser", limits, now: tomorrow });
      assert.ok(control.ok, "(without the alias it would have gone through — the reviewer's bug)");
      const cap = await store.reserveAttempt({ phone: "972500000002", page_id: "pg9", target_type: "group", target_id: "777", target_aliases: [SLUG], publisher: "browser", limits, now: NOW });
      assert.deepEqual(cap, { ok: false, reason: "group_cap" }, "today's bucket under the alias counts toward the global cap");
      await assert.rejects(store.reserveAttempt({ phone: PH, page_id: "pg1", target_type: "group", target_id: "1", target_aliases: "slug:x", publisher: "browser", limits, now: NOW }), (e) => e.code === "invalid_input");

      // getGroupActivityFor folds the alias's buckets into the group's entry
      const ga = await store.getGroupActivityFor(["12345"], NOW, undefined, { 12345: [SLUG] });
      assert.equal(ga["12345"].posts_today, 1);
      assert.equal((await store.getGroupActivityFor(["12345"], NOW))["12345"].posts_today, 0);
    }

    // ── the weekly sync sees the slug again: it stays the numeric entry ──
    {
      const prev = [{ group_id: "12345", aliases: [SLUG], canonical_url: SLUG_URL, slug: "haifa.rent", membership_state: "member", observed_at: NOW.toISOString(), last_confirmed_at: NOW.toISOString(), id_verified: true, name: "דירות חיפה" }];
      const next = sync.mergeMembership(prev, [{ url: SLUG_URL, slug: "haifa.rent", name: "דירות חיפה" }], { now: new Date(NOW.getTime() + DAY) });
      assert.deepEqual(next.map((e) => [e.group_id, e.membership_state, e.aliases]), [["12345", "member", [SLUG]]]);
      const resolved = sync.resolveGroupId({ facebook_groups_member: [member(SLUG), member("12345")] }, SLUG, "12345");
      assert.equal(resolved.length, 1);
      assert.deepEqual(resolved[0].aliases, [SLUG], "a merge keeps the alias too");
    }
  } finally { restore(); }
  console.log("posting-group-alias.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
