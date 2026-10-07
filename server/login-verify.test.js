/* login-verify.js — the saved-login check: opens the agent's own current
   profile, marks connected only on a confirmed login, writes nothing
   otherwise, and never opens a browser for an agent already connected or a
   revoked profile. Yad2 keeps the page fake small (no Facebook reads). */
process.env.FORLY_ENV = "local";
process.env.PROFILE_KEY = "k";
const assert = require("assert");
const { verifySaved } = require("./login-verify");
const { profileNameFor } = require("./profile-name");

const PHONE = "0500000000";
function fakeDb(conn) {
  const writes = [];
  return { conn, writes, getConnection: async () => conn, setConnection: async (p, patch) => { writes.push(patch); Object.assign(conn, patch); } };
}
function fakePage({ url = "https://www.yad2.co.il/my-ads", text = "x".repeat(500), status = 200, title = "Dana Levi | יד2" } = {}) {
  return { goto: async () => ({ status: () => status }), innerText: async () => text, url: () => url, title: async () => title };
}
function fakeDriver(page, seen) {
  return { withPage: async (opts, fn, deps) => { seen.push({ opts, deps }); return fn(page); } };
}

(async () => {
  // ── logged in → connected, on the connection's own profile name ──
  {
    const db = fakeDb({ browser_consent_at: "2026-10-01T00:00:00Z", yad2_profile_gen: 1 });
    const seen = [];
    const r = await verifySaved(PHONE, "yad2", { db, driver: fakeDriver(fakePage(), seen) });
    assert.equal(r.state, "connected");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].opts.profile.name, profileNameFor("yad2", PHONE, { yad2_profile_gen: 1 }));
    assert.equal(seen[0].opts.profile.persist, true);
    assert.equal(seen[0].deps.phone, PHONE, "withPage gets the owner, so it takes the profile lock");
    assert.ok(db.conn.yad2_browser_connected_at, "marked connected");
    assert.equal(db.conn.browser_session_yad2, null);
  }

  // ── a login wall → not logged in, nothing written ──
  {
    const db = fakeDb({ browser_consent_at: "2026-10-01T00:00:00Z" });
    const r = await verifySaved(PHONE, "yad2", { db, driver: fakeDriver(fakePage({ url: "https://www.yad2.co.il/auth/login" }), []) });
    assert.equal(r.state, "not_logged_in");
    assert.equal(db.writes.length, 0);
  }

  // ── a broken check page proves nothing ──
  {
    const db = fakeDb({});
    const r = await verifySaved(PHONE, "yad2", { db, driver: fakeDriver(fakePage({ status: 404 }), []) });
    assert.equal(r.error, "cannot_verify_login");
    assert.equal(db.writes.length, 0);
  }

  // ── already connected / revoked: no browser at all ──
  for (const conn of [{ yad2_browser_connected_at: "2026-10-01T00:00:00Z" }, { yad2_profile_state: "revoked" }, { yad2_profile_state: "quarantined" }]) {
    const seen = [];
    const r = await verifySaved(PHONE, "yad2", { db: fakeDb(conn), driver: fakeDriver(fakePage(), seen) });
    assert.equal(seen.length, 0, JSON.stringify(conn));
    assert.ok(r.state === "connected" || r.error === "profile_revoked");
  }

  // ── a profile in use (login window open, a post) → busy, nothing written ──
  {
    const db = fakeDb({});
    const busy = { withPage: async () => { throw Object.assign(new Error("profile is busy"), { code: "profile_busy" }); } };
    assert.equal((await verifySaved(PHONE, "yad2", { db, driver: busy })).error, "profile_busy");
    assert.equal(db.writes.length, 0);
  }

  assert.equal((await verifySaved(PHONE, "nope", { db: fakeDb({}), driver: {} })).error, "invalid_input");
  console.log("login-verify.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
