const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryStore } = require("./store");
const { createService } = require("./service");
const { createDiscovery } = require("./discovery");
const { createCallbackLedger } = require("./callback-ledger");
const config = {
  enabled: true,
  policyApproved: true,
  groupScanEnabled: true,
  secret: "discovery-purpose-secret",
  operatorPhone: "972501234567",
};
function post(
  id,
  description = "For sale apartment in Haifa with three bedrooms and a spacious balcony.",
  images = [
    "https://example.test/a",
    "https://example.test/b",
    "https://example.test/c",
  ],
) {
  return {
    source_post_url: `https://www.facebook.com/groups/internal/posts/${id}/`,
    description,
    images,
  };
}
async function fixture(options = {}) {
  const store = options.store || createMemoryStore();
  const service = createService({ store, config, secret: config.secret });
  const reserve = options.reserve || createCallbackLedger().reserve;
  const readCalls = [],
    parseCalls = [];
  const conn = {
    facebook_browser_connected_at: "2026-10-01",
    facebook_profile_gen: 2,
  };
  const discovery = createDiscovery({
    store,
    service,
    config,
    reserve,
    profileName: () => "operator-profile",
    database: {
      getConnection: async (phone) => {
        assert.equal(phone, config.operatorPhone);
        return conn;
      },
    },
    readGroups: async (args) => {
      readCalls.push(args);
      return (
        options.result || {
          groups: [
            {
              name: "Real estate",
              url: "https://www.facebook.com/groups/internal/",
            },
          ],
          posts: [
            post(1),
            post(
              2,
              "Looking for a dog walker nearby. This is not a property listing.",
            ),
            post(
              3,
              "Apartment for sale in Haifa, details available on request.",
              [],
            ),
          ],
          warnings: [],
        }
      );
    },
    parseSource: async (text) => {
      parseCalls.push(text);
      if (options.parseSource) return options.parseSource(text);
      return {
        fields: {
          city: "Haifa",
          deal: "sale",
          rooms: 3,
          size_sqm: 85,
          currency: "ILS",
        },
      };
    },
  });
  return { store, service, discovery, readCalls, parseCalls, conn };
}
test("duplicate starts enqueue once; automatically selects actual qualifying posts into needs_review", async () => {
  const f = await fixture();
  const input = {
    idempotency_key: "request-1",
    campaign_id: "pilot",
    max_groups: 999,
    max_posts: 999,
    max_candidates: 999,
    operator_phone: "attacker",
  };
  const [first, second] = await Promise.all([
    f.discovery.start(input, { userId: "admin" }),
    f.discovery.start(input, { userId: "admin" }),
  ]);
  assert.equal(first.id, second.id);
  assert.equal((await f.store.list("jobs")).length, 1);
  await f.discovery.handler({ id: "scan:" + first.id, scan_id: first.id });
  const status = await f.discovery.status(first.id);
  assert.equal(status.status, "done");
  assert.equal(status.posts_seen, 3);
  assert.equal(status.selected, 1);
  assert.equal(f.readCalls[0].phone, config.operatorPhone);
  assert.equal(f.readCalls[0].maxGroups, 3);
  assert.equal(f.readCalls[0].maxPosts, 20);
  assert.equal(f.parseCalls.length, 1);
  assert.equal(f.parseCalls[0], post(1).description);
  const lead = await f.service.getLead(status.candidate_ids[0]);
  assert.equal(lead.status, "needs_review");
  assert.equal(lead.source_post_url, post(1).source_post_url);
  assert.equal(lead.description, post(1).description);
  assert.ok(!JSON.stringify(status).includes("facebook.com"));
});
test("canonical source markers avoid repeated parsing across scan rounds and campaigns", async () => {
  const f = await fixture({
    result: {
      groups: [{}],
      posts: [
        post(1),
        {
          ...post(1),
          source_post_url:
            "https://m.facebook.com/groups/internal/permalink/1/?tracking=1",
        },
      ],
      warnings: [],
    },
  });
  for (const campaign of ["first", "second"]) {
    const scan = await f.discovery.start(
      { idempotency_key: campaign, campaign_id: campaign },
      {},
    );
    await f.discovery.handler({ id: scan.id, scan_id: scan.id });
  }
  assert.equal(f.parseCalls.length, 1);
  assert.equal((await f.store.list("leads")).length, 1);
});
test("global concurrent budget fails closed and unknown reader outcome is terminal without retry", async () => {
  const f = await fixture({ reserve: async () => false });
  const scan = await f.discovery.start({ idempotency_key: "blocked" }, {});
  await f.discovery.handler({ scan_id: scan.id });
  assert.equal((await f.discovery.status(scan.id)).status, "blocked");
  assert.equal(f.readCalls.length, 0);
  const g = await fixture();
  const unknown = createDiscovery({
    store: g.store,
    service: g.service,
    config,
    reserve: createCallbackLedger().reserve,
    profileName: () => "operator-profile",
    database: { getConnection: async () => g.conn },
    readGroups: async () => {
      throw Object.assign(new Error("timeout raw private content"), {
        code: "ETIMEDOUT",
      });
    },
  });
  const pending = await unknown.start({ idempotency_key: "unknown" }, {});
  await unknown.handler({ scan_id: pending.id });
  await unknown.handler({ scan_id: pending.id });
  assert.equal((await unknown.status(pending.id)).status, "outcome_unknown");
});
test("no description or photos are fabricated when parser omits required listing facts", async () => {
  const f = await fixture({
    result: { groups: [{}], posts: [post(9)], warnings: [] },
    parseSource: async () => ({ fields: {} }),
  });
  const scan = await f.discovery.start({}, {});
  await f.discovery.handler({ scan_id: scan.id });
  const status = await f.discovery.status(scan.id);
  assert.equal(status.selected, 0);
  assert.equal(status.reasons.required_facts_missing, 1);
  assert.equal((await f.store.list("leads")).length, 0);
});
test("campaign group cursor advances and distinct workers share a durable concurrent admission", async () => {
  const store = createMemoryStore();
  let releaseReader;
  const pendingReader = new Promise((resolve) => (releaseReader = resolve));
  const reserve = createCallbackLedger().reserve;
  const service = createService({ store, config, secret: config.secret });
  let reads = 0;
  const offsets = [];
  const common = {
    store,
    service,
    config,
    reserve,
    profileName: () => "operator-profile",
    database: {
      getConnection: async () => ({
        facebook_browser_connected_at: "connected",
      }),
    },
    parseSource: async () => ({ fields: {} }),
  };
  const discovery = createDiscovery({
    ...common,
    readGroups: async (args) => {
      reads++;
      offsets.push(args.groupOffset);
      if (reads === 1) await pendingReader;
      return { groups: [{}], posts: [], next_group_offset: 3, warnings: [] };
    },
  });
  const first = await discovery.start({ idempotency_key: "one" }, {});
  const firstRunning = discovery.handler({ scan_id: first.id });
  while (reads === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = await discovery.start({ idempotency_key: "two" }, {});
  await discovery.handler({ scan_id: second.id });
  assert.equal((await discovery.status(second.id)).status, "blocked");
  assert.equal(reads, 1);
  releaseReader();
  await firstRunning;
  const third = await discovery.start({ idempotency_key: "three" }, {});
  await discovery.handler({ scan_id: third.id });
  assert.deepEqual(offsets, [0, 3]);
  const listed = await discovery.list();
  assert.equal(listed.scans.length, 3);
  assert.ok(listed.scans.every((scan) => scan.id.startsWith("scan_")));
});
test("interrupted scan is reconciled as unknown without repeating a Driver call", async () => {
  const f = await fixture();
  const scan = await f.discovery.start({ idempotency_key: "interrupted" }, {});
  await f.store.transaction(async (tx) => {
    const current = await tx.get("scans", scan.id);
    tx.set("scans", scan.id, {
      ...current,
      status: "running",
      started_at: new Date(Date.now() - 11 * 60000).toISOString(),
    });
  });
  await f.discovery.handler({ scan_id: scan.id });
  assert.equal((await f.discovery.status(scan.id)).status, "outcome_unknown");
  assert.equal(f.readCalls.length, 0);
});
test("hard candidate cap parses only five highest ranked real posts", async () => {
  const posts = Array.from({ length: 25 }, (_, i) =>
    post(
      i + 10,
      "Apartment for sale in Haifa. " +
        "Source property details. ".repeat(i + 2),
    ),
  );
  const f = await fixture({
    result: {
      groups: [{}, {}, {}, {}],
      posts,
      warnings: [
        "login_warning",
        "raw private profile URL https://facebook.com/person",
      ],
    },
  });
  const scan = await f.discovery.start(
    { idempotency_key: "bounded", max_candidates: 1000, max_posts: 1000 },
    {},
  );
  await f.discovery.handler({ scan_id: scan.id });
  const status = await f.discovery.status(scan.id);
  assert.equal(status.posts_seen, 20);
  assert.equal(status.groups_visited, 3);
  assert.equal(f.parseCalls.length, 5);
  assert.equal(status.selected, 5);
  assert.deepEqual(status.warnings, ["login_warning"]);
  const descriptions = status.candidate_ids.map(
    async (id) => (await f.service.getLead(id)).description,
  );
  assert.ok(
    (await Promise.all(descriptions)).every((description) =>
      posts.some((p) => p.description.trim() === description),
    ),
  );
});
test("discovery kill switch rejects starts before creating durable jobs", async () => {
  const store = createMemoryStore();
  const discovery = createDiscovery({
    store,
    config: { ...config, groupScanEnabled: false },
  });
  await assert.rejects(discovery.start({}, {}), /discovery_disabled/);
  assert.equal((await store.list("jobs")).length, 0);
});
test("terminal scan changed while parser waits cannot create candidates or be overwritten", async () => {
  const f = await fixture();
  let resolveParse, started;
  const entered = new Promise((resolve) => (started = resolve));
  const pending = new Promise((resolve) => (resolveParse = resolve));
  const d = createDiscovery({
    store: f.store,
    config,
    reserve: createCallbackLedger().reserve,
    database: { getConnection: async () => f.conn },
    profileName: () => "operator-profile",
    readGroups: async () => ({ groups: [{}], posts: [post(77)], warnings: [] }),
    parseSource: async () => {
      started();
      return pending;
    },
  });
  const scan = await d.start({ idempotency_key: "terminal-parse" }, {});
  const running = d.handler({ scan_id: scan.id });
  await entered;
  await f.store.transaction(async (tx) => {
    const row = await tx.get("scans", scan.id);
    tx.set("scans", scan.id, {
      ...row,
      status: "outcome_unknown",
      error_code: "operator_stopped",
    });
  });
  resolveParse({ fields: { city: "Haifa", property_type: "apartment" } });
  await running;
  assert.equal((await f.store.list("leads")).length, 0);
  assert.equal((await d.status(scan.id)).error_code, "operator_stopped");
});
test("kill during parser wait blocks commits; scan exposes stable code only", async () => {
  const f = await fixture();
  const local = { ...config };
  let resolveParse, started;
  const entered = new Promise((resolve) => (started = resolve)),
    pending = new Promise((resolve) => (resolveParse = resolve));
  const d = createDiscovery({
    store: f.store,
    config: local,
    reserve: createCallbackLedger().reserve,
    database: { getConnection: async () => f.conn },
    profileName: () => "operator-profile",
    readGroups: async () => ({ groups: [{}], posts: [post(78)], warnings: [] }),
    parseSource: async () => {
      started();
      return pending;
    },
  });
  const scan = await d.start({ idempotency_key: "kill-parse" }, {});
  const running = d.handler({ scan_id: scan.id });
  await entered;
  local.groupScanEnabled = false;
  resolveParse({ fields: { city: "Haifa", property_type: "apartment" } });
  await running;
  assert.equal((await f.store.list("leads")).length, 0);
  assert.equal((await d.status(scan.id)).status, "blocked");
  assert.equal((await d.status(scan.id)).error_code, "discovery_disabled");
});
test("login and checkpoint failures keep allowlisted codes without private provider messages", async () => {
  for (const code of [
    "group_scan_login_required",
    "group_scan_checkpoint",
    "group_scan_captcha",
  ]) {
    const f = await fixture();
    const d = createDiscovery({
      store: f.store,
      config,
      reserve: createCallbackLedger().reserve,
      database: { getConnection: async () => f.conn },
      profileName: () => "operator-profile",
      readGroups: async () => {
        throw Object.assign(
          new Error("private phone and provider credentials"),
          { code },
        );
      },
    });
    const scan = await d.start({ idempotency_key: code }, {});
    await d.handler({ scan_id: scan.id });
    const status = await d.status(scan.id);
    assert.equal(status.error_code, code);
    assert.equal(status.status, "blocked");
    assert.ok(!JSON.stringify(status).includes("private phone"));
  }
});
test("parser finishing after scan deadline cannot commit a candidate", async () => {
  const f = await fixture();
  let resolveParse,
    releases = 0;
  const pending = new Promise((resolve) => (resolveParse = resolve));
  const d = createDiscovery({
    store: f.store,
    config,
    timeouts: { parserMs: 5, totalMs: 20 },
    reserve: async () => ({ release: async () => releases++ }),
    database: { getConnection: async () => f.conn },
    profileName: () => "operator-profile",
    readGroups: async () => ({ groups: [{}], posts: [post(79)], warnings: [] }),
    parseSource: async () => pending,
  });
  const scan = await d.start({ idempotency_key: "timed-parse" }, {});
  await d.handler({ scan_id: scan.id });
  resolveParse({ fields: { city: "Haifa", property_type: "apartment" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.store.list("leads")).length, 0);
  assert.equal((await d.status(scan.id)).status, "outcome_unknown");
  assert.equal((await d.status(scan.id)).error_code, "scan_timeout");
  assert.equal(
    releases,
    0,
    "unknown provider retains slot until durable lease expires",
  );
});
