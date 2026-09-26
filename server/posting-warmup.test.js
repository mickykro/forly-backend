/* Warm-up browsing for a connected account with no running campaign
   (posting-tick.warmIdle, run by the sweep): from the day it connected,
   once per 20 h, in the background under the profile lock, never past the
   warm-up, never while a switch is off. */
const assert = require("assert");
const K = require("./posting-testkit");
const T = require("./posting-tick");
const Sw = require("./posting-sweeper");

const PH = "972500000001";
(async () => {
  const fresh = { facebook_browser_connected_at: K.iso(K.NOW.getTime() - 2 * K.HOUR), facebook_browser_first_connected_at: K.iso(K.NOW.getTime() - 2 * K.HOUR) };
  const dwellFor = (calls, held) => async (args, d) => { calls.push(args); held.push(K.locks.tryAcquire(PH, "facebook") === null); return { summary: {}, signal: "ok" }; };
  const settle = () => new Promise((r) => setTimeout(r, 20));

  // ── a fresh connection, nothing switched on: the sweep starts a browse ──
  {
    const { deps } = await K.setup(PH, { conn: fresh });
    const calls = [], held = [];
    Object.assign(deps, { dwell: dwellFor(calls, held) });
    await K.db.setSetting("posting", { enabled: true, platforms: { facebook: true } });
    Sw._test.reset();
    await Sw.sweep(deps, K.NOW);
    await settle();
    assert.equal(calls.length, 1, "warm-up browse started without any campaign");
    assert.equal(calls[0].note, "forly-dwell:");
    assert.deepEqual(held, [true], "the profile lock is held while it browses");
    const free = K.locks.tryAcquire(PH, "facebook");
    assert.ok(free, "and released after"); free();
    assert.equal(Sw.status().accounts.find((a) => a.phone === PH).outcome, "browse_started");
    const conn = await K.db.getConnection(PH);
    assert.ok(conn.last_browse_at, "recorded");
    // Not again within 20 h.
    assert.equal(await T.warmIdle(PH, deps, new Date(K.NOW.getTime() + 3 * K.HOUR)), "browse_only");
    await settle();
    assert.equal(calls.length, 1);
    // The next day, again.
    assert.equal(await T.warmIdle(PH, deps, new Date(K.NOW.getTime() + 21 * K.HOUR)), "browse_started");
    await settle();
    assert.equal(calls.length, 2);
  }

  // ── past the warm-up, not connected, a switch off: nothing ──
  {
    const { deps } = await K.setup(PH); // connected 90 days ago
    const calls = [];
    Object.assign(deps, { dwell: dwellFor(calls, []) });
    assert.equal(await T.warmIdle(PH, deps, K.NOW), "idle", "warm-up is over");
    await K.db.setConnection(PH, Object.assign({}, fresh, { facebook_browser_connected_at: null }));
    assert.equal(await T.warmIdle(PH, deps, K.NOW), "idle", "not connected");
    await K.db.setConnection(PH, fresh);
    await K.db.setSetting("posting", { enabled: false });
    Sw._test.reset();
    await Sw.sweep(deps, K.NOW);
    await settle();
    assert.equal(calls.length, 0, "the main switch off: no browse");
    assert.equal(Sw.status().last.result, "off");
  }
  console.log("posting-warmup.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
