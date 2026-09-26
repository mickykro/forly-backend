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
 *
 * A session's cdpUrl is full remote control of a browser that may hold an
 * agent's logged-in cookies. It never leaves this module except through
 * consumeViewerGrant() (one operator, one use, five minutes), and nothing
 * logged here carries it, a viewer URL, or a profile name — see redact().
 */
const crypto = require("crypto");
const profileLock = require("./profile-lock");
const profileNames = require("./profile-name");

const API = "https://api.driver.dev";

const PROFILE_RE = /(facebook|yad2|madlan|instagram|tiktok|linkedin|x)-(prod|staging|local)-[0-9a-f]{20}(-r\d+)?/g;
function redact(msg) {
  return String(msg)
    .replace(PROFILE_RE, "[profile]")
    .replace(/wss?:\/\/\S+/g, "[cdp]")
    .replace(/ws=\S+/g, "ws=[cdp]");
}
const shortId = (id) => `…${String(id || "").slice(-6)}`;
const logError = (msg) => console.error(redact(msg));

// Driver features need all three: the API key, the key that makes profile
// names unguessable, and an environment to keep prod and staging profiles
// apart. index.js and routes/extract.js both ask here, so they cannot disagree.
const ENVS = ["prod", "staging", "local"];
function driverMissing(env) {
  const missing = [];
  if (!env.PROFILE_KEY) missing.push("PROFILE_KEY");
  if (!ENVS.includes(env.FORLY_ENV)) missing.push("FORLY_ENV");
  return missing;
}
const driverEnabled = (env = process.env) => !!env.DRIVER_API_KEY && driverMissing(env).length === 0;

// index.js's boot decision, as a pure function: `fatal` → refuse to start.
// An unset FORLY_ENV still boots (profileName refuses when called; Driver
// stays off); a wrong one does not. NODE_ENV=production without
// FORLY_ENV=prod is fatal only when Driver could be on — DRIVER_API_KEY or a
// FORLY_ENV is set (I12): a production box with neither simply runs without
// Driver. The dev viewer exists only on a local, non-production box.
function bootCheck(env = process.env) {
  const out = { fatal: null, enabled: false, missing: [], devView: false };
  const fatal = (msg) => Object.assign(out, { fatal: msg });
  if (env.FORLY_ENV !== undefined && !ENVS.includes(env.FORLY_ENV)) return fatal(`FORLY_ENV must be prod|staging|local (got "${env.FORLY_ENV}")`);
  const driverWanted = !!env.DRIVER_API_KEY || env.FORLY_ENV !== undefined;
  if (env.NODE_ENV === "production" && env.FORLY_ENV !== "prod" && driverWanted) return fatal("NODE_ENV=production requires FORLY_ENV=prod");
  if (env.DRIVER_DEV_VIEW === "1") {
    if (env.FORLY_ENV !== "local" || env.NODE_ENV === "production") {
      return fatal("DRIVER_DEV_VIEW=1 is allowed only with FORLY_ENV=local and NODE_ENV not production — unset it");
    }
    out.devView = true;
  }
  if (env.DRIVER_API_KEY) {
    out.missing = driverMissing(env);
    out.enabled = out.missing.length === 0;
  }
  return out;
}

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
// Notes are scoped by environment HERE, in one place: callers pass
// "forly-<kind>:<rest>", Driver sees "forly-<env>-<kind>:<rest>". Staging and
// prod may share a Driver account, and cleanupOrphans matches on the note —
// unscoped, a staging boot would stop every prod session. An invalid
// FORLY_ENV leaves the note as is (Driver is disabled then anyway).
function scopeNote(note) {
  if (typeof note !== "string") return note;
  const m = note.match(/^forly-([a-z]+):/);
  if (!m) return note; // not ours, or already scoped
  let env;
  try { env = profileNames.ENV(); } catch (e) { return note; }
  return `forly-${env}-${m[1]}:${note.slice(m[0].length)}`;
}

const proxyDefault = () => (process.env.DRIVER_PROXY_URL ? { proxyUrl: process.env.DRIVER_PROXY_URL } : {});

// Dev-only: a registry of live sessions, so a developer can watch every
// browser the server opens (routes/dev-driver.js). Never on in production
// (index.js refuses to boot with the flag outside FORLY_ENV=local). The list
// carries no cdpUrl — watching one takes a viewer grant.
let devView = process.env.DRIVER_DEV_VIEW === "1";
const live = new Map();
const platformOfNote = (note) => {
  const m = String(note || "").match(/^forly-(?:(?:prod|staging|local)-)?[a-z]+:(.+)$/);
  return m ? m[1] : null;
};
const liveSessions = () => (devView ? [...live.values()].map((s) => ({
  sessionId: s.sessionId, note: s.note, platform: platformOfNote(s.note), startedAt: s.startedAt, viewer_available: true,
})) : []);

// Viewer grants: an operator asks for one (step-up protected), then spends it
// on a redirect. Five minutes, one use, bound to the operator who minted it.
const GRANT_TTL_MS = 5 * 60 * 1000;
const grants = new Map();
let nowFn = () => Date.now();
function mintViewerGrant(sessionId, { operator, mode = "view" } = {}) {
  if (!live.has(sessionId) || !operator) return null;
  const now = nowFn();
  for (const [k, g] of grants) if (g.expiresAt <= now) grants.delete(k);
  const id = crypto.randomBytes(16).toString("hex");
  const expiresAt = now + GRANT_TTL_MS;
  grants.set(id, { sessionId, operator, mode, expiresAt });
  return { id, expiresAt };
}
// The one place the cdpUrl is read back out.
function consumeViewerGrant(id, operator) {
  const g = grants.get(id);
  grants.delete(id);
  if (!g || g.expiresAt <= nowFn() || g.operator !== operator) return null;
  const s = live.get(g.sessionId);
  if (!s || !s.cdpUrl) return null;
  return `https://viewer.driver.dev?ws=${encodeURIComponent(s.cdpUrl)}`;
}

/*
 * Everything a page-handing call must hold before it opens a browser. With a
 * profile: the caller says whose (deps.phone + deps.platform), the name must be
 * that phone's current one (withPage only — attachPage has no opts.profile),
 * and the profile lock is taken here unless the caller already holds it
 * (deps.lockHeld). Always: one slot of the local concurrency budget. Returns
 * one release for both.
 */
function claim(usesProfile, profileNameToCheck, deps) {
  const locks = deps.locks || profileLock;
  const names = deps.names || profileNames;
  let releaseProfile = () => {};
  if (usesProfile) {
    if (!deps.phone || !deps.platform) {
      const e = new Error("a profile needs deps.phone and deps.platform"); e.code = "invalid_input"; throw e;
    }
    if (profileNameToCheck !== undefined) names.assertOwnership(profileNameToCheck, deps.phone, deps.platform, deps.conn || null);
    if (deps.lockHeld !== true) {
      const r = locks.tryAcquire(deps.phone, deps.platform);
      if (!r) { const e = new Error("profile is busy"); e.code = "profile_busy"; throw e; }
      releaseProfile = r;
    }
  }
  const releaseSession = locks.trySession();
  if (!releaseSession) { releaseProfile(); throw new DriverError(429, "local concurrency budget"); }
  return () => { releaseSession(); releaseProfile(); };
}

async function createSession(opts = {}, deps = {}) {
  const sleep = deps.sleep || sleepReal;
  const random = deps.random || Math.random;
  const body = Object.assign({}, proxyDefault(), opts, SESSION_DEFAULTS);
  if (body.note) body.note = scopeNote(body.note);
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
    if (!r || r.success !== true) logError(`driver: stop of ${shortId(id)} did not succeed`);
  } catch (e) {
    logError(`driver: stop of ${shortId(id)} failed: ${e.message}`);
  }
}

// A crash before the finally leaves a session running until its duration. Every
// session we create carries a note; at boot we stop the ones that are ours.
async function cleanupOrphans(notePrefix, deps = {}) {
  notePrefix = scopeNote(notePrefix); // this environment's sessions only
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
 * DELETE, whatever fn does. With opts.profile, deps must say whose profile it
 * is (phone, platform, optional conn) — see claim().
 */
async function withPage(opts, fn, deps = {}) {
  const profile = opts && opts.profile;
  // The agent's login browser holds no lock once /start returns; never open the
  // same profile (same cookies, another IP) while it is live. Every caller that
  // passes conn — posting, extract, listing-sweep — gets this for free.
  if (profile && deps.conn && deps.platform && profileLock.loginOpen(deps.conn, deps.platform)) {
    const e = new Error("profile is busy: login in progress"); e.code = "profile_busy"; throw e;
  }
  const release = claim(!!profile, profile ? profile.name : undefined, deps);
  let session = null;
  try {
    session = await createSession(opts, deps);
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
    if (session) await stopSession(session.sessionId, deps);
    release();
  }
}

/*
 * Join a session that is ALREADY running and leave it running. This is the
 * embedded-login case: the agent is typing into that browser right now, so the
 * finally that withPage guarantees would be exactly wrong here. With
 * deps.phone the profile lock is taken for the attach (unless deps.lockHeld).
 */
async function attachPage(sessionId, fn, deps = {}) {
  const release = claim(!!deps.phone, undefined, deps);
  try {
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
  } finally {
    release();
  }
}

// Deletes a persisted profile at Driver — used on disconnect and by
// profile-lifecycle.js's revoke()/retryDeletes(), so the cookies do not
// outlive the agent's consent. Like stopSession, never throws (called from a
// route handler that has already committed to answering 200); instead it
// returns { ok: true } or { ok: false, error } so a caller that DOES need to
// know (revoke() records `<platform>_profile_delete_error` for the sweeper to
// retry) can. Never logs the profile name — only the platform, which is its
// first "-"-separated segment.
async function deleteProfile(name, deps = {}) {
  const platform = String(name || "").split("-")[0] || "unknown";
  try {
    const r = await call("DELETE", `/v1/browser/profiles/${encodeURIComponent(name)}`, null, deps);
    if (r && r.success === false) {
      logError(`driver: delete of ${platform} profile did not succeed`);
      return { ok: false, error: "did not succeed" };
    }
    return { ok: true };
  } catch (e) {
    // A delete can succeed at Driver while its response is lost (timeout,
    // dropped connection, …); every retry after that sees a 404, because the
    // profile really is already gone. That is success, not failure — logged
    // as an error and retried forever, it would escalate a delete that
    // already happened. Nothing worth logging: a 404 here is expected, not
    // noteworthy.
    if (e instanceof DriverError && e.status === 404) return { ok: true, already_gone: true };
    logError(`driver: delete of ${platform} profile failed: ${e.message}`);
    return { ok: false, error: e.message, status: e instanceof DriverError ? e.status : undefined };
  }
}

module.exports = {
  DriverError, createSession, getSession, listSessions, stopSession,
  cleanupOrphans, waitForActive, withPage, attachPage, deleteProfile, liveSessions, SESSION_DEFAULTS,
  redact, driverEnabled, bootCheck, mintViewerGrant, consumeViewerGrant,
  _test: {
    backoffMs, scopeNote,
    setDevView: (v) => { devView = v; live.clear(); grants.clear(); },
    setNow: (fn) => { nowFn = fn || (() => Date.now()); },
  },
};
