/*
 * profile-name.js — the Driver persisted-profile name for a phone+platform.
 *
 * One persisted browser profile per agent per platform. The agent logs in once
 * through the embedded browser (or an extract falls back to it); the cookies
 * live in the profile, never here. The name is an HMAC of the phone: the
 * Driver key alone must not be able to enumerate customers.
 *
 * The profile is shared by every environment: the name is minted once, by the
 * server the agent connects on, and saved on the connection
 * (<platform>_profile_name). Every server opens that saved name
 * (profileNameFor); computing it is only for a first connect, or a connection
 * from before names were saved.
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
  return `${platform}-${"prod"}-${tag}${gen ? `-r${gen}` : ""}`;
}

// The profile this agent's login lives in: the name saved on their own
// connection doc, else (never connected, or connected before names were
// saved) this server's computed name. Anything that bumps
// <platform>_profile_gen must also clear <platform>_profile_name.
function profileNameFor(platform, phone, conn) {
  const saved = conn && conn[`${platform}_profile_name`];
  if (typeof saved === "string" && saved.startsWith(`${platform}-`)) return saved;
  return profileName(platform, phone, (conn && conn[`${platform}_profile_gen`]) || 0);
}

// Every code path that passes a `profile` option to Driver derives it through
// profileNameFor and asserts it here. Refuses a name that isn't the one on
// the phone's own connection, and refuses ANY name (even the right one) once
// the connection is revoked or quarantined — that is the whole point of those
// states.
function assertOwnership(name, phone, platform, conn = null) {
  const state = conn ? conn[`${platform}_profile_state`] : null;
  if (name !== profileNameFor(platform, phone, conn) || ["revoked", "quarantined"].includes(state)) {
    const e = new Error("profile ownership");
    e.code = "profile_ownership";
    throw e;
  }
}

// Connections made before names were saved: the server they were made on is
// the only one that computes their name, so it (prod, at boot) writes it down.
const PLATFORMS = ["facebook", "yad2", "madlan"]; // the ones an agent connects (routes/connections-browser.js)
async function backfillSavedNames(db) {
  let saved = 0;
  for (const biz of await db.listAllBusinesses()) {
    const phone = biz && biz.phone;
    if (!phone) continue;
    const conn = await db.getConnection(phone);
    if (!conn) continue;
    const patch = {};
    for (const p of PLATFORMS) {
      if (conn[`${p}_browser_connected_at`] && !conn[`${p}_profile_name`]) patch[`${p}_profile_name`] = profileNameFor(p, phone, conn);
    }
    if (Object.keys(patch).length) { await db.setConnection(phone, patch); saved++; }
  }
  return saved;
}

module.exports = { profileName, profileNameFor, assertOwnership, backfillSavedNames, ENV };
