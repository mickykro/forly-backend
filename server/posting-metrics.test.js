/* posting-metrics.js — one row per post that went out: visits and leads by
   the post's own attempt (R4), reactions/comments/visibility from the 24 h
   re-check; and the campaign card's view of them (publicView + GET
   /api/posting/campaigns/:id), which never leaks an attempt key or click id. */
const assert = require("assert");
const RK = require("./routes/posting-routes-kit");
const M = require("./posting-metrics");
const C = require("./posting-campaign");
const { publicView } = require("./routes/posting-shared");

const { K, PH, call } = RK;
const { db, store, NOW, HOUR, iso } = K;

async function attempt(id, click) {
  const r = await store.reserveAttempt({
    phone: PH, page_id: "pg1", target_type: "group", target_id: id, target_url: K.G(id), publisher: "browser",
    campaign_id: "camp", post_id: `p${id}`, click_id: click, now: NOW, limits: { daily_cap: 20, group_global_daily_cap: 20 },
  });
  return r.attempt;
}

(async () => {
  const env = await RK.setup();
  db.mem.portalEvents.length = 0; db.mem.leadSubmissions.length = 0;
  const c0 = await C.create(K.base(), env.deps);
  const a1 = await attempt("111", "1".repeat(32)), a2 = await attempt("222", "2".repeat(32));
  const posts = [
    { id: "p1", target: "group", group_id: "111", status: "posted", attempt_key: a1.key, posted_at: iso(NOW), post_url: `${K.G(111)}/posts/1/` },
    { id: "p2", target: "group", group_id: "222", status: "pending_group_approval", attempt_key: a2.key },
    { id: "p3", target: "group", group_id: "333", status: "scheduled", attempt_key: null },
    { id: "p4", target: "group", group_id: "444", status: "failed", attempt_key: "f".repeat(32) },
  ];
  const c = await store.mutatePostingCampaign(c0.id, () => ({ posts }));
  const ev = (key, campaign_id = c.id, type = "group_visit") => db.mem.portalEvents.push({ type, attempt_key: key, campaign_id, group_id: "111", at: new Date() });
  ev(a1.key); ev(a1.key); ev(a2.key); ev(a1.key, "other-campaign"); ev(a1.key, c.id, "phone_reveal");
  db.mem.portalEvents.push({ type: "group_visit", page_id: "pg1", share_session: "s", group_token: "g" }); // the manual kit: never counted
  db.mem.leadSubmissions.push({ prospect_phone: "972521111111", attribution: { campaign_id: c.id, attempt_key: a1.key, group_id: "111" } });
  db.mem.leadSubmissions.push({ prospect_phone: "972522222222" });
  await store.recordRecheck(a1.key, { visibility: "visible", reactions: 5, comments: 1, checked_at: iso(NOW.getTime() + 25 * HOUR), recheck_due_at: null }, NOW);

  // ── forCampaign ──
  const m = await M.forCampaign(c, env.deps);
  assert.deepEqual(m, {
    p1: { visits: 2, leads: 1, reactions: 5, comments: 1, visibility: "visible", checked_at: iso(NOW.getTime() + 25 * HOUR) },
    p2: { visits: 1, leads: 0, reactions: null, comments: null, visibility: null, checked_at: null },
  });
  assert.deepEqual(await M.forCampaign({ id: "x", posts: [] }, env.deps), {});
  // attempts are read concurrently, not one round trip after another
  let inFlight = 0, peak = 0;
  const slow = { getAttempt: async (k) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return store.getAttempt(k); } };
  assert.deepEqual(await M.forCampaign(c, { store: slow }), m);
  assert.equal(peak, 2, "both attempts in flight at once");

  // ── publicView: metrics for this campaign's posts only, whitelisted fields ──
  const leaky = Object.assign({}, m, { p1: Object.assign({}, m.p1, { attempt_key: a1.key, click_id: a1.click_id }), ghost: { visits: 9 } });
  const v = publicView(c, { metrics: leaky });
  assert.deepEqual(Object.keys(v.metrics).sort(), ["p1", "p2"]);
  assert.deepEqual(v.metrics.p1, m.p1);
  const s = JSON.stringify(v);
  assert.ok(!s.includes(a1.key) && !s.includes(a1.click_id) && !s.includes(a2.key), "no attempt key or click id");
  assert.equal(publicView(c).metrics, undefined);
  assert.equal([c].map(publicView)[0].metrics, undefined, ".map(publicView) passes an index, not metrics");

  // ── GET /api/posting/campaigns/:id carries them ──
  const r = await call(env.app, "GET", `/api/posting/campaigns/${c.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.campaign.metrics, m);
  assert.ok(!r.raw.includes(a1.key) && !r.raw.includes(a1.click_id), "the route leaks neither");

  console.log("posting-metrics.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
