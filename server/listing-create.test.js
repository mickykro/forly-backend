/* listing-create.js retry + the dashboard archive/restore/retry routes, on the in-memory store. */
const assert = require("assert");
const express = require("express");
const db = require("./db");
const { buildFailed, retryBlocked, retryListing, BUILD_STUCK_MS, MAX_RETRIES } = require("./listing-create");

(async () => {
  const now = Date.now();
  const old = new Date(now - BUILD_STUCK_MS - 60000);

  // ── which builds count as failed ──
  assert.equal(buildFailed({ status: "failed", page_id: null }, now), true);
  assert.equal(buildFailed({ status: "active", page_id: null, created_at: old }, now), true, "no page past the timeout = failed");
  assert.equal(buildFailed({ status: "active", page_id: null, created_at: new Date(now) }, now), false, "still building");
  assert.equal(buildFailed({ status: "active", page_id: null, created_at: old, retried_at: new Date(now) }, now), false,
    "a retry restarts the clock");
  assert.equal(buildFailed({ status: "failed", page_id: "pg" }, now), false, "a page arrived after all");
  assert.equal(buildFailed({ status: "archived", page_id: null, created_at: old }, now), false);
  assert.equal(retryBlocked({ status: "failed", page_id: null, retry_count: MAX_RETRIES }, now), "retry_limit");
  assert.equal(retryBlocked({ status: "active", page_id: null, created_at: new Date(now) }, now), "still_building");
  assert.equal(retryBlocked({ status: "failed", page_id: null }, now), null);

  // ── retry replays the stored listing to the same webhook ──
  const hooks = [];
  const deps = { n8nWw1Webhook: "https://n8n/ww1", n8nPipelineWebhook: "https://n8n/pipe", baseUrl: "https://srv",
    fetchFn: async (url, opts) => { hooks.push([url, JSON.parse(opts.body)]); return { status: 200 }; } };
  await db.saveListing({ listing_id: "R1", business_phone: "P1", status: "failed", page_id: null, created_at: old,
    city: "חיפה", price: 1, rooms: 3, photos_urls: ["a", "b", "c"], own_video_url: null, language: "he" });
  await retryListing(await db.getListing("R1"), deps);
  const r1 = await db.getListing("R1");
  assert.deepEqual([r1.status, r1.retry_count], ["active", 1]);
  assert.equal(hooks[0][0], "https://n8n/ww1");
  assert.deepEqual([hooks[0][1].listing_id, hooks[0][1].image_urls, hooks[0][1].property_details.city], ["R1", ["a", "b", "c"], "חיפה"]);

  // ── routes: list splits archived, restore puts it back, retry is owner-only ──
  const createDashboardRouter = require("./routes/dashboard");
  const createIntakeRouter = require("./routes/intake");
  let who = "P1";
  const requireAuth = () => (req, res, next) => { req.user = { userId: who }; next(); };
  const app = express();
  app.use(express.json());
  // The router uses the real fetch, so the "n8n" webhook is this same server.
  app.post("/hook", (req, res) => { hooks.push(["/hook", req.body]); res.json({}); });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  app.use("/api", createIntakeRouter({ requireAuth, authSecret: "s", n8nWw1Webhook: base.replace(/\/api$/, "/hook") }));
  app.use("/api", createDashboardRouter({ requireAuth, authSecret: "s", pageBaseUrl: "https://pg", uploadDir: "/tmp" }));
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const list = async () => (await fetch(base + "/properties")).json();

  await db.savePage({ page_id: "pgL", listing_id: "L1", business_phone: "P1", status: "active", property: {}, view_count: 7 });
  await db.saveListing({ listing_id: "L1", business_phone: "P1", status: "active", page_id: "pgL", created_at: new Date(now), city: "חיפה", rooms: 4 });
  await db.saveListing({ listing_id: "L2", business_phone: "P1", status: "active", page_id: null, created_at: old, city: "חיפה", rooms: 2, photos_urls: ["x"] });

  let d = await list();
  const l2 = d.properties.find((p) => p.listing_id === "L2");
  assert.deepEqual([l2.page_status, l2.can_retry], ["failed", true], "a stuck build shows as failed with a retry");
  assert.equal(d.archived.length, 0);

  assert.equal((await post("/properties/delete", { listing_id: "L1", mode: "archive" })).status, 200);
  d = await list();
  assert.ok(!d.properties.some((p) => p.listing_id === "L1"), "archived leaves the main list");
  assert.deepEqual(d.archived.map((p) => [p.listing_id, p.page_status, p.view_count]), [["L1", "archived", 7]]);
  assert.equal((await db.getPage("pgL")).status, "archived");

  who = "P2";
  assert.equal((await post("/properties/restore", { listing_id: "L1" })).status, 403, "only the owner restores");
  assert.equal((await post("/properties/retry", { listing_id: "L2" })).status, 403, "only the owner retries");
  who = "P1";
  assert.equal((await post("/properties/restore", { listing_id: "L1" })).status, 200);
  assert.equal((await post("/properties/restore", { listing_id: "L1" })).status, 409, "not archived any more");
  assert.equal((await db.getListing("L1")).status, "active");
  assert.equal((await db.getPage("pgL")).status, "active", "the page is live again");

  // a failed build archived and restored is still a failed build
  await post("/properties/delete", { listing_id: "R1", mode: "archive" });
  await db.updateListing("R1", { status: "archived", archived_from: "failed" });
  await post("/properties/restore", { listing_id: "R1" });
  assert.equal((await db.getListing("R1")).status, "failed");

  hooks.length = 0;
  assert.equal((await post("/properties/retry", { listing_id: "L2" })).status, 200);
  assert.equal((await post("/properties/retry", { listing_id: "L2" })).status, 409, "a running retry is not doubled");
  for (let i = 0; i < 50 && !hooks.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(hooks.map((h) => h[1].listing_id), ["L2"]);
  assert.equal((await post("/properties/retry", { listing_id: "L1" })).status, 409, "a built listing has nothing to retry");

  // ── admin retry: any listing without a page, no agent cap, admins only ──
  const createAdminRouter = require("./routes/admin");
  let adminSession = { userId: "A1" };
  app.use("/api/admin", createAdminRouter({ verifySession: () => adminSession, readToken: () => "t", authSecret: "s",
    normalizeAuthPhone: (p) => p, adminPhones: ["A1"], pageBaseUrl: "https://pg", uploadDir: "/tmp",
    pipelineDeps: { n8nWw1Webhook: base.replace(/\/api$/, "/hook") } }));
  await db.saveListing({ listing_id: "AD1", business_phone: "P9", status: "failed", page_id: null, created_at: old,
    retry_count: MAX_RETRIES, city: "חיפה", rooms: 3, photos_urls: ["q"] });
  await db.saveListing({ listing_id: "AD2", business_phone: "P9", status: "active", page_id: null, created_at: new Date(now), city: "חיפה", rooms: 2, photos_urls: ["w"] });
  const props = (await (await fetch(base + "/admin/properties")).json()).properties;
  assert.deepEqual(["AD1", "AD2"].map((id) => props.find((p) => p.listing_id === id).page_status), ["failed", "building"]);
  adminSession = { userId: "P9" };
  assert.equal((await post("/admin/properties/retry", { listing_id: "AD1" })).status, 403, "agents cannot use the admin retry");
  adminSession = { userId: "A1" };
  hooks.length = 0;
  assert.equal((await post("/admin/properties/retry", { listing_id: "AD1" })).status, 200, "past the agent's cap");
  assert.equal((await post("/admin/properties/retry", { listing_id: "AD2" })).status, 200, "still building: allowed (the panel asks first)");
  assert.equal((await post("/admin/properties/retry", { listing_id: "L1" })).status, 409, "a built listing has nothing to retry");
  for (let i = 0; i < 50 && hooks.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(hooks.map((h) => h[1].listing_id).sort(), ["AD1", "AD2"]);
  assert.equal((await db.getListing("AD1")).retry_count, MAX_RETRIES + 1);

  server.close();
  console.log("listing-create.test.js ok");
})().catch((err) => { console.error(err); process.exit(1); });
