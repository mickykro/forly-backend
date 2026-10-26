const test = require("node:test"),
  assert = require("node:assert/strict");
const { createPipeline } = require("./pipeline");
const { createMemoryStore } = require("./store");
const { readConfig } = require("./config");
async function seed(store, c, id, row) {
  await store.transaction(async (tx) => tx.set(c, id, row));
}
async function setup(reserve) {
  const store = createMemoryStore();
  await seed(store, "demos", "d", {
    id: "d",
    status: "active",
    photos: ["photo"],
    facts: { city: "test" },
  });
  await seed(store, "jobs", "video:d", {
    id: "video:d",
    demo_id: "d",
    type: "video",
    status: "queued",
  });
  let calls = 0;
  const pipeline = createPipeline({
    store,
    service: { active: (d) => d?.status === "active" },
    config: {
      enabled: true,
      policyApproved: true,
      secret: "x".repeat(32),
      callbackSecret: "y".repeat(32),
      baseUrl: "https://forly.example",
      webhook: "https://render.example",
    },
    reserve,
    fetchFn: async () => {
      calls++;
      return { ok: true };
    },
  });
  return {
    store,
    pipeline,
    get calls() {
      return calls;
    },
  };
}
test("video job cannot call paid provider without durable cost admission", async () => {
  const s = await setup(async () => false);
  await s.pipeline.handlers.video({ id: "video:d", demo_id: "d" });
  assert.equal(s.calls, 0);
});
test("video job admission is released and provider call is never retried", async () => {
  let released = 0;
  const s = await setup(async () => ({ release: async () => released++ }));
  await s.pipeline.handlers.video({ id: "video:d", demo_id: "d" });
  await s.pipeline.handlers.video({ id: "video:d", demo_id: "d" });
  assert.equal(s.calls, 1);
  assert.ok(released >= 1);
});
test("enabled config requires dedicated callbacks and secure public URL", () => {
  const env = {
    OUTREACH_ENABLED: "true",
    OUTREACH_HMAC_SECRET: "x".repeat(32),
    CALLBACK_HMAC_SECRET: "y".repeat(32),
    BASE_URL: "https://forly.example",
  };
  assert.equal(readConfig(env).baseUrl, "https://forly.example");
  assert.throws(
    () => readConfig({ ...env, CALLBACK_HMAC_SECRET: "" }),
    /CALLBACK/,
  );
  assert.throws(
    () => readConfig({ ...env, BASE_URL: "http://forly.example" }),
    /HTTPS/,
  );
});
test("supplied URL extraction queues once and requires dedicated connected lane", async () => {
  const store = createMemoryStore();
  await seed(store, "leads", "lead", {
    id: "lead",
    status: "captured",
    source_post_url: "https://www.facebook.com/groups/g/posts/1",
  });
  const config = {
    enabled: true,
    policyApproved: true,
    secret: "x".repeat(32),
    operatorPhone: "972501234567",
  };
  const pipeline = createPipeline({
    store,
    service: {},
    config,
    driverEnabled: () => true,
  });
  const first = await pipeline.startExtraction("lead", {}, { userId: "admin" });
  const second = await pipeline.startExtraction(
    "lead",
    {},
    { userId: "admin" },
  );
  assert.equal(first.job_id, second.job_id);
  assert.equal((await store.list("jobs")).length, 1);
  assert.equal((await store.get("leads", "lead")).status, "extracting");
  const disabled = createPipeline({
    store,
    service: {},
    config: { ...config, operatorPhone: "" },
    driverEnabled: () => true,
  });
  await assert.rejects(
    disabled.startExtraction("lead", {}, {}),
    /dedicated_operator_required/,
  );
});
test("missing budget adapter fails closed instead of generating video", async () => {
  const s = await setup(undefined);
  await s.pipeline.handlers.video({ id: "video:d", demo_id: "d" });
  assert.equal(s.calls, 0);
});
test("legacy parser fields normalize into reviewable outreach facts without invented property type", () => {
  const { normalizeFacts } = require("./pipeline");
  assert.deepEqual(
    normalizeFacts(
      {
        city: "חיפה",
        size_sqm: 90,
        deal: "sale",
        rooms: 4,
        price: 2000000,
        floor: 2,
      },
      "למכירה דירת גן מרווחת בחיפה",
    ),
    {
      location: "חיפה",
      area: 90,
      listing_type: "sale",
      rooms: 4,
      price: 2000000,
      floor: 2,
      property_type: "garden_apartment",
    },
  );
  assert.equal(
    normalizeFacts({ city: "Haifa" }, "Contact the advertiser for details")
      .property_type,
    undefined,
  );
});
test("extraction preserves dedicated profile ownership dependencies and source currency", async t => {
  const previousEnv = process.env.FORLY_ENV; process.env.FORLY_ENV = "local";
  t.after(() => { if (previousEnv === undefined) delete process.env.FORLY_ENV; else process.env.FORLY_ENV = previousEnv; });
  const store = createMemoryStore();
  await seed(store, "leads", "currency-lead", { id: "currency-lead", status: "captured", source_post_url: "https://www.facebook.com/groups/internal/posts/44/" });
  const phone = "972501234567";
  const conn = { facebook_browser_connected_at: new Date().toISOString(), facebook_profile_gen: 3 };
  let passed, ingested, released = 0;
  const pipeline = createPipeline({
    store,
    config: { enabled: true, policyApproved: true, secret: "test-purpose-key", operatorPhone: phone },
    driverEnabled: () => true,
    database: { getConnection: async value => { assert.equal(value, phone); return conn; } },
    reserve: async () => ({ release: async () => released++ }),
    extractSource: async (input, deps) => { passed = { input, deps }; return { text: "A reviewed apartment in Haifa for 285,000 EUR", photos: [{ url: "https://example.test/photo" }] }; },
    parseSource: async text => { assert.match(text, /EUR/); return { fields: { city: "Haifa", deal: "sale", price: 285000, currency: "EUR" } }; },
    service: { extract: async (id, data) => { assert.equal(id, "currency-lead"); ingested = data; } },
  });
  const job = await pipeline.startExtraction("currency-lead", {}, { userId: "admin" });
  await pipeline.handlers.extract({ id: job.job_id, lead_id: "currency-lead" });
  assert.equal(passed.deps.phone, phone);
  assert.equal(passed.deps.platform, "facebook");
  assert.equal(passed.deps.conn, conn);
  assert.equal(passed.deps.profileName, require("../profile-name").profileName("facebook", phone, 3));
  assert.equal(passed.deps.lockHeld, undefined, "Driver takes its own current profile/session lock");
  assert.equal(ingested.facts.currency, "EUR");
  assert.equal(ingested.facts.price, 285000);
  assert.equal(released, 1);
});
