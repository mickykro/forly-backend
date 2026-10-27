const test = require("node:test"),
  assert = require("node:assert/strict");
const { createMemoryStore } = require("./store");
const { createService } = require("./service");
test("lead list paginates deterministically and returns redacted readiness", async () => {
  const store = createMemoryStore();
  const ids = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
  await store.transaction(async (tx) => {
    for (const id of ids)
      tx.set("leads", id, {
        id,
        status: "demo_active",
        demo_id: "d" + id,
        source_post_url: "SECRET",
        description: "SECRET",
        claim: { contact: "SECRET", ownership_verified: true },
        payment: { reference: "SECRET" },
      });
    tx.set("demos", "d" + ids[0], {
      id: "d" + ids[0],
      page_ready: true,
      video_ready: true,
      expires_at: "2030-01-01",
    });
  });
  const service = createService({ store, secret: "secret" });
  const first = await service.listLeads({ limit: 2 });
  assert.deepEqual(
    first.leads.map((l) => l.id),
    ids.slice(0, 2),
  );
  assert.equal(first.next_cursor, ids[1]);
  assert.equal(first.leads[0].video_ready, true);
  assert.ok(!JSON.stringify(first).includes("SECRET"));
  const next = await service.listLeads({ limit: 2, cursor: first.next_cursor });
  assert.deepEqual(
    next.leads.map((l) => l.id),
    ids.slice(2),
  );
  assert.equal(next.next_cursor, null);
  await assert.rejects(
    service.listLeads({ cursor: "invalid" }),
    /invalid_cursor/,
  );
});
test("fact corrections retain a reason and quality evaluates normalized facts", async () => {
  const store = createMemoryStore();
  const service = createService({
    store,
    secret: "test",
    config: { enabled: true, policyApproved: true },
  });
  const lead = await service.createLead(
    { source_post_url: "https://www.facebook.com/groups/test/posts/1/" },
    { userId: "admin" },
  );
  await service.extract(
    lead.id,
    {
      description:
        "An explicitly described property with more than thirty characters",
      images: ["1", "2", "3"],
      facts: { city: "Haifa" },
    },
    { userId: "operator" },
  );
  const corrected = await service.extract(
    lead.id,
    {
      description:
        "An explicitly described property with more than thirty characters",
      images: ["1", "2", "3"],
      facts: {
        location: "Haifa",
        property_type: "apartment",
        listing_type: "sale",
      },
      review_correction_reason: "Checked original source text",
    },
    { userId: "admin" },
  );
  assert.deepEqual(corrected.quality.reasons, []);
  assert.equal(corrected.facts.listing_type, "sale");
  assert.equal(
    corrected.correction_review.reason,
    "Checked original source text",
  );
  assert.ok(
    (await store.list("audit")).some((a) => a.action === "fact_correction"),
  );
});
