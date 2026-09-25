/*
 * driver-browser.js — hosted real-Chrome sessions from driver.dev.
 *
 * Three calls: POST to create, connectOverCDP to use, DELETE to stop. The
 * DELETE is not optional — browser.close() only drops our websocket, and an
 * unstopped session holds a concurrency slot until its `duration` runs out.
 *
 * Retry policy is deliberately asymmetric (docs.driver.dev/docs/sessions/errors):
 * 402 (no credits) and 403 (over the plan limit) are conditions a PERSON has to
 * fix, so looping only burns time; 503 is capacity, which time does fix.
 *
 * Every function takes `deps` so the tests drive the whole lifecycle with fakes.
 */
const API = "https://api.driver.dev";

class DriverError extends Error {
  constructor(status, message, code, retryAfter) {
    super(`Driver ${status}: ${message}`);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (base, attempt, rnd) => base * 1000 * attempt + rnd * 1000;

async function call(method, path, body, deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const apiKey = deps.apiKey || process.env.DRIVER_API_KEY;
  if (!apiKey) throw new DriverError(401, "DRIVER_API_KEY is not set");
  const res = await fetchFn(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    const ra = Number(res.headers.get("retry-after")) || undefined;
    throw new DriverError(res.status, e.error || res.statusText, e.code, ra);
  }
  return res.json();
}

// Our agents work from Israel, so every session does too: country, clock and
// locale, on the create call, where Driver applies them — never patched in the
// page, which is exactly what looks fake. Callers cannot override these.
const SESSION_DEFAULTS = { country: "IL", timezone: "Asia/Jerusalem", language: "he-IL" };
const proxyDefault = () => (process.env.DRIVER_PROXY_URL ? { proxyUrl: process.env.DRIVER_PROXY_URL } : {});

// Dev-only: a list of live sessions with their viewer URLs, so a developer can
// watch every browser the server opens. Never on in production (index.js
// refuses to boot with the flag under NODE_ENV=production).
let devView = process.env.DRIVER_DEV_VIEW === "1";
const live = new Map();
const liveSessions = () => (devView ? [...live.values()] : []);

async function createSession(opts = {}, deps = {}) {
  const sleep = deps.sleep || sleepReal;
  const random = deps.random || Math.random;
  const body = Object.assign({}, proxyDefault(), opts, SESSION_DEFAULTS);
  let attempt = 0;
  for (;;) {
    try {
      const s = await call("POST", "/v1/browser/session", body, deps);
      if (devView && s && s.sessionId) live.set(s.sessionId, { sessionId: s.sessionId, note: body.note || null, cdpUrl: s.cdpUrl, startedAt: new Date().toISOString() });
      return s;
    } catch (e) {
      if (!(e instanceof DriverError)) throw e;
      attempt++;
      if (e.status === 503 && attempt <= 5) { await sleep(backoffMs(e.retryAfter || 2, attempt, random())); continue; }
      if ((e.status === 504 || e.status === 500) && attempt <= 1) continue;
      if (e.status === 429 && attempt <= 3) { await sleep(backoffMs(2, attempt, random())); continue; }
      throw e; // 400, 401, 402, 403, or out of attempts: a person has to act
    }
  }
}

const getSession = (id, deps) => call("GET", `/v1/browser/session?sessionId=${encodeURIComponent(id)}`, null, deps);
const listSessions = (status, deps) => call("GET", `/v1/browser/sessions?pageSize=50${status ? `&status=${status}` : ""}`, null, deps);

// Idempotent, and never throws: called from a finally, where replacing the
// error already in flight would hide what actually went wrong.
async function stopSession(id, deps = {}) {
  live.delete(id);
  try {
    const r = await call("DELETE", `/v1/browser/session?sessionId=${encodeURIComponent(id)}`, null, deps);
    if (!r || r.success !== true) console.error(`driver: stop of ${id} did not succeed`);
  } catch (e) {
    console.error(`driver: stop of ${id} failed: ${e.message}`);
  }
}

// A crash before the finally leaves a session running until its duration. Every
// session we create carries a note; at boot we stop the ones that are ours.
async function cleanupOrphans(notePrefix, deps = {}) {
  let stopped = 0;
  for (const status of ["active", "starting"]) {
    const r = await listSessions(status, deps).catch(() => ({ sessions: [] }));
    for (const s of (r && r.sessions) || []) {
      if (!String(s.note || "").startsWith(notePrefix)) continue;
      await stopSession(s.sessionId, deps);
      stopped++;
    }
  }
  return stopped;
}

async function waitForActive(session, deps = {}) {
  const sleep = deps.sleep || sleepReal;
  const deadline = Date.now() + (deps.timeoutMs || 60000);
  let s = session;
  while (!(s.status === "active" && s.cdpUrl)) {
    if (s.status === "completed" || s.status === "error") throw new DriverError(500, `session ended: ${s.status}`);
    if (Date.now() > deadline) throw new DriverError(504, "timed out waiting for the browser");
    await sleep(1000);
    s = await getSession(s.sessionId, deps);
  }
  return s;
}

/*
 * The only way this module hands out a page. Reuses the browser's own context
 * and tab (a fresh context is itself an automation signal) and guarantees the
 * DELETE, whatever fn does.
 */
async function withPage(opts, fn, deps = {}) {
  const session = await createSession(opts, deps);
  try {
    const active = await waitForActive(session, deps);
    const connect = deps.connectOverCDP || require("patchright").chromium.connectOverCDP;
    const browser = await connect(active.cdpUrl);
    try {
      const context = browser.contexts()[0] || (await browser.newContext());
      const page = context.pages()[0] || (await context.newPage());
      return await fn(page, active);
    } finally {
      await browser.close(); // our connection only; the session is still up
    }
  } finally {
    await stopSession(session.sessionId, deps);
  }
}

/*
 * Join a session that is ALREADY running and leave it running. This is the
 * embedded-login case: the agent is typing into that browser right now, so the
 * finally that withPage guarantees would be exactly wrong here.
 */
async function attachPage(sessionId, fn, deps = {}) {
  const session = await waitForActive(await getSession(sessionId, deps), deps);
  const connect = deps.connectOverCDP || require("patchright").chromium.connectOverCDP;
  const browser = await connect(session.cdpUrl);
  try {
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());
    return await fn(page, session);
  } finally {
    await browser.close(); // our connection only — the agent's session stays up
  }
}

// Deletes a persisted profile at Driver — used on disconnect, so the cookies
// do not outlive the agent's consent. Like stopSession, never throws: called
// from a route handler that has already committed to answering 200.
async function deleteProfile(name, deps = {}) {
  try {
    const r = await call("DELETE", `/v1/browser/profiles/${encodeURIComponent(name)}`, null, deps);
    if (r && r.success === false) console.error(`driver: delete of profile ${name} did not succeed`);
  } catch (e) {
    console.error(`driver: delete of profile ${name} failed: ${e.message}`);
  }
}

module.exports = {
  DriverError, createSession, getSession, listSessions, stopSession,
  cleanupOrphans, waitForActive, withPage, attachPage, deleteProfile, liveSessions, SESSION_DEFAULTS,
  _test: { backoffMs, setDevView: (v) => { devView = v; live.clear(); } },
};
