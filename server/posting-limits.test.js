/* posting-limits.js — the manual tab's per-group limits (the same rule
   automatic posting uses) and the campaign duration estimate. */
const assert = require("assert");
const K = require("./posting-testkit");
const A = require("./posting-account");
const safety = require("./posting-safety");
const L = require("./posting-limits");

(async () => {
  const config = safety.configFrom(null, { FORLY_ENV: "prod" });
  const now = K.NOW;
  const at = (h) => new Date(now.getTime() - h * 3600000).toISOString();
  const camp = (id, page_id, posts) => ({ id, page_id, repeat_days: null, groups: [{ group_id: "111" }, { group_id: "222" }], posts });

  // three of the agent's posts in group 111 today → blocked; 222 free
  const others = [camp("c2", "pg2", [{ group_id: "111", status: "posted", posted_at: at(1) }]),
    camp("c3", "pg3", [{ group_id: "111", status: "posted", posted_at: at(2) }]),
    camp("c4", "pg4", [{ group_id: "111", status: "posted", posted_at: at(3) }])];
  const c1 = camp("c1", "pg1", []);
  const lim = L.limitsFor(c1, [c1].concat(others), now, config);
  assert.equal(lim["111"].today, 3);
  assert.equal(lim["111"].block.why, "group_daily_cap");
  assert.equal(lim["222"].block, null);

  // the same property in the same group a day ago → cooldown with an end time
  const again = camp("c1", "pg1", [{ group_id: "222", status: "posted", posted_at: at(24) }]);
  const lim2 = L.limitsFor(again, [again], now, config);
  assert.equal(lim2["222"].block.why, "property_cooldown");
  assert.ok(lim2["222"].block.until);

  // estimate: an established account, 200 posts → about 3 weeks, fits 30 days
  const { deps } = await K.setup();
  const conn = await K.db.getConnection("972500000001");
  const account = await A.accountView("972500000001", conn, deps, now);
  const e = L.estimate({ posts: 200, account, now, config, daysLeft: 30 });
  assert.equal(e.per_week, 64); assert.equal(e.days, 22); assert.equal(e.fits, true); assert.equal(e.warmup, false);
  // a new account in warm-up: far beyond 30 days
  const fresh = Object.assign({}, account, { first_connected_at: new Date(now.getTime() - 4 * K.DAY).toISOString() });
  const f = L.estimate({ posts: 200, account: fresh, now, config, daysLeft: 30 });
  assert.equal(f.warmup, true); assert.equal(f.fits, false);
  console.log("posting-limits.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
