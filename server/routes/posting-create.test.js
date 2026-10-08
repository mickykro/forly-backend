/* routes/posting-create.js — the create-time checks the agent and admin APIs share. */
const assert = require("assert");
const K = require("../posting-testkit");
const PC = require("./posting-create");

(async () => {
  // validCreate
  assert.equal(PC.validCreate({ page_id: "pg1", mode: "standing", group_ids: ["111"] }).ids[0], "111");
  assert.equal(PC.validCreate({ page_id: "pg1", mode: "nope", group_ids: ["111"] }), null);
  assert.equal(PC.validCreate({ page_id: "pg1", mode: "standing", group_ids: ["111"], days: 31 }), null);
  assert.equal(PC.validCreate({ page_id: "pg1", mode: "standing", group_ids: ["111"], repeat_days: 2 }), null);

  // vetGroups: member gate, unknown gate, ok
  const conn = { facebook_groups_member: [K.member("111"), K.member("999")] };
  const page = K.page("pg1");
  const catalog = async () => [{ url: K.G(111), name: "A", agent_policy: "explicitly_allowed", listing_types: [] }];
  assert.deepEqual(await PC.vetGroups(catalog, conn, page, ["555"], false), { error: "not_member", group_ids: ["555"] });
  assert.deepEqual(await PC.vetGroups(catalog, conn, page, ["999"], false), { error: "unknown_group", group_ids: ["999"] });
  const ok = await PC.vetGroups(catalog, conn, page, ["111"], false);
  assert.equal(ok.groups.length, 1);
  assert.equal(ok.groups[0].group_id, "111");

  // campaignPermission / permActive
  const p = PC.campaignPermission(null, K.NOW, { admin_tail: "0009", method: "phone", note: "אישר בטלפון" });
  assert.equal(PC.permActive(p), true);
  assert.equal(p.granted_by, "0009");
  assert.deepEqual(p.consent_by, { by: "admin", admin_tail: "0009", method: "phone", note: "אישר בטלפון" }, "the admin's consent is on the permission too");
  assert.deepEqual(PC.campaignPermission(null, K.NOW).consent_by, { by: "agent" });
  assert.equal(PC.permActive(null), false);
  console.log("routes/posting-create.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
