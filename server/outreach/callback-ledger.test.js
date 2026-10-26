const assert = require("node:assert/strict");
const { createCallbackLedger } = require("./callback-ledger");
(async () => {
  let now = 1000;
  const ledger = createCallbackLedger({ now: () => now, leaseMs: 100 });
  const req = (id) => ({
    id,
    purpose: "overlay",
    day: "2026-10-26",
    maxDaily: 3,
    maxConcurrent: 1,
  });
  await assert.rejects(
    ledger.reserve({ ...req("invalid"), maxDaily: NaN }),
    /invalid_callback_budget/,
  );
  await assert.rejects(
    ledger.reserve({ ...req("invalid"), maxConcurrent: 0 }),
    /invalid_callback_budget/,
  );
  const first = await ledger.reserve(req("first"));
  assert(first);
  assert.equal(
    await ledger.reserve(req("first")),
    false,
    "replays cannot render twice",
  );
  assert.equal(
    await ledger.reserve(req("second")),
    false,
    "concurrent budget enforced",
  );
  await first.release();
  const second = await ledger.reserve(req("second"));
  assert(second);
  now += 101;
  const third = await ledger.reserve(req("third"));
  assert(third, "expired leases recover after process death");
  await second.release();
  await third.release();
  assert.equal(
    await ledger.reserve(req("fourth")),
    false,
    "daily budget survives completion",
  );
  console.log("callback-ledger tests passed");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
