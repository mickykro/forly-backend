/* Creating a property in a client's name: the admin profile lookup, and the
   demo-create path never rewriting a real client's account. In-memory store. */
const assert = require("assert");
const express = require("express");
const db = require("./db");
// Business docs live only in Firestore (no-ops in memory mode): stand in a map.
const biz = new Map();
db.getBusiness = async (p) => (biz.has(p) ? { ...biz.get(p) } : null);
db.setBusiness = async (p, data, merge = true) => biz.set(p, merge ? { ...(biz.get(p) || {}), ...data } : { ...data });
const { normalizeAuthPhone } = require("./utils");

(async () => {
  const ADMIN = "972500000001";
  let session = { userId: ADMIN };
  const auth = { verifySession: () => session, readToken: () => "t", authSecret: "s", adminPhones: [ADMIN], normalizeAuthPhone };
  const app = express();
  app.use(express.json());
  app.use("/api/admin", require("./routes/admin")({ ...auth, pageBaseUrl: "https://pg", uploadDir: "/tmp" }));
  app.use("/api", require("./routes/intake")({ ...auth, requireAuth: () => (req, res, next) => next(), n8nWw1Webhook: null }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const get = (p) => fetch(base + p);
  const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  // ── profile lookup ──
  const CLIENT = "972521112233";
  const created = new Date("2025-01-01");
  await db.setBusiness(CLIENT, { phone: CLIENT, full_name: "איתי יעקב", business_name: "איתי יעקב נדל״ן", license_number: "123",
    logo_url: "https://f/logo.png", plan: "pro", paid: true, onboarding_state: "profile_started", source: "web_signup", created_at: created });
  const prof = await (await get("/admin/agent-profile?phone=0521112233")).json();
  assert.deepEqual(prof, { phone: CLIENT, full_name: "איתי יעקב", business_name: "איתי יעקב נדל״ן", license_number: "123", logo_url: "https://f/logo.png" });
  assert.equal((await get("/admin/agent-profile?phone=0529999999")).status, 404);
  session = { userId: CLIENT };
  assert.equal((await get("/admin/agent-profile?phone=" + CLIENT)).status, 403, "admins only");
  session = { userId: ADMIN };

  // ── creating for a real client leaves their account as it was ──
  const body = { city: "פתח תקווה", price: 3000000, rooms: 5, photos_urls: ["a", "b", "c"],
    agent: { name: "איתי יעקב", phone: CLIENT, brand_name: "איתי יעקב נדל״ן" } };
  const r = await post("/properties/demo-create", body);
  assert.equal(r.status, 200);
  const { listing_id } = await r.json();
  assert.equal((await db.getListing(listing_id)).business_phone, CLIENT, "the listing is the client's");
  const after = await db.getBusiness(CLIENT);
  assert.deepEqual([after.plan, after.paid, after.onboarding_state, after.source, +after.created_at],
    ["pro", true, "profile_started", "web_signup", +created], "a real (even half-onboarded) client is not turned into a demo account");

  // ── a brand-new phone still gets the demo account, as before ──
  const NEW = "972523334455";
  assert.equal((await post("/properties/demo-create", { ...body, agent: { name: "דמו", phone: NEW } })).status, 200);
  const demo = await db.getBusiness(NEW);
  assert.deepEqual([demo.source, demo.onboarding_state, demo.plan], ["demo", "demo_partial", "trial"]);

  // ── reopen a failed listing: read it back, recreate it, the old one is retired ──
  await db.saveListing({ listing_id: "11111111-1111-4111-8111-111111111111", business_phone: CLIENT, status: "failed", page_id: null,
    listing_type: "sale", city: "פתח תקווה", address: "העצמאות 95", rooms: 5, price: 3000000, size_sqm: 149, elevator: true,
    photos_urls: ["https://f/1.jpg", "https://f/2.jpg", "https://f/3.jpg"], description: "דירה", theme: { template: "atelier" } });
  const old = await (await get("/admin/listing?id=11111111-1111-4111-8111-111111111111")).json();
  assert.equal(old.business_phone, CLIENT);
  assert.deepEqual([old.fields.city, old.fields.rooms, old.fields.size_sqm, old.fields.elevator, old.fields.deal, old.template],
    ["פתח תקווה", 5, 149, true, "sale", "atelier"]);
  assert.deepEqual(old.photos, ["https://f/1.jpg", "https://f/2.jpg", "https://f/3.jpg"]);
  assert.equal((await get("/admin/listing?id=nope")).status, 404);

  const re = await post("/properties/demo-create", { ...body, replaces_listing_id: "11111111-1111-4111-8111-111111111111" });
  const newId = (await re.json()).listing_id;
  const retired = await db.getListing("11111111-1111-4111-8111-111111111111");
  assert.deepEqual([retired.status, retired.replaced_by], ["deleted", newId], "the failed listing leaves the lists");

  // never retires a listing with a page, or another client's
  await db.saveListing({ listing_id: "22222222-2222-4222-8222-222222222222", business_phone: CLIENT, status: "active", page_id: "pg1" });
  await db.saveListing({ listing_id: "33333333-3333-4333-8333-333333333333", business_phone: NEW, status: "failed", page_id: null });
  await post("/properties/demo-create", { ...body, replaces_listing_id: "22222222-2222-4222-8222-222222222222" });
  await post("/properties/demo-create", { ...body, replaces_listing_id: "33333333-3333-4333-8333-333333333333" });
  assert.equal((await db.getListing("22222222-2222-4222-8222-222222222222")).status, "active");
  assert.equal((await db.getListing("33333333-3333-4333-8333-333333333333")).status, "failed");

  server.close();
  console.log("admin-client.test.js ok");
})().catch((err) => { console.error(err); process.exit(1); });
