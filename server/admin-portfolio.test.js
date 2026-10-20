/* Admin edits an agent's portfolio through the same code the agent's editor uses. */
const assert = require("assert");
const express = require("express");
const db = require("./db");

// Business docs are Firestore-only (no-ops in memory): a Map stands in for them.
const businesses = new Map();
db.getBusiness = async (phone) => (businesses.has(phone) ? JSON.parse(JSON.stringify(businesses.get(phone))) : null);
db.setBusiness = async (phone, data) => { businesses.set(phone, Object.assign({}, businesses.get(phone), data)); };

(async () => {
  await db.setBusiness("P1", { phone: "P1", business_name: "Agent One", full_name: "Dana" }, true);
  await db.savePage({ page_id: "pg1", listing_id: "L1", business_phone: "P1", status: "active", property: { title: "Flat" } });
  await db.savePage({ page_id: "pgX", listing_id: "LX", business_phone: "P2", status: "active", property: { title: "Not theirs" } });

  let who = { userId: "A1", admin: true };
  const requireAdmin = (req, res, next) => {
    if (!who.admin) return res.status(403).json({ error: "not_admin" });
    req.user = who; next();
  };
  const requireAuth = () => (req, res, next) => { req.user = { userId: who.userId }; next(); };
  const app = express();
  app.use(express.json());
  app.use("/api/admin", require("./routes/admin-portfolio")({ requireAdmin, normalizeAuthPhone: (p) => p }));
  app.use("/api", require("./routes/dashboard")({ requireAuth, authSecret: "s", pageBaseUrl: "https://pg", uploadDir: "/tmp" }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  // Admin: no portfolio yet → create one in the agent's name, then save it.
  let d = await (await fetch(base + "/admin/portfolio?phone=P1")).json();
  assert.deepEqual([d.phone, d.portfolio, d.profile.business_name, d.pages.map((p) => p.page_id)], ["P1", null, "Agent One", ["pg1"]]);
  assert.equal((await post("/admin/portfolio/create", { phone: "P404" })).status, 404, "no business doc minted for an unknown phone");
  const created = await (await post("/admin/portfolio/create", { phone: "P1" })).json();
  assert.equal(created.created, true);
  const saved = await post("/admin/portfolio", { phone: "P1", full_name: "Dana K",
    portfolio: { hero: { headline: "Haifa homes" }, properties: [{ page_id: "pg1", portfolio_visible: false }, { page_id: "pgX", portfolio_visible: false }] } });
  assert.equal(saved.status, 200);
  const biz = await db.getBusiness("P1");
  assert.equal(biz.full_name, "Dana K");
  assert.equal(biz.portfolio.hero.headline, "Haifa homes");
  assert.equal((await db.getPage("pg1")).portfolio_visible, false);
  assert.notEqual((await db.getPage("pgX")).portfolio_visible, false, "another agent's page is never touched");

  // The agent sees the admin's edit in their own editor.
  who = { userId: "P1", admin: false };
  d = await (await fetch(base + "/my-portfolio")).json();
  assert.equal(d.portfolio.hero.headline, "Haifa homes");
  assert.equal((await fetch(base + "/admin/portfolio?phone=P1")).status, 403, "agents cannot use the admin editor");
  assert.equal((await post("/admin/portfolio", { phone: "P1", full_name: "x" })).status, 403);

  server.close();
  console.log("admin-portfolio.test.js ok");
})().catch((err) => { console.error(err); process.exit(1); });
