/* db.js — property draft helpers on the in-memory store. */
const assert = require("assert");
const db = require("./db");

(async () => {
  assert.equal(await db.getDraft("972500000001"), null);
  await db.saveDraft({ phone: "972500000001", status: "active", photos: [] });
  assert.equal((await db.getDraft("972500000001")).status, "active");
  await db.saveDraft({ phone: "972500000001", status: "building", photos: ["a"] });
  assert.deepEqual((await db.getDraft("972500000001")).photos, ["a"], "saveDraft replaces the whole doc");
  await db.deleteDraft("972500000001");
  assert.equal(await db.getDraft("972500000001"), null);
  await db.deleteDraft("972500000001"); // idempotent
  console.log("db-drafts.test.js ok");
})();
