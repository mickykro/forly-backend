// server/posting-campaign-admin.test.js
/* posting-campaign-admin.js update(), and the admin bits of create/stop:
   real memory db and posting store (posting-testkit). */
const assert = require("assert");
const K = require("./posting-testkit");
const C = require("./posting-campaign");
const CA = require("./posting-campaign-admin");
const A_ = require("./posting-account");

(async () => {
  // ── create records who consented ──
  {
    const { deps } = await K.setup();
    const c = await C.create(K.base({ consent: { at: K.iso(K.NOW), version: "v", by: "admin", admin_tail: "0009", method: "phone", note: "דיברנו" } }), deps);
    assert.deepEqual(c.consent_by, { by: "admin", admin_tail: "0009", method: "phone", note: "דיברנו" });
    assert.equal(c.created_by, "admin");
    const { deps: d2 } = await K.setup();
    const a = await C.create(K.base(), d2);
    assert.deepEqual(a.consent_by, { by: "agent" });
    assert.equal(a.created_by, "agent");
  }

  // ── update: add, remove (history kept), texts, days, repeat, mode ──
  {
    const { deps } = await K.setup();
    const c = await C.create(K.base(), deps);
    await K.store.mutatePostingCampaign(c.id, (cur) => ({ posts: [
      { id: "p1", target: "group", group_id: "111", status: "posted" },
      { id: "p2", target: "group", group_id: "111", status: "scheduled" },
    ] }));
    const v = (await K.store.getPostingCampaign(c.id)).updated_at;
    const out = await CA.update(c.id, {
      remove_group_ids: ["111"], copies: { 222: "טקסט חדש" }, days: 10, repeat_days: 5, mode: "per_post",
    }, deps, { version: v, by: "admin" });
    assert.deepEqual(out.groups.map((g) => g.group_id), ["222"]);
    assert.equal(out.groups[0].copy, "טקסט חדש");
    assert.equal(out.posts.find((p) => p.id === "p1").status, "posted", "posted history stays");
    assert.equal(out.posts.find((p) => p.id === "p2").status, "skipped");
    assert.equal(out.posts.find((p) => p.id === "p2").error_code, "removed");
    assert.equal(out.repeat, true); assert.equal(out.repeat_days, 5);
    assert.equal(out.mode, "per_post");
    assert.equal(new Date(out.expires_at).getTime(), K.NOW.getTime() + 10 * K.DAY);
    assert.equal(out.last_changed_by.by, "admin");
    // repeat off
    const off = await CA.update(c.id, { repeat_days: 0 }, deps, { version: out.updated_at });
    assert.equal(off.repeat, false); assert.equal(off.repeat_days, null);
  }

  // ── a removed group that is re-added is owed again ──
  {
    const { deps } = await K.setup();
    const c = await C.create(K.base(), deps);
    await K.store.mutatePostingCampaign(c.id, () => ({ posts: [
      { id: "p1", target: "group", group_id: "111", status: "scheduled" },
      { id: "p9", target: "group", group_id: "222", status: "posted" },
    ] }));
    let cur = await K.store.getPostingCampaign(c.id);
    cur = await CA.update(c.id, { remove_group_ids: ["111"] }, deps, { version: cur.updated_at });
    assert.equal(cur.posts.find((p) => p.id === "p1").error_code, "removed");
    const g111 = (await K.store.getPostingCampaign(c.id)).groups;
    cur = await CA.update(c.id, { add_groups: [{ group_id: "111", name: "א", url: "https://www.facebook.com/groups/111" }] }, deps, { version: cur.updated_at });
    assert.ok(cur.groups.some((g) => g.group_id === "111"));
    assert.ok(!A_.currentPosts(cur).some((p) => p.group_id === "111" && p.error_code === "removed"), "the removed post is dropped");
    assert.ok(cur.posts.some((p) => p.id === "p9" && p.status === "posted"), "other history stays");
    assert.equal(require("./posting-manual").groupsOf(cur).find((g) => String(g.group_id) === "111").status, "owed");
    const ids = C._test.candidatesFor(cur, { conn: (await K.db.getConnection(cur.phone)) || {}, now: K.NOW, catalog: await A_.catalogIndex(K.db) }).map((t) => t.group_id);
    assert.ok(ids.includes("111"), "the planner offers it again");
  }

  // ── update: stale version, busy, ended, missing ──
  {
    const { deps } = await K.setup();
    const c = await C.create(K.base(), deps);
    await assert.rejects(CA.update(c.id, { days: 5 }, deps, { version: "old" }), (e) => e.code === "stale_version");
    await K.store.mutatePostingCampaign(c.id, () => ({ posts: [{ id: "p1", target: "group", group_id: "111", status: "posting" }] }));
    const v = (await K.store.getPostingCampaign(c.id)).updated_at;
    await assert.rejects(CA.update(c.id, { remove_group_ids: ["111"] }, deps, { version: v }), (e) => e.code === "busy");
    await C.stop(c.id, deps, "admin");
    await assert.rejects(CA.update(c.id, { days: 5 }, deps, {}), (e) => e.code === "not_live");
    await assert.rejects(CA.update("nope", { days: 5 }, deps, {}), (e) => e.code === "not_found");
  }

  // ── stop by admin sends no "stopped" message ──
  {
    const { deps, notes } = await K.setup();
    const c = await C.create(K.base(), deps);
    await C.stop(c.id, deps, "admin");
    assert.equal(notes.length, 0);
    const { deps: d2, notes: n2 } = await K.setup();
    const c2 = await C.create(K.base(), d2);
    await C.stop(c2.id, d2);
    assert.equal(n2.length, 1, "an agent stop still tells the agent");
  }
  // ── admin messages go out in manual mode too; other kinds do not ──
  {
    const sent = [];
    const deps = { env: { POSTING_MANUAL: "1" }, notify: async (ph, m) => sent.push(m) };
    await A_.say(deps, "972500000001", "admin_created", "נפתח קמפיין");
    await A_.say(deps, "972500000001", "admin_stopped", "נעצר");
    await A_.say(deps, "972500000001", "paused", "הושהה");
    assert.deepEqual(sent, ["נפתח קמפיין", "נעצר"]);
    const M = require("./posting-messages").build({ pageBaseUrl: "https://f.ly", authSecret: "s" });
    assert.ok(M.admin_created({ id: "c1", groups: [{}, {}] }).body.includes("2"));
    assert.ok(M.admin_stopped({ id: "c1" }).header.length > 0);
  }
  // ── an edit that leaves nowhere to post is refused ──
  {
    const { deps } = await K.setup();
    const c = await C.create(K.base(), deps);
    const cur = await K.store.getPostingCampaign(c.id);
    await assert.rejects(CA.update(c.id, { remove_group_ids: ["111", "222"] }, deps, { version: cur.updated_at }), (e) => e.code === "no_destination");
    assert.deepEqual((await K.store.getPostingCampaign(c.id)).groups.map((g) => g.group_id), ["111", "222"], "untouched");
  }

  // ── targets and mode reconcile the posts already planned ──
  {
    const { deps, notes } = await K.setup();
    const c = await C.create(K.base(), deps);
    await K.store.mutatePostingCampaign(c.id, () => ({ targets: ["groups", "page"], posts: [
      { id: "pg", target: "page", group_id: "page:1", status: "scheduled", scheduled_at: K.iso(K.NOW) },
      { id: "g1", target: "group", group_id: "111", status: "scheduled", scheduled_at: K.iso(K.NOW), copy: "טקסט", approved_at: null },
    ] }));
    let cur = await K.store.getPostingCampaign(c.id);
    // the Page unchecked: its planned post never goes out
    cur = await CA.update(c.id, { targets: ["groups"] }, deps, { version: cur.updated_at });
    assert.deepEqual([cur.posts[0].status, cur.posts[0].error_code], ["skipped", "target_removed"]);
    assert.equal(cur.posts[1].status, "scheduled");
    // standing → per_post: an unapproved scheduled post goes to the agent for approval
    cur = await CA.update(c.id, { mode: "per_post" }, deps, { version: cur.updated_at });
    assert.equal(cur.posts[1].status, "pending_approval");
    assert.equal(notes.length, 1, "the agent is asked to approve it");
    // per_post → standing: a post waiting for approval is scheduled
    cur = await CA.update(c.id, { mode: "standing" }, deps, { version: cur.updated_at });
    assert.equal(cur.posts[1].status, "scheduled");
    assert.ok(new Date(cur.posts[1].scheduled_at).getTime() >= K.NOW.getTime());
  }
  {
    const { deps } = await K.setup();
    const c = await C.create(K.base(), deps);
    await K.store.mutatePostingCampaign(c.id, () => ({ targets: ["groups", "page"], posts: [{ id: "pg", target: "page", group_id: "page:1", status: "posting" }] }));
    const cur = await K.store.getPostingCampaign(c.id);
    await assert.rejects(CA.update(c.id, { targets: ["groups"] }, deps, { version: cur.updated_at }), (e) => e.code === "busy", "a Page post on its way refuses the edit");
  }

  // ── runDue: the campaign as it is now decides (edits that bypassed update) ──
  {
    const S = require("./posting-sweeper");
    const { deps, at } = await K.setup();
    let c = await C.create(K.base(), deps);
    c = await S.tick(c, deps, at(K.NOW));
    assert.equal(c.posts[0].status, "scheduled");
    await K.store.mutatePostingCampaign(c.id, () => ({ mode: "per_post" }));
    c = await S.tick(await K.store.getPostingCampaign(c.id), deps, at(K.dueOf(c)));
    assert.equal(c.posts[0].status, "pending_approval", "per_post: an unapproved post is never published");
    assert.equal(deps.post.calls.length, 0);
  }
  {
    const S = require("./posting-sweeper");
    const { deps, at } = await K.setup();
    let c = await C.create(K.base(), deps);
    c = await S.tick(c, deps, at(K.NOW));
    assert.equal(c.posts[0].target, "group");
    await K.store.mutatePostingCampaign(c.id, () => ({ targets: ["page"] }));
    c = await S.tick(await K.store.getPostingCampaign(c.id), deps, at(K.dueOf(c)));
    assert.deepEqual([c.posts[0].status, c.posts[0].error_code], ["skipped", "target_removed"]);
    assert.equal(deps.post.calls.length, 0);
  }

  console.log("posting-campaign-admin.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
