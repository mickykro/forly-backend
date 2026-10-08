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

  // ── the property card for the session header ──
  {
    const card = M.propertyCard(K.page("pg9"), "https://f.ly/");
    assert.equal(card.page_id, "pg9");
    assert.equal(card.page_url, "https://f.ly/p/pg9");
  }

  console.log("posting-manual.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
