const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createMemoryStore } = require("./store");
const { createService } = require("./service");
const { createAssets } = require("./assets");
const { createWorker } = require("./jobs");
const now = () => 1700000000000;
test("purge finds all owned assets beyond unrelated first 200 and removes only private owner files", async () => {
  const store = createMemoryStore(),
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "outreach-purge-"));
  try {
    await store.transaction(async (tx) => {
      tx.set("demos", "demo", { id: "demo", status: "expired" });
      for (let i = 0; i < 210; i++)
        tx.set("assets", "other" + i, { id: "other" + i, demo_id: "other" });
    });
    for (let i = 0; i < 205; i++) {
      const id = "owned" + i;
      const file = path.join(dir, id);
      await fs.writeFile(file, "x");
      await store.transaction(async (tx) =>
        tx.set("assets", id, { id, demo_id: "demo", path: file }),
      );
    }
    const assets = createAssets({
      storage: store,
      privateDir: dir,
      service: { active: () => false },
    });
    assert.equal(await assets.purge("demo"), 205);
    assert.equal((await store.list("assets", { demoId: "demo" })).length, 0);
    assert.equal((await store.get("assets", "other0")).demo_id, "other");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("worker reaches due job behind 200 future jobs", async () => {
  const store = createMemoryStore();
  await store.transaction(async (tx) => {
    for (let i = 0; i < 210; i++)
      tx.set("jobs", "future" + i, {
        id: "future" + i,
        status: "queued",
        type: "custom",
        due_at: new Date(now() + 10000).toISOString(),
      });
    tx.set("jobs", "due", {
      id: "due",
      status: "queued",
      type: "custom",
      due_at: new Date(now() - 10000).toISOString(),
    });
  });
  let called = 0;
  const worker = createWorker({
    store,
    now,
    handlers: { custom: async () => called++ },
  });
  await worker.tick();
  assert.equal(called, 1);
});
test("same contact claim retry preserves verified ownership and payment state", async () => {
  const store = createMemoryStore();
  const svc = createService({
    store,
    now,
    secret: "test-secret",
    config: { enabled: true, policyApproved: true },
  });
  const token = "token";
  await store.transaction(async (tx) => {
    tx.set("tokens", svc.tokenKey(token), { demo_id: "demo" });
    tx.set("demos", "demo", {
      id: "demo",
      lead_id: "lead",
      status: "active",
      expires_at: new Date(now() + 10000).toISOString(),
    });
    tx.set("leads", "lead", {
      id: "lead",
      status: "payment_pending",
      claim: { contact: "verified", ownership_verified: true },
      payment: { reference: "paid" },
    });
  });
  await svc.claimDemo(token, {}, { userId: "verified" });
  const l = await store.get("leads", "lead");
  assert.equal(l.status, "payment_pending");
  assert.equal(l.claim.ownership_verified, true);
  await store.transaction(async (tx) =>
    tx.set("leads", "lead", { ...l, status: "upgraded" }),
  );
  await assert.rejects(
    () =>
      svc.reconcilePayment(
        "lead",
        { payment_reference: "new", reconciliation_note: "x" },
        "admin",
      ),
    /invalid_state/,
  );
});
