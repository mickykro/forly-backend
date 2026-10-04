#!/usr/bin/env node
/*
 * db.test.js — tests for db.js helpers against the in-memory branch.
 * Pure: no Firestore, no network. init() is never called, so `db` stays
 * null and every function takes its mem path.
 * Run: node server/db.test.js
 */
const assert = require("assert");
const db = require("./db");

const page = (id, phone, slug) => ({
  page_id: id, business_phone: phone, public_slug: slug, status: "active",
});

(async () => {
  await db.savePage(page("p1", "972501111111", "dira-herzl-12"));
  await db.savePage(page("p2", "972501111111", "penthouse-rotshild-5"));
  await db.savePage(page("p3", "972502222222", "dira-herzl-12"));

  // ── finds the page belonging to the given business ──
  let found = await db.findPageBySlug("972501111111", "dira-herzl-12");
  assert.ok(found, "should find a page that exists");
  assert.strictEqual(found.page_id, "p1");

  found = await db.findPageBySlug("972501111111", "penthouse-rotshild-5");
  assert.strictEqual(found.page_id, "p2");

  // ── never returns another agent's page with the same slug ──
  found = await db.findPageBySlug("972502222222", "dira-herzl-12");
  assert.strictEqual(found.page_id, "p3", "same slug, different owner, different page");

  // ── no match ⇒ null, not undefined and not a throw ──
  assert.strictEqual(await db.findPageBySlug("972501111111", "nope"), null);
  assert.strictEqual(await db.findPageBySlug("972509999999", "dira-herzl-12"), null);

  // ── no ceiling: a page beyond the old 100-doc scan window still resolves ──
  for (let i = 0; i < 150; i++) {
    await db.savePage(page(`bulk${i}`, "972503333333", `bulk-slug-${i}`));
  }
  found = await db.findPageBySlug("972503333333", "bulk-slug-149");
  assert.ok(found, "the 150th page must resolve; the old .find() over 100 docs missed it");
  assert.strictEqual(found.page_id, "bulk149");

  // ── profile_deletes: pending Driver-profile-deletion retries ──
  await db.savePendingDelete({ phone: "0500000000", platform: "yad2", since: "2026-09-01T00:00:00.000Z", attempts: 1, last_error: "503" });
  await db.savePendingDelete({ phone: "0500000000", platform: "facebook", since: "2026-09-02T00:00:00.000Z", attempts: 2, last_error: "timeout" });
  let pending = await db.listPendingDeletes();
  assert.equal(pending.length, 2);
  const yad2Row = pending.find((r) => r.platform === "yad2");
  assert.equal(yad2Row.phone, "0500000000");
  assert.equal(yad2Row.attempts, 1);
  assert.equal(yad2Row.last_error, "503");

  // ── re-saving the same phone+platform overwrites, not duplicates ──
  await db.savePendingDelete({ phone: "0500000000", platform: "yad2", since: "2026-09-01T00:00:00.000Z", attempts: 2, last_error: "503 again" });
  pending = await db.listPendingDeletes();
  assert.equal(pending.length, 2, "same phone+platform is one row");
  assert.equal(pending.find((r) => r.platform === "yad2").attempts, 2);

  // ── clearPendingDelete removes only that phone+platform ──
  await db.clearPendingDelete("0500000000", "yad2");
  pending = await db.listPendingDeletes();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].platform, "facebook");

  // ── clearing a row that isn't there is a harmless no-op ──
  await db.clearPendingDelete("0500000000", "yad2");
  assert.equal((await db.listPendingDeletes()).length, 1);

  // ── operator settings: compare-and-set ──
  assert.strictEqual(await db.getSetting("posting"), null, "no doc yet");
  let saved = await db.setSetting("posting", { enabled: true }, { expectVersion: 0 });
  assert.equal(saved.enabled, true);
  assert.equal(saved.version, 1);
  assert.ok(saved.updated_at);

  saved = await db.setSetting("posting", { enabled: false }, { expectVersion: 1 });
  assert.equal(saved.enabled, false);
  assert.equal(saved.version, 2, "version increments on every write");

  await assert.rejects(
    () => db.setSetting("posting", { enabled: true }, { expectVersion: 1 }),
    (e) => e.code === "version_conflict",
    "a stale expectVersion is refused",
  );
  const afterConflict = await db.getSetting("posting");
  assert.equal(afterConflict.enabled, false, "a rejected CAS write must not land");
  assert.equal(afterConflict.version, 2);

  // ── no expectVersion: always writes, still bumps version ──
  saved = await db.setSetting("posting", { platforms: { facebook: true } }, undefined);
  assert.equal(saved.version, 3);
  assert.equal(saved.enabled, false, "prior fields survive a partial-value write");

  console.log("db.test.js OK");
})().catch((err) => { console.error(err); process.exit(1); });
