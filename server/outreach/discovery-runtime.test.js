process.env.FORLY_ENV = "local";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { createRuntime } = require("./runtime");
const { createMemoryStore } = require("./store");
test("runtime worker scans groups and selects a post without an operator supplied URL", async () => {
  const store = createMemoryStore();
  let requested;
  const runtime = createRuntime({
    store,
    config: {
      enabled: true,
      policyApproved: true,
      groupScanEnabled: true,
      operatorPhone: "972500000001",
      secret: "test-only-secret-for-discovery-runtime",
      privateDir: "/tmp/forly-discovery-test",
    },
    database: {
      getConnection: async () => ({
        facebook_browser_connected_at: new Date().toISOString(),
      }),
    },
    reserve: async () => ({ release: async () => {} }),
    callbackGuard: () => (req, res, next) => next(),
    requireAdmin: (req, res, next) => next(),
    requireStepUp: (req, res, next) => next(),
    readGroups: async (args) => {
      requested = args;
      return {
        groups: [{ url: "https://facebook.com/groups/123/" }],
        posts: [
          {
            source_post_url: "https://facebook.com/groups/123/posts/456/",
            description:
              "דירה למכירה בתל אביב, 3 חדרים, 80 מטר רבוע, קומה 2, במחיר 2400000 שקל. דירה מוארת עם מרפסת ונוף פתוח.",
            images: [
              "https://cdn.example/1.jpg",
              "https://cdn.example/2.jpg",
              "https://cdn.example/3.jpg",
            ],
          },
        ],
        warnings: [],
        next_group_offset: 1,
      };
    },
    parseSource: async () => ({
      fields: {
        city: "Tel Aviv",
        rooms: 3,
        size_sqm: 80,
        price: 2400000,
        deal: "sale",
      },
    }),
  });
  const scan = await runtime.discovery.start(
    { idempotency_key: "runtime-once" },
    { id: "operator" },
  );
  await runtime.worker.tick();
  const status = await runtime.discovery.status(scan.id);
  assert.equal(status.status, "done");
  assert.equal(status.selected, 1);
  assert.equal(requested.phone, "972500000001");
  const lead = await runtime.service.getLead(status.candidate_ids[0]);
  assert.equal(lead.status, "needs_review");
  assert.equal(
    lead.source_post_url,
    "https://www.facebook.com/groups/123/posts/456/",
  );
  assert.equal(lead.facts.rooms, 3);
});
test("latest scan restoration uses newest creation time instead of hashed document order", async () => {
  const store = createMemoryStore();
  await store.transaction(async (tx) => {
    tx.set("scans", "scan_a", {
      id: "scan_a",
      kind: "scan",
      status: "done",
      created_at: "2026-10-25T00:00:00.000Z",
    });
    tx.set("scans", "scan_z", {
      id: "scan_z",
      kind: "scan",
      status: "running",
      created_at: "2026-10-26T00:00:00.000Z",
    });
  });
  const d = require("./discovery").createDiscovery({ store });
  assert.equal((await d.list({ limit: 1 })).scans[0].id, "scan_z");
});
