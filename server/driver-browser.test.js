/* driver-browser.js — session lifecycle and the error policy. No network:
   fetch and connectOverCDP are stubbed. */
process.env.FORLY_ENV = "local"; // notes are scoped by it; pin it
const assert = require("assert");
const D = require("./driver-browser");

const ok = (body) => ({ ok: true, status: 200, json: async () => body, headers: { get: () => null } });
const err = (status, body, retryAfter) => ({
  ok: false, status, statusText: "e", json: async () => body || {},
  headers: { get: (h) => (h.toLowerCase() === "retry-after" && retryAfter ? String(retryAfter) : null) },
});

// Expected failure logs, kept off the test output.
async function quiet(fn) {
  const orig = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = orig; }
}

(async () => {
  // ── 402 and 403 are reported immediately, never retried ──
  for (const status of [402, 403]) {
    let calls = 0;
    const fetchFn = async () => { calls++; return err(status, { error: "nope", code: "x" }); };
    await assert.rejects(
      D.createSession({}, { fetchFn, apiKey: "k", sleep: async () => {} }),
      (e) => e instanceof D.DriverError && e.status === status,
    );
    assert.equal(calls, 1, `${status} must not loop`);
  }

  // ── 503 backs off, capped at 5 attempts, then reports ──
  let calls503 = 0; const slept = [];
  const fetch503 = async () => { calls503++; return err(503, { code: "browser_capacity_unavailable" }, 2); };
  await assert.rejects(
    D.createSession({}, { fetchFn: fetch503, apiKey: "k", sleep: async (ms) => slept.push(ms), random: () => 0 }),
    (e) => e.status === 503,
  );
  assert.equal(calls503, 6, "1 initial + 5 retries");
  assert.deepEqual(slept, [2000, 4000, 6000, 8000, 10000]);

  // ── 504 and 500 retry exactly once, then succeed ──
  for (const status of [504, 500]) {
    let n = 0;
    const fetchFn = async () => (++n === 1 ? err(status, {}) : ok({ sessionId: "s1", status: "active", cdpUrl: "ws://x" }));
    const s = await D.createSession({}, { fetchFn, apiKey: "k", sleep: async () => {} });
    assert.equal(s.sessionId, "s1");
    assert.equal(n, 2);
  }

  // ── stopSession never throws, so a finally cannot mask the real error ──
  await quiet(() => D.stopSession("s1", { fetchFn: async () => err(500, {}), apiKey: "k", sleep: async () => {} }));

  // ── withPage stops the session even when fn throws ──
  const stopped = [];
  const deps = {
    apiKey: "k", sleep: async () => {}, random: () => 0,
    fetchFn: async (url, init) => {
      if ((init && init.method) === "DELETE") { stopped.push(url); return ok({ success: true }); }
      if ((init && init.method) === "POST") return ok({ sessionId: "s2", status: "active", cdpUrl: "ws://y" });
      return ok({ sessionId: "s2", status: "completed", cdpUrl: null, bandwidthBytes: 10 });
    },
    connectOverCDP: async () => ({
      contexts: () => [{ pages: () => [{ marker: "page" }] }],
      close: async () => {},
    }),
  };
  await assert.rejects(D.withPage({}, async () => { throw new Error("boom"); }, deps), /boom/);
  assert.equal(stopped.length, 1);
  assert.ok(stopped[0].includes("sessionId=s2"));

  // ── withPage reuses the first context and page, and returns fn's value ──
  const got = await D.withPage({}, async (page) => page.marker, deps);
  assert.equal(got, "page");

  // ── every session is Israeli, whatever the caller passed ──
  let sent = null;
  await D.createSession({ duration: 60 }, { fetchFn: async (u, init) => { sent = JSON.parse(init.body); return ok({ sessionId: "s3", status: "active", cdpUrl: "ws://z" }); }, apiKey: "k", sleep: async () => {} });
  assert.equal(sent.country, "IL"); assert.equal(sent.timezone, "Asia/Jerusalem"); assert.equal(sent.language, "he-IL");
  await D.createSession({ country: "DE" }, { fetchFn: async (u, init) => { sent = JSON.parse(init.body); return ok({ sessionId: "s3", status: "active", cdpUrl: "ws://z" }); }, apiKey: "k", sleep: async () => {} });
  assert.equal(sent.country, "IL", "a caller cannot opt out of Israel");

  // ── the dev registry knows every live session, and is empty when the flag is off ──
  D._test.setDevView(true);
  const seen = [];
  await D.withPage({ note: "forly-connect:facebook" }, async () => {
    const list = D.liveSessions();
    seen.push(list.map((x) => x.sessionId));
    assert.ok(!JSON.stringify(list).includes("ws://"), "liveSessions never carries the cdpUrl");
    assert.ok(!list.some((x) => "cdpUrl" in x));
    assert.equal(list[0].platform, "facebook", "parsed from the env-scoped note");
    assert.equal(list[0].note, "forly-local-connect:facebook");
    assert.equal(list[0].viewer_available, true);
    return 1;
  }, deps);
  assert.deepEqual(seen, [["s2"]]);
  assert.deepEqual(D.liveSessions(), [], "removed after stop");
  D._test.setDevView(false);
  await D.withPage({}, async () => { seen.push(D.liveSessions()); }, deps);
  assert.deepEqual(seen[1], [], "no registry when the flag is off");

  // ── every note is scoped by FORLY_ENV at create time; callers never see it ──
  let sentNote = null;
  const noteFetch = async (u, init) => { sentNote = JSON.parse(init.body).note; return ok({ sessionId: "n1", status: "active", cdpUrl: "ws://n" }); };
  await D.createSession({ note: "forly-extract:job-9" }, { fetchFn: noteFetch, apiKey: "k", sleep: async () => {} });
  assert.equal(sentNote, "forly-local-extract:job-9");
  await D.createSession({ note: "forly-local-extract:job-9" }, { fetchFn: noteFetch, apiKey: "k", sleep: async () => {} });
  assert.equal(sentNote, "forly-local-extract:job-9", "already scoped → unchanged");
  await D.createSession({ note: "someone-else" }, { fetchFn: noteFetch, apiKey: "k", sleep: async () => {} });
  assert.equal(sentNote, "someone-else");
  process.env.FORLY_ENV = "bogus";
  await D.createSession({ note: "forly-extract:job-9" }, { fetchFn: noteFetch, apiKey: "k", sleep: async () => {} });
  assert.equal(sentNote, "forly-extract:job-9", "invalid env → unscoped (Driver is off then anyway)");
  process.env.FORLY_ENV = "local";

  // ── a staging boot's cleanup never touches prod's (or unscoped) sessions ──
  process.env.FORLY_ENV = "staging";
  const envDeleted = [];
  const envDeps = {
    apiKey: "k", sleep: async () => {},
    fetchFn: async (url, init) => {
      if ((init && init.method) === "DELETE") { envDeleted.push(url); return ok({ success: true }); }
      if (!url.includes("status=active")) return ok({ sessions: [] });
      return ok({ sessions: [
        { sessionId: "prod1", note: "forly-prod-connect:facebook" },
        { sessionId: "stg1", note: "forly-staging-connect:facebook" },
        { sessionId: "old1", note: "forly-connect:facebook" },
        { sessionId: "stgx", note: "forly-staging-extract:1" },
      ] });
    },
  };
  assert.equal(await D.cleanupOrphans("forly-connect:", envDeps), 1);
  assert.equal(envDeleted.length, 1);
  assert.ok(envDeleted[0].includes("sessionId=stg1"));
  process.env.FORLY_ENV = "local";

  // ── cleanupOrphans stops only our own notes ──
  const deleted = [];
  const cleanupDeps = {
    apiKey: "k", sleep: async () => {},
    fetchFn: async (url, init) => {
      if ((init && init.method) === "DELETE") { deleted.push(url); return ok({ success: true }); }
      if (url.includes("status=active")) return ok({ sessions: [{ sessionId: "a", note: "forly-local-extract:1" }, { sessionId: "b", note: "someone-else" }] });
      return ok({ sessions: [{ sessionId: "c", note: "forly-local-extract:2" }] });
    },
  };
  assert.equal(await D.cleanupOrphans("forly-extract:", cleanupDeps), 2);
  assert.ok(deleted.some((u) => u.includes("sessionId=a")));
  assert.ok(deleted.some((u) => u.includes("sessionId=c")));
  assert.ok(!deleted.some((u) => u.includes("sessionId=b")));

  // ── attachPage joins a RUNNING session and must not stop it ──
  const stops = [];
  const attachDeps = {
    apiKey: "k", sleep: async () => {},
    fetchFn: async (url, init) => {
      if ((init && init.method) === "DELETE") { stops.push(url); return ok({ success: true }); }
      return ok({ sessionId: "s9", status: "active", cdpUrl: "ws://z" });
    },
    connectOverCDP: async () => ({ contexts: () => [{ pages: () => [{ marker: "live" }] }], close: async () => {} }),
  };
  assert.equal(await D.attachPage("s9", async (p) => p.marker, attachDeps), "live");
  assert.equal(stops.length, 0, "attachPage must leave the session running");

  // ── deleteProfile never throws, and reports ok/error so revoke() can record it ──
  const okDel = await D.deleteProfile("facebook-local-aaaa", { apiKey: "k", fetchFn: async () => ok({ success: true }) });
  assert.deepEqual(okDel, { ok: true });
  const failDel = await quiet(() => D.deleteProfile("facebook-local-aaaa", { apiKey: "k", fetchFn: async () => err(503, { error: "busy" }) }));
  assert.equal(failDel.ok, false);
  assert.ok(failDel.error);

  // ── a 404 (already deleted — e.g. a prior delete succeeded but its
  //    response was lost) is success, not a failure to retry forever ──
  const goneDel = await D.deleteProfile("facebook-local-aaaa", { apiKey: "k", fetchFn: async () => err(404, { error: "not found" }) });
  assert.equal(goneDel.ok, true);
  assert.equal(goneDel.already_gone, true);

  // ── redact masks cdp urls, viewer params and profile names ──
  const PROFILE = "facebook-prod-0123456789abcdef0123";
  const red = D.redact(`a wss://node/abc b ws://x/y c https://viewer.driver.dev?ws=wss%3A%2F%2Fn d ${PROFILE}-r2 e yad2-local-0123456789abcdef0123`);
  assert.ok(!/wss?:\/\//.test(red), red);
  assert.ok(!red.includes("wss%3A"), red);
  assert.ok(!red.includes("0123456789abcdef0123"), red);
  assert.ok(red.includes("[cdp]") && red.includes("ws=[cdp]") && red.includes("[profile]"), red);

  // ── stop failures are logged redacted, with the session id shortened ──
  const logged = [];
  const origErr = console.error;
  console.error = (m) => logged.push(String(m));
  try {
    await D.stopSession("session-abcdef123456", { apiKey: "k", fetchFn: async () => err(500, { error: `gone wss://node/zz ${PROFILE}` }) });
  } finally { console.error = origErr; }
  assert.equal(logged.length, 1);
  assert.ok(!logged[0].includes("session-abcdef"), logged[0]);
  assert.ok(logged[0].includes("123456"), logged[0]);
  assert.ok(!logged[0].includes("wss://") && !logged[0].includes(PROFILE), logged[0]);

  // ── viewer grants: single use, operator-bound, 5-minute expiry ──
  process.env.FORLY_ENV = "local";
  D._test.setDevView(true);
  let clock = 1_000_000;
  D._test.setNow(() => clock);
  const liveCdp = "wss://node/live-1";
  const liveDeps = Object.assign({}, deps, {
    fetchFn: async (url, init) => {
      if ((init && init.method) === "DELETE") return ok({ success: true });
      return ok({ sessionId: "live1", status: "active", cdpUrl: liveCdp });
    },
  });
  let grantChecks = null;
  await D.withPage({ note: "forly-extract:job" }, async () => {
    assert.equal(D.mintViewerGrant("nope", { operator: "972500000001" }), null, "not live → null");
    const g = D.mintViewerGrant("live1", { operator: "972500000001" });
    assert.ok(/^[0-9a-f]{32}$/.test(g.id));
    assert.equal(g.expiresAt, clock + 5 * 60 * 1000);
    assert.ok(!JSON.stringify(g).includes("wss"), "the grant itself carries no url");
    const url = D.consumeViewerGrant(g.id, "972500000001");
    assert.equal(url, "https://viewer.driver.dev?ws=" + encodeURIComponent(liveCdp));
    assert.equal(D.consumeViewerGrant(g.id, "972500000001"), null, "single use");

    const other = D.mintViewerGrant("live1", { operator: "972500000001" });
    assert.equal(D.consumeViewerGrant(other.id, "972500000002"), null, "another operator cannot use it");
    assert.equal(D.consumeViewerGrant(other.id, "972500000001"), null, "and the attempt burns it");

    const late = D.mintViewerGrant("live1", { operator: "972500000001" });
    clock += 5 * 60 * 1000 + 1;
    assert.equal(D.consumeViewerGrant(late.id, "972500000001"), null, "expired");
    grantChecks = D.mintViewerGrant("live1", { operator: "972500000001" });
  }, liveDeps);
  assert.equal(D.consumeViewerGrant(grantChecks.id, "972500000001"), null, "session no longer live");
  D._test.setNow(null);
  D._test.setDevView(false);

  // ── withPage with a profile: phone/platform, ownership, the profile lock, the budget ──
  const locksReal = require("./profile-lock");
  const names = require("./profile-name");
  locksReal._test.reset();
  const PH = "972500000009";
  const own = names.profileName("facebook", PH);
  let created = 0;
  const countDeps = (extra) => Object.assign({}, deps, {
    fetchFn: async (url, init) => {
      if ((init && init.method) === "POST") created++;
      return deps.fetchFn(url, init);
    },
  }, extra);
  const prof = { profile: { name: own, persist: true } };

  await assert.rejects(D.withPage(prof, async () => 1, countDeps({})), (e) => e.code === "invalid_input");
  await assert.rejects(D.withPage(prof, async () => 1, countDeps({ phone: PH })), (e) => e.code === "invalid_input");
  await assert.rejects(
    D.withPage({ profile: { name: names.profileName("facebook", "972500000008"), persist: true } }, async () => 1, countDeps({ phone: PH, platform: "facebook" })),
    (e) => e.code === "profile_ownership",
  );
  await assert.rejects(
    D.withPage(prof, async () => 1, countDeps({ phone: PH, platform: "facebook", conn: { facebook_profile_state: "revoked" } })),
    (e) => e.code === "profile_ownership",
  );
  assert.equal(created, 0, "refused before any session is created");

  const holder = locksReal.acquire(PH, "facebook");
  await assert.rejects(D.withPage(prof, async () => 1, countDeps({ phone: PH, platform: "facebook" })), (e) => e.code === "profile_busy");
  assert.equal(created, 0);
  // lockHeld: the caller already holds it — no acquire, ownership still asserted
  assert.equal(await D.withPage(prof, async () => "ok", countDeps({ phone: PH, platform: "facebook", lockHeld: true })), "ok");
  assert.ok(locksReal.isHeld(PH, "facebook"), "the caller's lock is not released by withPage");
  await assert.rejects(
    D.withPage({ profile: { name: "facebook-local-ffffffffffffffffffff", persist: true } }, async () => 1, countDeps({ phone: PH, platform: "facebook", lockHeld: true })),
    (e) => e.code === "profile_ownership",
  );
  holder();

  // lock and budget are released even when fn throws
  await assert.rejects(D.withPage(prof, async () => {
    assert.ok(locksReal.isHeld(PH, "facebook"));
    assert.equal(locksReal.activeSessions(), 1);
    throw new Error("boom2");
  }, countDeps({ phone: PH, platform: "facebook" })), /boom2/);
  assert.equal(locksReal.isHeld(PH, "facebook"), false);
  assert.equal(locksReal.activeSessions(), 0);

  // lock and budget are released when the session cannot even be created
  await assert.rejects(D.withPage(prof, async () => 1, Object.assign({}, deps, { phone: PH, platform: "facebook", fetchFn: async () => err(402, {}) })),
    (e) => e.status === 402);
  assert.equal(locksReal.isHeld(PH, "facebook"), false);
  assert.equal(locksReal.activeSessions(), 0);

  // injected fakes: lockHeld never touches tryAcquire
  let acquired = 0;
  const fakeLocks = { tryAcquire: () => { acquired++; return () => {}; }, trySession: () => () => {} };
  const fakeNames = { assertOwnership: () => {} };
  await D.withPage({ profile: { name: "x" } }, async () => 1, countDeps({ phone: PH, platform: "facebook", lockHeld: true, locks: fakeLocks, names: fakeNames }));
  assert.equal(acquired, 0);
  await D.withPage({ profile: { name: "x" } }, async () => 1, countDeps({ phone: PH, platform: "facebook", locks: fakeLocks, names: fakeNames }));
  assert.equal(acquired, 1);

  // the local concurrency budget: exhausted → DriverError 429, before any session
  const before = created;
  const noBudget = { tryAcquire: () => () => {}, trySession: () => null };
  await assert.rejects(D.withPage({}, async () => 1, countDeps({ locks: noBudget })), (e) => e instanceof D.DriverError && e.status === 429);
  assert.equal(created, before);
  // …and the profile lock taken before it is given back
  let profileReleased = false;
  await assert.rejects(D.withPage(prof, async () => 1, countDeps({
    phone: PH, platform: "facebook", names: fakeNames,
    locks: { tryAcquire: () => () => { profileReleased = true; }, trySession: () => null },
  })), (e) => e.status === 429);
  assert.ok(profileReleased);

  // ── attachPage: with a phone it takes the profile lock (unless held) and the budget ──
  const busyHolder = locksReal.acquire(PH, "yad2");
  await assert.rejects(D.attachPage("s9", async () => 1, Object.assign({}, attachDeps, { phone: PH, platform: "yad2" })), (e) => e.code === "profile_busy");
  assert.equal(await D.attachPage("s9", async (p) => p.marker, Object.assign({}, attachDeps, { phone: PH, platform: "yad2", lockHeld: true })), "live");
  busyHolder();
  await assert.rejects(D.attachPage("s9", async () => 1, Object.assign({}, attachDeps, { phone: PH })), (e) => e.code === "invalid_input");
  await assert.rejects(D.attachPage("s9", async () => { throw new Error("boom3"); }, Object.assign({}, attachDeps, { phone: PH, platform: "yad2" })), /boom3/);
  assert.equal(locksReal.isHeld(PH, "yad2"), false);
  assert.equal(locksReal.activeSessions(), 0);
  await assert.rejects(D.attachPage("s9", async () => 1, Object.assign({}, attachDeps, { locks: noBudget })), (e) => e.status === 429);

  // ── driverEnabled: all three secrets, and a valid FORLY_ENV ──
  const saved = { k: process.env.DRIVER_API_KEY, p: process.env.PROFILE_KEY, e: process.env.FORLY_ENV };
  Object.assign(process.env, { DRIVER_API_KEY: "k", PROFILE_KEY: "p", FORLY_ENV: "local" });
  assert.equal(D.driverEnabled(), true);
  process.env.FORLY_ENV = "production";
  assert.equal(D.driverEnabled(), false);
  process.env.FORLY_ENV = "prod"; delete process.env.PROFILE_KEY;
  assert.equal(D.driverEnabled(), false);
  process.env.PROFILE_KEY = "p"; delete process.env.DRIVER_API_KEY;
  assert.equal(D.driverEnabled(), false);
  for (const [k, v] of [["DRIVER_API_KEY", saved.k], ["PROFILE_KEY", saved.p], ["FORLY_ENV", saved.e]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }

  // ── bootCheck: what index.js refuses to boot with, and whether Driver is on ──
  const B = D.bootCheck;
  assert.deepEqual(B({}), { fatal: null, enabled: false, missing: [], devView: false }, "unset FORLY_ENV still boots");
  assert.ok(B({ FORLY_ENV: "production" }).fatal);
  assert.ok(B({ FORLY_ENV: "" }).fatal);
  // I12: production without FORLY_ENV boots when Driver could not be on anyway (no key, no FORLY_ENV) — Driver stays off
  assert.deepEqual(B({ NODE_ENV: "production" }), { fatal: null, enabled: false, missing: [], devView: false }, "no Driver key, no FORLY_ENV: boots, Driver off");
  assert.deepEqual(B({ NODE_ENV: "production", PROFILE_KEY: "p" }), { fatal: null, enabled: false, missing: [], devView: false });
  assert.ok(B({ NODE_ENV: "production", DRIVER_API_KEY: "k" }).fatal, "a Driver key in production needs FORLY_ENV=prod");
  assert.ok(B({ NODE_ENV: "production", DRIVER_API_KEY: "k", PROFILE_KEY: "p" }).fatal);
  assert.ok(B({ NODE_ENV: "production", FORLY_ENV: "staging" }).fatal, "a FORLY_ENV other than prod in production");
  assert.ok(B({ NODE_ENV: "production", FORLY_ENV: "local" }).fatal);
  assert.ok(B({ NODE_ENV: "production", FORLY_ENV: "staging", DRIVER_API_KEY: "k", PROFILE_KEY: "p" }).fatal);
  assert.ok(B({ NODE_ENV: "production", FORLY_ENV: "production" }).fatal, "an invalid FORLY_ENV stays fatal");
  assert.ok(B({ NODE_ENV: "production", FORLY_ENV: "" }).fatal);
  assert.equal(B({ NODE_ENV: "production", FORLY_ENV: "prod" }).fatal, null);
  assert.deepEqual(B({ NODE_ENV: "production", FORLY_ENV: "prod", DRIVER_API_KEY: "k", PROFILE_KEY: "p" }), { fatal: null, enabled: true, missing: [], devView: false });
  assert.ok(B({ DRIVER_DEV_VIEW: "1" }).fatal, "the viewer needs FORLY_ENV=local");
  assert.ok(B({ DRIVER_DEV_VIEW: "1", FORLY_ENV: "staging" }).fatal);
  assert.ok(B({ DRIVER_DEV_VIEW: "1", FORLY_ENV: "local", NODE_ENV: "production" }).fatal);
  assert.deepEqual(B({ DRIVER_DEV_VIEW: "1", FORLY_ENV: "local" }), { fatal: null, enabled: false, missing: [], devView: true });
  assert.equal(B({ DRIVER_DEV_VIEW: "0", FORLY_ENV: "staging" }).devView, false);
  assert.deepEqual(B({ DRIVER_API_KEY: "k" }).missing, ["PROFILE_KEY", "FORLY_ENV"]);
  assert.deepEqual(B({ DRIVER_API_KEY: "k", FORLY_ENV: "local" }).missing, ["PROFILE_KEY"]);
  assert.deepEqual(B({ DRIVER_API_KEY: "k", PROFILE_KEY: "p" }).missing, ["FORLY_ENV"]);
  assert.equal(B({ DRIVER_API_KEY: "k", PROFILE_KEY: "p" }).enabled, false);
  assert.deepEqual(B({ DRIVER_API_KEY: "k", PROFILE_KEY: "p", FORLY_ENV: "staging" }), { fatal: null, enabled: true, missing: [], devView: false });
  assert.equal(B({ PROFILE_KEY: "p", FORLY_ENV: "staging" }).enabled, false, "no key, no Driver");

  console.log("driver-browser.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
