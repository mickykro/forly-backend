/* posting-modes.js: the admin's posting modes laid over the env. */
const assert = require("assert");
process.env.POSTING_MANUAL = "1"; delete process.env.POSTING_BURST;
const M = require("./posting-modes");

assert.deepEqual(M.clean({ manual: false, burst: "yes", nope: true }), { manual: false }, "known keys, booleans only");
M.apply({});
assert.equal(process.env.POSTING_MANUAL, "1", "nothing set: the env as it was");
process.env.POSTING_CAPS = "1"; M.apply({}); assert.equal(process.env.POSTING_CAPS, "1", "a mode the admin never set is never touched");
M.apply({ manual: false, burst: true });
assert.deepEqual([process.env.POSTING_MANUAL, process.env.POSTING_BURST], ["0", "1"], "the admin's choice wins");
assert.equal(require("./posting-manual").enabled(), false, "readers see it: automatic posting");
M.apply({ burst: true });
assert.equal(process.env.POSTING_MANUAL, "1", "cleared: the env's own value is back");
M.apply({});
assert.equal(process.env.POSTING_BURST, undefined, "cleared, and the env had none: unset again");
assert.deepEqual(M.view({ manual: true }).manual, { set: true, env: "1" });
assert.deepEqual(M.view({}).burst, { set: null, env: null });
(async () => {
  assert.deepEqual(await M.refresh({ getSetting: async () => ({ modes: { shots: false } }) }), { shots: false });
  assert.equal(process.env.POSTING_SHOTS, "0");
  assert.equal(await M.refresh({ getSetting: async () => { throw new Error("down"); } }), null, "a failed read keeps what is applied");
  assert.equal(process.env.POSTING_SHOTS, "0");
  console.log("posting-modes.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
