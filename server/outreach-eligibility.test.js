const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const { visiblePortfolioPages } = require("./portfolio");
const { isPrivateOutreach } = require("./outreach-eligibility");
const distribution = require("./distribution/jobs");
const posting = require("./posting-campaign");
test("portal and portfolio exclude outreach imported into ordinary page storage", async () => {
  const normal = {
    page_id: "outreach-test-normal",
    status: "active",
    business_phone: "test",
    created_at: new Date(),
  };
  const privatePage = {
    ...normal,
    page_id: "outreach-test-private",
    origin: "cold_outreach",
  };
  const unlisted = {
    ...normal,
    page_id: "outreach-test-unlisted",
    visibility: "unlisted",
  };
  for (const page of [normal, privatePage, unlisted]) await db.savePage(page);
  const portal = await db.listPublicPages();
  assert.ok(portal.some((p) => p.page_id === normal.page_id));
  assert.ok(!portal.some((p) => isPrivateOutreach(p)));
  assert.deepEqual(
    visiblePortfolioPages([normal, privatePage, unlisted]).map(
      (p) => p.page_id,
    ),
    [normal.page_id],
  );
});
test("distribution and browser posting refuse private preview before account access", async () => {
  const page = { page_id: "demo", origin: "cold_outreach", status: "active" };
  const methods = Object.keys(distribution);
  assert.ok(methods.includes("maybeOffer"));
  assert.deepEqual(await distribution.maybeOffer({}, page), {
    offered: false,
    reason: "private_preview",
  });
  await assert.rejects(
    posting.create({ page, phone: "test", consent: { at: new Date() } }, {}),
    /private preview/,
  );
});
