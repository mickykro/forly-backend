const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { createRuntime } = require("./runtime");
const { createMemoryStore } = require("./store");
const { DAY } = require("./policy");

test("real domain + private manifests + HTTP public/paid routes complete lifecycle", async (t) => {
  const privateDir = await fs.mkdtemp(path.join(os.tmpdir(), "outreach-e2e-"));
  t.after(() => fs.rm(privateDir, { recursive: true, force: true }));
  let clock = Date.parse("2026-10-23T12:00:00Z");
  const store = createMemoryStore();
  const pages = new Map(),
    businesses = new Map(),
    listings = new Map();
  const database = {
    getPage: async (id) => pages.get(id) || null,
    savePage: async (page) => pages.set(page.page_id, page),
    getBusiness: async (phone) => businesses.get(phone) || null,
    setBusiness: async (phone, business) => businesses.set(phone, business),
    saveListing: async (listing) => listings.set(listing.listing_id, listing),
  };
  const runtime = createRuntime({
    config: {
      enabled: true,
      policyApproved: true,
      secret: "integration-purpose-key-for-outreach",
      privateDir,
      baseUrl: "https://example.test",
    },
    store,
    database,
    now: () => clock,
    callbackGuard: () => (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(),
    requireStepUp: (_req, _res, next) => next(),
    requireAuth: (_req, res) => res.status(401).end(),
    download: async () => ({
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0, 1, 2, 3, 4]),
      content_type: "image/jpeg",
    }),
  });
  const app = express();
  app.use(express.json());
  app.use(runtime.publicRouter);
  app.use(runtime.internal);
  const server = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const base = "http://127.0.0.1:" + server.address().port;
  const actor = { userId: "972501234567" };
  async function build(post) {
    const lead = await runtime.service.createLead(
      {
        source_post_url: `https://www.facebook.com/groups/internal/posts/${post}/`,
      },
      actor,
    );
    await runtime.service.extract(
      lead.id,
      {
        description:
          "A factual reviewed source property description for the internal test.",
        facts: {
          location: "Tel Aviv",
          property_type: "apartment",
          area: 80,
          rooms: 3,
        },
        images: [
          "https://example.test/1",
          "https://example.test/2",
          "https://example.test/3",
        ],
      },
      actor,
    );
    await runtime.service.reviewLead(
      lead.id,
      {
        facts_verified: true,
        right_to_use: true,
        evidence: "Internal approved fixture rights",
      },
      actor,
    );
    return { lead, demo: await runtime.service.buildDemo(lead.id, {}, actor) };
  }
  const { lead, demo } = await build(1);
  let response = await fetch(`${base}/api/outreach/demos/${demo.token}`);
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.photos.length, 3);
  assert.equal(preview.video_url, null);
  assert.ok(!JSON.stringify(preview).includes("source_post_url"));
  assert.equal((await fetch(base + preview.photos[0])).status, 200);
  const source = (await store.list("assets", { demoId: demo.id })).find(
    (a) => a.rendition === "source_private",
  );
  assert.equal(
    (
      await fetch(
        `${base}/api/outreach/assets/${source.id}?token=${demo.token}`,
      )
    ).status,
    404,
  );
  const fixture = path.join(privateDir, "fixture-video");
  await fs.writeFile(fixture, "private MP4 fixture bytes");
  const renders = await runtime.outreachAssets.registerRenditions({
    demoId: demo.id,
    renditions: [
      { rendition: "clean_paid", path: fixture },
      {
        rendition: "watermarked_demo",
        path: fixture,
        watermark_version: "forly-central-v1",
      },
    ],
  });
  const clean = renders.find((a) => a.rendition === "clean_paid");
  assert.equal(
    (await fetch(`${base}/api/outreach/paid-assets/${lead.id}/${clean.id}`))
      .status,
    404,
  );
  const ready = await (
    await fetch(`${base}/api/outreach/demos/${demo.token}`)
  ).json();
  assert.ok(ready.video_url);
  assert.ok(!JSON.stringify(ready).includes(clean.id));
  assert.equal((await fetch(base + ready.video_url)).status, 200);
  await runtime.service.approveDelivery(
    lead.id,
    {
      message: "Forly sample available for review",
      channel: "manual",
      sender: "authorized operator",
      recipient_identifier: "recipient",
      permitted_channel: true,
    },
    actor,
  );
  await runtime.service.confirmManualDelivery(
    lead.id,
    {
      evidence: "Operator confirmed manual send",
      sent_at: new Date(clock).toISOString(),
    },
    actor,
  );
  await runtime.service.claimDemo(demo.token, { acknowledged: true }, actor);
  await runtime.service.verifyClaim(
    lead.id,
    { evidence: "Source ownership reconciled", business_phone: actor.userId },
    actor,
  );
  await runtime.service.reconcilePayment(
    lead.id,
    {
      payment_reference: "external-reconciled-123",
      reconciliation_note: "Verified receipt against external payment ledger",
    },
    actor,
  );
  await runtime.service.upgradeDemo(
    lead.id,
    { idempotency_key: "upgrade-1", agent_name: "Verified agent" },
    actor,
  );
  assert.equal(
    (await fetch(`${base}/api/outreach/paid-assets/${lead.id}/${clean.id}`))
      .status,
    200,
  );
  assert.equal(
    (await fetch(`${base}/api/outreach/paid-assets/${lead.id}/${source.id}`))
      .status,
    404,
  );
  assert.equal((await fetch(base + ready.video_url)).status, 404);
  response = await fetch(`${base}/d/${demo.token}`, { redirect: "manual" });
  assert.equal(response.status, 302);
  const page = [...pages.values()][0];
  assert.equal(response.headers.get("location"), "/p/" + page.page_id);
  assert.equal(page.business_phone, actor.userId);
  assert.equal(page.agent.phone, actor.userId);
  assert.equal(page.property.city, "Tel Aviv");
  assert.equal(page.property.size_sqm, 80);
  assert.equal(page.cta.button_label, "תיאום ביקור");
  assert.equal(page.portfolio_visible, false);
  assert.equal(businesses.get(actor.userId).full_name, "Verified agent");
  await require("../leads").submitLead({
    page,
    name: "Buyer test",
    phone: "972509999999",
    source: "landing_page",
  });
  const buyer = await require("../db").getLead("972509999999");
  assert.equal(
    buyer.agent_phone,
    actor.userId,
    "buyer lead routes only to verified paid owner",
  );
  assert.equal(buyer.page_id, page.page_id);
  const unpaid = await build(2);
  const unpaidView = await runtime.service.getPublicDemo(unpaid.demo.token);
  clock += 7 * DAY;
  assert.equal((await fetch(`${base}/d/${unpaid.demo.token}`)).status, 410);
  assert.equal((await fetch(base + unpaidView.photos[0])).status, 404);
  await runtime.worker.tick();
  assert.equal((await store.get("demos", unpaid.demo.id)).status, "expired");
  assert.equal(
    (await fetch(`${base}/api/outreach/paid-assets/${lead.id}/${clean.id}`))
      .status,
    200,
    "paid entitlement survives demo expiry",
  );
});
