const test = require("node:test");
const assert = require("node:assert/strict");
const { createService } = require("./service");
const { createMemoryStore } = require("./store");
const { canonicalize, DAY } = require("./policy");
const { createWorker } = require("./jobs");
async function fixture() {
  let time = Date.parse("2026-10-23T12:00:00Z");
  const store = createMemoryStore();
  const service = createService({
    store,
    secret: "test-purpose-key",
    now: () => time,
    config: { enabled: true, policyApproved: true },
    prepareAssets: async (id) => {
      await store.transaction(async (tx) => {
        for (let i = 0; i < 3; i++)
          tx.set("assets", "photo" + i, {
            id: "photo" + i,
            demo_id: id,
            rendition: "website_asset",
          });
      });
      return ["photo0", "photo1", "photo2"];
    },
  });
  const actor = { userId: "verified-contact" };
  let lead = await service.createLead(
    {
      source_post_url:
        "https://m.facebook.com/groups/test/posts/123/?tracking=1",
    },
    actor,
  );
  await service.extract(
    lead.id,
    {
      description:
        "A sufficiently detailed property description from original source.",
      images: ["a", "b", "c"],
      facts: { location: "Tel Aviv", property_type: "apartment" },
    },
    actor,
  );
  await service.reviewLead(
    lead.id,
    {
      facts_verified: true,
      right_to_use: true,
      evidence: "approved internal test source",
    },
    actor,
  );
  const demo = await service.buildDemo(lead.id, {}, actor);
  return { store, service, lead, demo, actor, advance: (n) => (time += n) };
}
test("exact post normalization rejects non source and fingerprints retry", async () => {
  assert.equal(
    canonicalize("https://m.facebook.com/groups/g/permalink/12/?x=y"),
    "https://www.facebook.com/groups/g/posts/12/",
  );
  assert.throws(() => canonicalize("https://www.facebook.com/groups/g/"));
  const { service, lead } = await fixture();
  assert.equal(
    (
      await service.createLead(
        { source_post_url: "https://www.facebook.com/groups/test/posts/123/" },
        "admin",
      )
    ).id,
    lead.id,
  );
});
test("photo-first demo expires on exact seven-day instant and cannot revive", async () => {
  const f = await fixture();
  let view = await f.service.getPublicDemo(f.demo.token);
  assert.equal(view.video_ready, false);
  assert.equal(view.photos.length, 3);
  assert.ok(!JSON.stringify(view).includes("source_post_url"));
  f.advance(7 * DAY);
  assert.deepEqual(await f.service.getPublicDemo(f.demo.token), {
    status: "expired",
  });
  await assert.rejects(
    f.service.attachVideo(f.demo.id, { asset_id: "x" }, f.actor),
    /demo_inactive/,
  );
});
test("manual send approval, suppression, and concurrent exactly-once confirmation", async () => {
  const f = await fixture();
  await assert.rejects(f.service.deliveryKit(f.lead.id), /delivery_blocked/);
  await f.service.approveDelivery(
    f.lead.id,
    {
      message: "Forly preview",
      channel: "manual",
      sender: "operator",
      recipient_identifier: "recipient",
      permitted_channel: true,
    },
    f.actor,
  );
  const results = await Promise.all(
    [1, 2].map(() =>
      f.service.confirmManualDelivery(
        f.lead.id,
        { evidence: "operator sent", sent_at: "2026-10-23T12:00:00Z" },
        f.actor,
      ),
    ),
  );
  assert.equal(results[0].confirmed_at, results[1].confirmed_at);
  assert.equal(results[0].status, "manual_sent_confirmed");
  await f.service.suppressLead(f.lead.id, { reason: "opt out" }, f.actor);
  await assert.rejects(f.service.deliveryKit(f.lead.id), /delivery_blocked/);
});
test("forwarded token requires verified session then independent ownership approval", async () => {
  const f = await fixture();
  await assert.rejects(
    f.service.claimDemo(f.demo.token, { phone: "attacker" }, null),
    /verified_contact_required/,
  );
  await f.service.claimDemo(f.demo.token, {}, f.actor);
  await assert.rejects(
    f.service.reconcilePayment(
      f.lead.id,
      { payment_reference: "x", reconciliation_note: "reconciled" },
      f.actor,
    ),
    /verified_payment_required/,
  );
  await assert.rejects(
    f.service.verifyClaim(
      f.lead.id,
      { evidence: "x", business_phone: "someone_else" },
      f.actor,
    ),
    /ownership_evidence_required/,
  );
});
test("durable expiry schedules separate purge job and processes it", async () => {
  const f = await fixture();
  process.env.OUTREACH_HMAC_SECRET = "test-purpose-key";
  const purged = [];
  const worker = createWorker({
    store: f.store,
    service: f.service,
    now: () => Date.parse(f.demo.expires_at) + 31 * DAY,
    assets: { purge: async (id) => purged.push(id) },
  });
  f.advance(7 * DAY);
  await worker.tick();
  assert.equal(
    (await f.store.get("jobs", "purge:" + f.demo.id)).status,
    "queued",
  );
  await worker.tick();
  assert.equal(purged.length, 1);
  assert.equal((await f.store.get("leads", f.lead.id)).status, "deleted");
});
test("kill switch fails closed on new mutations", async () => {
  const service = createService({
    store: createMemoryStore(),
    secret: "x",
    config: { enabled: false },
  });
  await assert.rejects(
    service.createLead({
      source_post_url: "https://www.facebook.com/groups/a/posts/1/",
    }),
    /outreach_disabled/,
  );
});
