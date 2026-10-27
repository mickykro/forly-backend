const assert = require("assert");
const db = require("../db");
const createRouter = require("./pages");
const old = db.getPage;
let page = {
  origin: "cold_outreach",
  status: "active",
  hero: { video_url: "private" },
};
db.getPage = async () => page;
const router = createRouter({
  baseUrl: "https://forly.example",
  pageBaseUrl: "https://forly.example",
  adminPhones: [],
  normalizeAuthPhone: (v) => v,
  requireAuth: () => () => {},
  callbackGuard: () => () => {},
});
async function call(routePath, req) {
  let code = 200,
    body;
  const route = router.stack.find((layer) => layer.route?.path === routePath);
  const res = {
    status(c) {
      code = c;
      return this;
    },
    json(v) {
      body = v;
      return this;
    },
    end() {
      return this;
    },
    set() {
      return this;
    },
  };
  await route.route.stack[0].handle(
    { query: {}, params: { id: "test" }, ...req },
    res,
  );
  return { code, body };
}
(async () => {
  try {
    assert.equal(
      (await call("/api/property-page", { query: { id: "test" } })).code,
      404,
    );
    assert.equal(
      (await call("/api/page", { query: { id: "test" } })).code,
      404,
    );
    assert.equal((await call("/p/:id", {})).code, 404);
    page = {
      visibility: "unlisted",
      status: "expired",
      property: { title: "Paid" },
      agent: { name: "Agent" },
    };
    assert.equal(
      (await call("/api/property-page", { query: { id: "test" } })).code,
      200,
      "normal unlisted pages remain readable",
    );
    const store = require("../outreach/store");
    const leadId = "a".repeat(64),
      pageId = "outreach-" + leadId;
    page = {
      ...page,
      page_id: pageId,
      listing_id: pageId,
      origin: "outreach_paid",
    };
    await store.transaction(async (tx) =>
      tx.set("leads", leadId, {
        id: leadId,
        status: "upgrading",
        paid_page_id: pageId,
      }),
    );
    assert.equal(
      (await call("/api/property-page", { query: { id: pageId } })).code,
      404,
      "uncommitted paid facts are private",
    );
    assert.equal((await call("/p/:id", { params: { id: pageId } })).code, 404);
    await store.transaction(async (tx) =>
      tx.set("leads", leadId, {
        id: leadId,
        status: "upgraded",
        paid_page_id: pageId,
      }),
    );
    assert.equal(
      (await call("/api/property-page", { query: { id: pageId } })).code,
      200,
      "committed paid page is readable",
    );
    console.log("legacy outreach page isolation tests passed");
  } finally {
    db.getPage = old;
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
