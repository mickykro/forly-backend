/* driver-browser.js — session lifecycle and the error policy. No network:
   fetch and connectOverCDP are stubbed. */
const assert = require("assert");
const D = require("./driver-browser");

const ok = (body) => ({ ok: true, status: 200, json: async () => body, headers: { get: () => null } });
const err = (status, body, retryAfter) => ({
  ok: false, status, statusText: "e", json: async () => body || {},
  headers: { get: (h) => (h.toLowerCase() === "retry-after" && retryAfter ? String(retryAfter) : null) },
});

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
  await D.stopSession("s1", { fetchFn: async () => err(500, {}), apiKey: "k", sleep: async () => {} });

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
  await D.withPage({}, async () => { seen.push(D.liveSessions().map((x) => x.sessionId)); return 1; }, deps);
  assert.deepEqual(seen, [["s2"]]);
  assert.deepEqual(D.liveSessions(), [], "removed after stop");
  D._test.setDevView(false);
  await D.withPage({}, async () => { seen.push(D.liveSessions()); }, deps);
  assert.deepEqual(seen[1], [], "no registry when the flag is off");

  // ── cleanupOrphans stops only our own notes ──
  const deleted = [];
  const cleanupDeps = {
    apiKey: "k", sleep: async () => {},
    fetchFn: async (url, init) => {
      if ((init && init.method) === "DELETE") { deleted.push(url); return ok({ success: true }); }
      if (url.includes("status=active")) return ok({ sessions: [{ sessionId: "a", note: "forly-extract:1" }, { sessionId: "b", note: "someone-else" }] });
      return ok({ sessions: [{ sessionId: "c", note: "forly-extract:2" }] });
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

  console.log("driver-browser.test.js ok");
})();
