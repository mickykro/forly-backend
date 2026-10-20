/* posting-manual.js: the manual-posting switch, queue, tick-off and completion. */
const assert = require("assert");
const K = require("./posting-testkit");
const M = require("./posting-manual");
const A = require("./posting-account");
const C = require("./posting-campaign");

(async () => {
  // ── the switch ──
  assert.equal(M.enabled({ POSTING_MANUAL: "1" }), true);
  assert.equal(M.enabled({}), false);
  assert.equal(M.enabled({ POSTING_MANUAL: "0" }), false);

  // ── manual mode: only the end-of-campaign message reaches WhatsApp ──
  const sent = [];
  const notify = async (ph, m) => { sent.push(m); };
  for (const kind of ["approve", "posted", "halted", "reconnect", "stopped", "completed"]) await A.say({ env: { POSTING_MANUAL: "1" }, notify }, "972500000001", kind, `${kind} text`);
  assert.deepEqual(sent, ["completed text"], "only completed goes out");
  sent.length = 0;
  await A.say({ env: {}, notify }, "972500000001", "approve", "approve text");
  assert.deepEqual(sent, ["approve text"], "automatic mode unchanged");

  // ── the sweeper never posts in manual mode ──
  const S = require("./posting-sweeper");
  assert.equal(await S.sweep({ env: { POSTING_MANUAL: "1" } }), 0);
  assert.equal(S.status().last.result, "manual");

  // ── the agent ref never carries the phone, and is stable ──
  assert.match(M.refOf("972500000001"), /^acct_[0-9a-f]{24}$/);
  assert.equal(M.refOf("972500000001"), M.refOf("972500000001"));
  assert.notEqual(M.refOf("972500000001"), M.refOf("972500000002"));

  // ── expires_at holds in manual mode: the checklist ends a campaign past it, markDone refuses ──
  {
    const { deps, notes, at } = await K.setup();
    deps.env = { POSTING_MANUAL: "1", FORLY_ENV: "prod" };
    const c = await C.create(K.base({ days: 7 }), deps);
    assert.equal((await M.queue(deps)).length, 2);
    at(new Date(K.NOW.getTime() + 8 * K.DAY));
    assert.equal(await M.markDone(c.id, "111", "posted", deps), null, "day 8 of a 7-day campaign: refused");
    const ended = await K.store.getPostingCampaign(c.id);
    assert.equal(ended.status, "completed"); assert.equal(ended.pause_reason, "expired");
    assert.equal(ended.posts.length, 0, "nothing recorded");
    assert.equal(notes.length, 1, "the agent hears the campaign ended");
    const c2 = await C.create(K.base({ page: K.page("pg2"), days: 7 }), deps);
    await K.db.savePage(K.page("pg2"));
    assert.equal((await M.queue(deps)).length, 2, "a fresh campaign is listed");
    at(new Date(K.NOW.getTime() + 20 * K.DAY));
    notes.length = 0;
    const polls = await Promise.all([M.queue(deps), M.queue(deps)]); // two admin tabs polling at once
    assert.deepEqual(polls.map((q) => q.length), [0, 0], "past its end: gone from the queue");
    assert.equal((await K.store.getPostingCampaign(c2.id)).status, "completed");
    assert.equal(notes.length, 1, "the agent hears it once");
  }
  // ── outside a posting env (staging shares prod's data) a read ends nothing ──
  {
    const { deps, notes, at } = await K.setup();
    deps.env = { POSTING_MANUAL: "1", FORLY_ENV: "staging" };
    const c = await C.create(K.base({ days: 7 }), deps);
    at(new Date(K.NOW.getTime() + 8 * K.DAY));
    assert.equal((await M.queue(deps)).length, 0, "not listed");
    assert.equal((await K.store.getPostingCampaign(c.id)).status, "running", "unchanged");
    assert.equal(notes.length, 0);
    assert.equal(await M.markDone(c.id, "111", "posted", deps), null, "still refused");
  }

  // ── the Page is a target by hand too, first in the list; a repeating campaign owes each target again ──
  {
    const { deps, notes, at } = await K.setup();
    deps.env = { POSTING_MANUAL: "1", FORLY_ENV: "prod" };
    await K.db.setConnection("972500000001", { facebook_pages: [{ id: "555000", url: "https://www.facebook.com/myagency", name: "My Agency" }],
      posting_permission: Object.assign({}, K.PERM, { page_id: "555000" }) });
    const c = await C.create(K.base({ targets: ["groups", "page"], repeat: true, repeatDays: 3, days: 30 }), deps);
    assert.deepEqual(c.targets, ["page", "groups"]);
    let q = await M.queue(deps);
    assert.deepEqual(q.map((i) => [i.group_id, i.group_name]), [["page:555000", "My Agency"], ["111", "A"], ["222", "B"]]);
    assert.equal(q[0].group_url, "https://www.facebook.com/myagency");
    assert.ok(q[0].copy && !q[0].copy.includes("undefined"), "the Page gets the Page text");
    assert.ok(await M.markDone(c.id, "page:555000", "posted", deps), "the Page is ticked like a group");
    const after = await K.store.getPostingCampaign(c.id);
    assert.equal(after.posts[0].target, "page");
    assert.ok(await M.markDone(c.id, "111", "posted", deps));
    assert.ok(await M.markDone(c.id, "222", "skipped", deps));
    assert.equal((await K.store.getPostingCampaign(c.id)).status, "running", "a repeating campaign does not end with its first pass");
    assert.equal((await M.queue(deps)).length, 0, "nothing owed until the interval passes");
    assert.equal(notes.length, 0);
    at(new Date(K.NOW.getTime() + 3 * K.DAY - 30 * 60000));
    assert.equal((await M.queue(deps)).length, 0, "repeat 3: owed only once the pacer's 3-day floor has passed, not an hour before");
    at(new Date(K.NOW.getTime() + 3 * K.DAY));
    q = await M.queue(deps);
    assert.deepEqual(q.map((i) => i.group_id), ["111", "222"], "3 days on: the groups again (the skipped one too), the Page not for 30 days");
    const g111 = (await M.checklist(deps))[0].groups.find((g) => g.group_id === "111");
    assert.equal(g111.limit.block, null, "owed exactly when the pacer's cooldown lets it through");
    assert.ok(await M.markDone(c.id, "111", "posted", deps));
    assert.equal((await K.store.getPostingCampaign(c.id)).posts.filter((p) => p.group_id === "111" && p.status === "posted").length, 2);
    at(new Date(K.NOW.getTime() + 31 * K.DAY));
    assert.equal((await M.queue(deps)).length, 0, "past expires_at: over");
    assert.equal((await K.store.getPostingCampaign(c.id)).status, "completed");
    assert.equal(notes.length, 1, "the agent hears it once, at the end");
  }

  // ── a restarted campaign's hand-ticked posts belong to the new pass ──
  {
    const { deps, notes, at } = await K.setup();
    deps.env = { POSTING_MANUAL: "1", FORLY_ENV: "prod" };
    const c = await C.create(K.base(), deps);
    await M.markDone(c.id, "111", "posted", deps); await M.markDone(c.id, "222", "posted", deps);
    assert.equal((await K.store.getPostingCampaign(c.id)).status, "completed");
    at(new Date(K.NOW.getTime() + 10 * K.DAY));
    const again = await C.create(K.base({ consent: { at: K.iso(new Date(K.NOW.getTime() + 10 * K.DAY)), version: "v" } }), deps);
    assert.equal(again.status, "running"); assert.ok(again.restarted_at);
    assert.deepEqual((await M.queue(deps)).map((i) => i.group_id), ["111", "222"], "owed again after the restart");
    assert.ok(await M.markDone(again.id, "111", "posted", deps));
    assert.equal(await M.markDone(again.id, "111", "posted", deps), null, "ticked once: the post counts for this pass");
    const done = await M.markDone(again.id, "222", "posted", deps);
    assert.equal(done.status, "completed", "the restarted pass completes");
    assert.equal(notes.length, 2);
  }

  // ── queue → markDone → completed, with one WhatsApp listing the posted group ──
  {
    const { deps, notes } = await K.setup();
    deps.env = { POSTING_MANUAL: "1" };
    deps.messages = require("./posting-messages").build({ pageBaseUrl: "https://f.ly", authSecret: "s" });
    const c = await C.create(K.base({ copies: { 111: "הטקסט שאושר" } }), deps);

    const q = await M.queue(deps);
    assert.deepEqual(q.map((i) => i.group_id), ["111", "222"]);
    assert.equal(q[0].copy, "הטקסט שאושר", "the approved text, as approved");
    assert.ok(q[1].copy.length > 0, "a group without approved text gets the built text");
    assert.equal(q[0].ref, M.refOf("972500000001"));
    assert.ok(!JSON.stringify(q).includes("972500000001"), "no full phone");

    assert.ok(await M.markDone(c.id, "111", "posted", deps));
    assert.equal((await M.queue(deps)).length, 1);
    assert.equal(notes.length, 0, "nothing is sent mid-campaign");
    assert.equal(await M.markDone(c.id, "111", "posted", deps), null, "a group already done is refused");
    assert.equal(await M.markDone(c.id, "333", "posted", deps), null, "a group not in the campaign is refused");
    assert.equal(await M.markDone(c.id, "222", "nope", deps), null, "only posted or skipped");

    const done = await M.markDone(c.id, "222", "skipped", deps);
    assert.equal(done.status, "completed");
    assert.equal((await M.queue(deps)).length, 0);
    assert.equal(notes.length, 1, "one message at the end");
    const body = JSON.stringify(notes[0]);
    assert.ok(body.includes("facebook.com/groups/111"), "the posted group's link");
    assert.ok(!body.includes("facebook.com/groups/222"), "a skipped group is not listed");
  }

  // ── R4 by hand: every property link in an owed group's text carries that group's click code ──
  {
    const { deps } = await K.setup();
    deps.env = { POSTING_MANUAL: "1" }; deps.pageBaseUrl = "https://f.ly";
    const pid = K.base().page.page_id;
    const c = await C.create(K.base({ copies: { 111: `דירה יפה https://f.ly/p/${pid}\nשוב: https://f.ly/p/${pid}?x=1` } }), deps);
    const q = await M.queue(deps);
    const code = (copy) => { const m = [...copy.matchAll(new RegExp(`/p/${pid}/([a-z0-9]{6})`, "g"))].map((x) => x[1]); return m; };
    const c111 = code(q[0].copy), c222 = code(q[1].copy);
    assert.equal(c111.length, 2, "both links in the approved text are tagged");
    assert.equal(c111[0], c111[1], "with one code");
    assert.ok(!q[0].copy.includes(`/p/${pid} `) && !q[0].copy.includes(`/p/${pid}?`), "no untagged link left");
    assert.ok(c222.length >= 1, "the built text's link is tagged too");
    assert.notEqual(c111[0], c222[0], "each group its own code");
    const k = await require("./posting-attempts").getClick(c111[0]);
    assert.equal(k.campaign_id, c.id); assert.equal(k.group_id, "111"); assert.equal(k.page_id, pid);
    assert.equal(typeof k.attempt_key, "string", "attributionFor needs an attempt key");
    assert.equal(code((await M.queue(deps))[0].copy)[0], c111[0], "the same code when the list is drawn again");
    const later = new Date(Date.parse(k.expires_at) - K.DAY); // ours, nearly expired: the same code, 30 more days
    assert.equal(await require("./posting-attempts").issueManualClick({ key: k.attempt_key, campaign_id: c.id, page_id: pid, group_id: "111" }, later), c111[0]);
    assert.ok(Date.parse((await require("./posting-attempts").getClick(c111[0])).expires_at) > Date.parse(k.expires_at), "extended");
  }

  // ── the property card for the session header ──
  {
    const card = M.propertyCard(K.page("pg9"), "https://f.ly/");
    assert.equal(card.page_id, "pg9");
    assert.equal(card.page_url, "https://f.ly/p/pg9");
  }

  // ── skip reasons (the semi-automatic "הבא") ──
  {
    const { deps } = await K.setup();
    deps.env = { POSTING_MANUAL: "1", FORLY_ENV: "prod" };
    const c = await C.create(K.base({ repeat: true, repeat_days: 3, days: 14 }), deps);
    await K.db.savePage(K.page("pg2"));
    const c2 = await C.create(K.base({ page: K.page("pg2") }), deps);
    assert.equal(await M.skip(c.id, "111", "nonsense", deps), null, "an unknown reason records nothing");
    // pending_overload: out of this campaign, the agent's other one, and their default list; history stays.
    const s1 = await M.skip(c.id, "111", "pending_overload", deps, { ref: M.refOf(K.base().phone) });
    assert.deepEqual(s1.groups.map((g) => g.group_id), ["222"]);
    assert.equal(s1.posts.find((p) => p.group_id === "111").skip_reason, "pending_overload");
    assert.deepEqual((await K.store.getPostingCampaign(c2.id)).groups.map((g) => g.group_id), ["222"], "gone from the other campaign too");
    assert.deepEqual((await K.db.getConnection(K.base().phone)).posting_permission.default_group_ids, ["222"], "gone from the default list");
    // posting_method: skipped this pass, stays in the campaign (a repeat owes it again).
    const s2 = await M.skip(c.id, "222", "posting_method", deps);
    assert.deepEqual(s2.groups.map((g) => g.group_id), ["222"]);
    assert.equal(s2.status, "running", "a repeating campaign keeps running");
    const flags = await K.store.listGroupFlags();
    assert.deepEqual(flags.map((f) => [f.group_id, f.total]).sort(), [["111", 1], ["222", 1]]);
    assert.equal(flags.find((f) => f.group_id === "111").counts.pending_overload, 1);
    // other, a second time: counted, the note kept, newest first.
    await M.skip(c2.id, "222", "other", deps, { note: "צריך לענות על שאלות" });
    const f222 = (await K.store.listGroupFlags()).find((f) => f.group_id === "222");
    assert.equal(f222.total, 2); assert.equal(f222.recent[0].note, "צריך לענות על שאלות");
    // A campaign whose last group was removed has nowhere left to post: completed.
    const s3 = await M.skip(c2.id, "222", "pending_overload", deps);
    assert.equal(s3, null, "222 is no longer owed in c2 (skipped above)");
  }
  {
    const { deps } = await K.setup();
    deps.env = { POSTING_MANUAL: "1", FORLY_ENV: "prod" };
    const c = await C.create(K.base({ repeat: true, repeat_days: 3, days: 14 }), deps);
    await M.skip(c.id, "111", "pending_overload", deps);
    const done = await M.skip(c.id, "222", "pending_overload", deps);
    assert.equal(done.status, "completed", "no group left: completed even though it repeats");
  }

  console.log("posting-manual.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
