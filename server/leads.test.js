/*
 * Unit tests for leads.js — the one lead writer.
 * Runs against db's in-memory store (db.init() is never called, so db.db is
 * null and everything lands in db.mem). Run: node server/leads.test.js
 */
const assert = require("assert");
const db = require("./db");
const { submitLead } = require("./leads");

const page = {
  page_id: "pg1", listing_id: "L1", business_phone: "972500000000",
  property: { title: "דירה" }, agent: { name: "דנה", phone: "972501112222" },
};
const reset = () => { db.mem.leads.clear(); db.mem.leadSubmissions.length = 0; };

// ── both docs written ──
(async () => {
  reset();
  await submitLead({ page, name: "יוסי", phone: "972521234567", source: "chat", questions: ["כלב?"] });
  assert.ok(db.mem.leads.get("972521234567"), "leads/{phone} written");
  assert.equal(db.mem.leadSubmissions.length, 1, "one lead_submission written");

  // ── source + questions thread through to the immutable record ──
  const sub = db.mem.leadSubmissions[0];
  assert.equal(sub.source, "chat");
  assert.deepEqual(sub.questions, ["כלב?"]);
  assert.equal(sub.prospect_phone, "972521234567");
  assert.equal(sub.property_title, "דירה");

  // ── status "converted" survives a later submission ──
  reset();
  db.mem.leads.set("972521234567", { status: "converted", phone: "972521234567" });
  await submitLead({ page, name: "יוסי", phone: "972521234567", source: "chat", questions: [] });
  assert.equal(db.mem.leads.get("972521234567").status, "converted", "converted not clobbered");

  // ── a fresh lead defaults to "new" ──
  reset();
  await submitLead({ page, name: "רות", phone: "972539876543", source: "landing_page", questions: [] });
  assert.equal(db.mem.leads.get("972539876543").status, "new");

  // ── missing phone is rejected before any write ──
  reset();
  await assert.rejects(() => submitLead({ page, name: "x", phone: "", source: "chat", questions: [] }));
  assert.equal(db.mem.leads.size, 0, "no leads/{phone} on rejection");
  assert.equal(db.mem.leadSubmissions.length, 0, "no lead_submission on rejection");

  console.log("leads.test.js ✓");
})().catch((e) => { console.error(e); process.exit(1); });
