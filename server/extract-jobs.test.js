/* extract-jobs.js — the queued-scrape state machine. No network, no browser:
   resolve, parseListing and the store are fakes. */
process.env.FORLY_ENV = "local";
const assert = require("assert");
const J = require("./extract-jobs");

function fakeStore() {
  const jobs = new Map();
  return {
    jobs,
    saveExtractJob: async (j) => { jobs.set(j.id, JSON.parse(JSON.stringify(j))); },
    getExtractJob: async (id) => jobs.get(id) || null,
    updateExtractJob: async (id, patch) => { const j = jobs.get(id); if (j) Object.assign(j, patch); },
    listExtractJobsByStatus: async (s, limit = 10) => [...jobs.values()].filter((j) => j.status === s).slice(0, limit),
    conns: {},
    getConnection: async function (phone) { return this.conns[phone] || null; },
  };
}

(async () => {
  // ── create starts queued and never runs inline ──
  const store = fakeStore();
  const job = await J.create({ phone: "0500000000", url: "https://www.yad2.co.il/item/a" }, { db: store });
  assert.equal(job.status, "queued");
  assert.equal(job.attempts, 0);
  assert.equal(job.phone, "0500000000");
  assert.ok(job.id);

  // ── a successful run parses and stores fields, then goes done ──
  const deps = {
    db: store,
    resolve: async () => ({ source: "driver", text: "דירה", description: "דירה", photos: [{ url: "https://i/1.jpg", source: "driver" }] }),
    parseListing: async () => ({ fields: { city: "חיפה", price: 100 }, missing: ["rooms"] }),
  };
  const done = await J.runJob(job, deps);
  assert.equal(done.status, "done");
  assert.deepEqual(done.result.fields, { city: "חיפה", price: 100 });
  assert.deepEqual(done.result.missing, ["rooms"]);
  assert.deepEqual(done.result.photos, [{ url: "https://i/1.jpg", source: "driver" }]);
  assert.equal(done.error_code, null);

  // ── a blocked page escalates the browser type on each attempt, then fails ──
  const store2 = fakeStore();
  const job2 = await J.create({ phone: "p", url: "https://www.madlan.co.il/x" }, { db: store2 });
  const types = [];
  const blockDeps = {
    db: store2,
    resolve: async (input, d) => { types.push(d.browserType); const e = new Error("blocked"); e.code = "page_unreadable"; throw e; },
    parseListing: async () => ({ fields: {}, missing: [] }),
  };
  let j2 = job2;
  for (let i = 0; i < 3; i++) j2 = await J.runJob(await store2.getExtractJob(job2.id), blockDeps);
  assert.deepEqual(types, J.BROWSER_LADDER);
  assert.equal(j2.status, "failed");
  assert.equal(j2.error_code, "page_unreadable");
  assert.equal(j2.attempts, 3);

  // ── a login wall is terminal on the first attempt: retrying cannot help ──
  const store3 = fakeStore();
  const job3 = await J.create({ phone: "p", url: "https://www.facebook.com/groups/1/posts/2" }, { db: store3 });
  const wallDeps = {
    db: store3,
    resolve: async () => { const e = new Error("wall"); e.code = "social_login_required"; throw e; },
    parseListing: async () => ({ fields: {}, missing: [] }),
  };
  const j3 = await J.runJob(job3, wallDeps);
  assert.equal(j3.status, "failed");
  assert.equal(j3.error_code, "social_login_required");
  assert.equal(j3.attempts, 1, "no retry on a login wall");

  // ── 402/403 are terminal too, and the VENDOR code never becomes ours ──
  const store4 = fakeStore();
  const job4 = await J.create({ phone: "p", url: "https://www.yad2.co.il/item/b" }, { db: store4 });
  const brokeDeps = {
    db: store4,
    resolve: async () => { const e = new Error("no credits"); e.status = 402; e.code = "insufficient_credits"; throw e; },
    parseListing: async () => ({ fields: {}, missing: [] }),
  };
  const j4 = await J.runJob(job4, brokeDeps);
  assert.equal(j4.status, "failed");
  assert.equal(j4.error_code, "extract_unavailable", "vendor code must not leak");
  assert.equal(j4.attempts, 1);

  // ── a job stuck in "running" (crash before catch) is reaped, so the queue never wedges ──
  const store7 = fakeStore();
  await store7.saveExtractJob({ id: "stuck", phone: "p", url: "u", status: "running", attempts: 1, updated_at: new Date(Date.now() - 10 * 60000).toISOString() });
  await store7.saveExtractJob({ id: "dead", phone: "p", url: "u", status: "running", attempts: 3, updated_at: new Date(Date.now() - 10 * 60000).toISOString() });
  await J.reapStale({ db: store7 }, new Date());
  assert.equal((await store7.getExtractJob("stuck")).status, "queued");
  assert.equal((await store7.getExtractJob("dead")).status, "failed");

  // ── a job that needs a profile takes the per-phone lock, and yields while it is held ──
  const store8 = fakeStore();
  const locks = require("./profile-lock");
  const release = locks.acquire("p");
  const job8 = await J.create({ phone: "p", url: "https://www.facebook.com/groups/1/posts/2", profileName: "facebook-x" }, { db: store8 });
  const held = await J.runJob(job8, { db: store8, resolve: async () => { throw new Error("must not run while locked"); }, parseListing: async () => ({}) });
  assert.equal(held.status, "queued", "not attempted, not counted");
  assert.equal(held.attempts, 0);
  release();

  // ── sweep starts at most (cap - running) jobs ──
  const store5 = fakeStore();
  for (let i = 0; i < 5; i++) await J.create({ phone: "p", url: `https://www.yad2.co.il/item/${i}` }, { db: store5 });
  // updated_at must be fresh: reapStale runs first inside sweep, and a running
  // job with no updated_at looks like a pre-epoch ghost and gets requeued.
  await store5.saveExtractJob({ id: "busy", phone: "p", url: "u", status: "running", attempts: 1, updated_at: new Date().toISOString() });
  let started = 0;
  const swept = await J.sweep({
    db: store5, maxConcurrent: 3,
    runJob: async () => { started++; },
    resolve: async () => ({}), parseListing: async () => ({}),
  });
  assert.equal(swept, 2, "cap 3 minus 1 already running");
  assert.equal(started, 2);

  // ── forceSource rides through to resolve, for the firecrawl fallback ──
  const store6 = fakeStore();
  const job6 = await J.create({ phone: "p", url: "https://example.com/x", forceSource: "driver" }, { db: store6 });
  let sawForce = null, d6 = null;
  await J.runJob(job6, {
    db: store6,
    resolve: async (input, d) => { sawForce = d.forceSource; d6 = d; return { source: "driver", text: "t", description: "t", photos: [] }; },
    parseListing: async () => ({ fields: {}, missing: [] }),
  });
  assert.equal(sawForce, "driver");

  // ── a profile job holds the lock itself, and says so to withPage (via resolve) ──
  const store9 = fakeStore();
  const job9 = await J.create({ phone: "p9", url: "https://www.facebook.com/groups/1/posts/2", profileName: "facebook-x" }, { db: store9 });
  let d9 = null;
  await J.runJob(job9, {
    db: store9,
    resolve: async (input, d) => { d9 = d; assert.ok(require("./profile-lock").isHeld("p9", "facebook")); return { source: "driver", text: "t", description: "t", photos: [] }; },
    parseListing: async () => ({ fields: {}, missing: [] }),
  });
  assert.equal(d9.lockHeld, true);
  assert.equal(d9.phone, "p9");
  assert.equal(d9.platform, "facebook");
  // …and a public-page job holds nothing and claims nothing
  assert.equal(d6.lockHeld, false);
  assert.equal(d6.conn, null); assert.equal(d6.profileName, null);

  // ── I2: a profile job opens the CURRENT generation's profile, and hands the
  //    connection on (withPage refuses a revoked or quarantined one) ──
  {
    const { profileName } = require("./profile-name");
    const store10 = fakeStore();
    store10.conns.p10 = { facebook_profile_gen: 1 };
    const job10 = await J.create({ phone: "p10", url: "https://www.facebook.com/groups/1/posts/2", profileName: profileName("facebook", "p10", 0) }, { db: store10 });
    let d10 = null;
    await J.runJob(job10, { db: store10, resolve: async (input, d) => { d10 = d; return { source: "driver", text: "t", description: "t", photos: [] }; }, parseListing: async () => ({ fields: {}, missing: [] }) });
    assert.equal(d10.profileName, profileName("facebook", "p10", 1), "gen 1, not the name stored at creation");
    assert.deepEqual(d10.conn, { facebook_profile_gen: 1 });
  }

  console.log("extract-jobs.test.js ok");
})();
