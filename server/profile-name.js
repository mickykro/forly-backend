/*
 * profile-name.js — the Driver persisted-profile name for a phone+platform.
 *
 * One persisted browser profile per agent per platform. The agent logs in once
 * through the embedded browser (or an extract falls back to it); the cookies
 * live in the profile, never here. The name is an HMAC of the phone: the
 * Driver key alone must not be able to enumerate customers.
 *
 * The profile is shared by every environment that shares the connection doc
 * (prod and staging): a confirmed login (/finish, the admin's verify) saves
 * the exact name it used as `<platform>_profile_name`, and every server opens
 * that saved name (profileNameFor). Computing the name is only for a first
 * connect, or a connection from before names were saved. A login browser that
 * has not been confirmed yet leaves only `<platform>_profile_name_pending`.
 *
 * FORLY_ENV is read at CALL time, not load time — profileName must see a
 * value set by the caller (e.g. a test) after this module was required, and
 * an unset/unknown env must fail loudly rather than silently becoming "prod".
 *
 * Shared by routes/extract.js (the driver-routed scrape) and
 * routes/connections-browser.js (the login browser) — both must compute the
 * exact same name for the same phone+platform, or a freshly-connected profile
 * reads back as logged out.
 */
const crypto = require("crypto");

const SOCIAL = /(^|\.)(facebook\.com|instagram\.com|tiktok\.com|linkedin\.com|x\.com|twitter\.com)$/i;

function ENV() {
  const e = process.env.FORLY_ENV;
  if (!["prod", "staging", "local"].includes(e)) throw new Error("FORLY_ENV must be prod|staging|local");
  return e;
}

// Accepts either a full URL (extract's call site) or a bare platform name
// (connections-browser's call site, which already knows the platform).
function platformOf(urlOrPlatform) {
  if (/^https?:\/\//i.test(String(urlOrPlatform || ""))) {
    let host;
    try { host = new URL(urlOrPlatform).hostname; } catch (e) { return null; }
    const m = host.match(SOCIAL);
    if (!m) return null;
    const name = m[2].split(".")[0].toLowerCase();
    return name === "twitter" ? "x" : name; // one account, one profile
  }
  const name = String(urlOrPlatform || "").toLowerCase();
  return name === "twitter" ? "x" : name;
}

// gen: the profile "generation" for this phone+platform. 0 (the default) is
// the original profile; quarantine bumps it so a reconnect gets a fresh
// Driver profile name instead of reusing the one under suspicion.
function profileName(urlOrPlatform, phone, gen = 0) {
  const platform = platformOf(urlOrPlatform);
  if (!platform) return null;
  const tag = crypto.createHmac("sha256", String(process.env.PROFILE_KEY || "dev")).update(String(phone)).digest("hex").slice(0, 20);
  return `${platform}-${ENV()}-${tag}${gen ? `-r${gen}` : ""}`;
}

// A name the server stored on the connection (see profileNameFor). Never trusted
// blindly: it must belong to this platform, look like a Driver profile name,
// and have been stored for the connection's CURRENT generation — a revoke or
// quarantine bumps the generation, which retires the stored name by itself.
const NAME_RE = /^[a-z0-9]+-[a-z0-9-]{1,100}$/;
function validName(platform, name) {
  return typeof name === "string" && name.startsWith(`${platform}-`) && NAME_RE.test(name);
}
function genOf(platform, conn) { return (conn && conn[`${platform}_profile_gen`]) || 0; }
function fieldName(platform, conn, gen, field) {
  if (!conn) return null;
  const name = conn[field];
  return validName(platform, name) && (conn[`${field}_gen`] || 0) === gen ? name : null;
}
// The name pinned by a confirmed login (/finish or the admin's verify).
function storedName(platform, conn, gen = genOf(platform, conn)) {
  return fieldName(platform, conn, gen, `${platform}_profile_name`);
}
// The name a login browser opened (or an admin typed) that no login has
// confirmed yet. Only the login check may open it — never posting.
function pendingName(platform, conn, gen = genOf(platform, conn)) {
  return fieldName(platform, conn, gen, `${platform}_profile_name_pending`);
}

// The profile to open for this phone+platform: the stored name when a login
// pinned one, else the computed one. Prod and staging share Firestore, so a
// pinned name is the same profile on both — and survives a FORLY_ENV or
// PROFILE_KEY change.
function profileNameFor(urlOrPlatform, phone, conn = null, gen) {
  const platform = platformOf(urlOrPlatform);
  if (!platform) return null;
  const g = gen !== undefined ? gen : genOf(platform, conn);
  return storedName(platform, conn, g) || profileName(platform, phone, g);
}

// Every code path that passes a `profile` option to Driver derives it through
// profileNameFor and asserts it here. Refuses a name that isn't the phone's
// current name for that platform (or the pending name a login check is
// confirming), and refuses ANY name (even the right one) once the connection
// is revoked or quarantined — that is the whole point of those states.
function assertOwnership(name, phone, platform, conn = null) {
  const state = conn ? conn[`${platform}_profile_state`] : null;
  const owned = name === profileNameFor(platform, phone, conn) || (name !== null && name === pendingName(platform, conn));
  if (!owned || ["revoked", "quarantined"].includes(state)) {
    const e = new Error("profile ownership");
    e.code = "profile_ownership";
    throw e;
  }
}

module.exports = { profileName, profileNameFor, storedName, pendingName, validName, assertOwnership, ENV };
