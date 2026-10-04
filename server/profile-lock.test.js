/* profile-lock.js — phone+platform keying, owner-bound release, the Driver
   concurrency budget. No network, no timers beyond Date.now(). */
const assert = require("assert");
const L = require("./profile-lock");

(async () => {
  L._test.reset();

  // ── two platforms for one phone can be held at once ──
  const relFb = L.tryAcquire("05x", "facebook");
  const relYad2 = L.tryAcquire("05x", "yad2");
  assert.ok(relFb && relYad2, "different platforms do not contend");
  assert.ok(L.isHeld("05x", "facebook"));
  assert.ok(L.isHeld("05x", "yad2"));
  relFb();
  relYad2();
  assert.ok(!L.isHeld("05x", "facebook"));
  assert.ok(!L.isHeld("05x", "yad2"));

  // ── the same phone+platform cannot be held twice ──
  const first = L.tryAcquire("05y", "facebook");
  assert.ok(first);
  assert.equal(L.tryAcquire("05y", "facebook"), null, "held by the first caller");
  first();

  // ── acquire() throws with code === "profile_busy" when held ──
  const held = L.tryAcquire("05z", "facebook");
  assert.throws(() => L.acquire("05z", "facebook"), (e) => e.code === "profile_busy");
  held();
  assert.doesNotThrow(() => L.acquire("05z", "facebook")());

  // ── a stale release does not free a newer holder ──
  L._test.reset();
  const now0 = Date.now();
  const staleRelease = L.tryAcquire("05w", "facebook");
  assert.ok(staleRelease);
  // Simulate expiry by rewriting the held entry's `until` into the past —
  // the map is exposed via _test.held for exactly this.
  const entry = L._test.held.get("05w|facebook");
  entry.until = now0 - 1;
  assert.ok(!L.isHeld("05w", "facebook"), "expired");
  const newHolder = L.tryAcquire("05w", "facebook");
  assert.ok(newHolder, "a new holder can acquire after expiry");
  staleRelease(); // the old owner's release fires AFTER a new holder took the lock
  assert.ok(L.isHeld("05w", "facebook"), "the stale release must not free the new holder");
  newHolder();
  assert.ok(!L.isHeld("05w", "facebook"));

  // ── default platform is "facebook" ──
  const relDefault = L.tryAcquire("05v");
  assert.ok(L.isHeld("05v", "facebook"));
  assert.ok(!L.isHeld("05v", "yad2"));
  relDefault();

  // ── renew is owner-bound: a lapsed hold cannot extend its successor's ──
  {
    const old = L.tryAcquire("05r", "facebook");
    assert.equal(old.renew(), true);
    L._test.held.get("05r|facebook").until = Date.now() - 1;
    const next = L.tryAcquire("05r", "facebook");
    const until = L._test.held.get("05r|facebook").until;
    assert.equal(old.renew(), false, "the old owner cannot renew");
    assert.equal(L._test.held.get("05r|facebook").until, until);
    next();
  }

  // ── login browsers hold a Driver slot until stopped or expired ──
  {
    L._test.reset();
    process.env.DRIVER_MAX_CONCURRENT = "2";
    L.holdLogin("A"); L.holdLogin("B");
    assert.equal(L.trySession(), null, "two live logins fill a budget of 2");
    assert.ok(L.trySession({ except: "A" }), "replacing login A frees its slot");
    L._test.reset();
    L.holdLogin("A"); L.holdLogin("B");
    L.endLogin("A");
    assert.ok(L.trySession(), "a stopped login frees its slot");
    L._test.reset();
    L.holdLogin("A", Date.now() - L.LOGIN_SESSION_S * 1000); L.holdLogin("B", Date.now() - L.LOGIN_SESSION_S * 1000);
    assert.ok(L.trySession(), "an expired login frees its slot");
    delete process.env.DRIVER_MAX_CONCURRENT;
  }

  L._test.reset();
  console.log("profile-lock.test.js ok");
})();
