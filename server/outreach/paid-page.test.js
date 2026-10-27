const test = require("node:test"),
  assert = require("node:assert/strict");
const { createPaidProvisioner } = require("./paid-page");
const { createMemoryStore } = require("./store");
test("paid provision is stable and only publishes gated asset routes for verified payments", async () => {
  const pages = new Map(),
    listings = new Map(),
    businesses = new Map();
  const store = createMemoryStore();
  const db = {
    getPage: async (id) => pages.get(id),
    savePage: async (p) => pages.set(p.page_id, p),
    saveListing: async (l) => listings.set(l.listing_id, l),
    getBusiness: async (id) => businesses.get(id),
    setBusiness: async (id, b) => businesses.set(id, b),
  };
  const provision = createPaidProvisioner({ database: db, store });
  const lead = {
    id: "lead",
    demo_id: "demo",
    claim: { ownership_verified: true, contact: "972501234567" },
    payment: { reference: "receipt" },
    demo: {
      id: "demo",
      lead_id: "lead",
      photos: ["photo"],
      facts: { city: "Haifa", rooms: 3, currency: "EUR" },
      title: "Preview",
    },
  };
  await store.transaction(async (tx) => {
    tx.set("demos", "demo", lead.demo);
    tx.set("assets", "photo", {
      id: "photo",
      demo_id: "demo",
      rendition: "website_asset",
    });
    tx.set("assets", "clean", {
      id: "clean",
      demo_id: "demo",
      rendition: "clean_paid",
    });
  });
  const first = await provision(lead, { agent_name: "Agent" });
  const second = await provision(lead, { agent_name: "Agent" });
  assert.deepEqual(first, second);
  assert.equal(pages.size, 1);
  assert.equal(listings.size, 1);
  const page = pages.get(first.page_id);
  assert.match(page.hero.video_url, /\/api\/outreach\/paid-assets\//);
  assert.equal(page.visibility, "unlisted");
  assert.equal(page.property.currency, "EUR", "paid property retains reviewed source currency");
  assert.equal(listings.get(first.page_id).currency, "EUR");
  assert.equal(page.distribution_eligible, false);
  await assert.rejects(
    provision({ ...lead, payment: null }, {}),
    /verified_payment/,
  );
});
