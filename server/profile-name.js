/*
 * profile-name.js — the Driver persisted-profile name for a phone+platform.
 *
 * One persisted browser profile per agent per platform. The agent logs in once
 * through the embedded browser (or an extract falls back to it); the cookies
 * live in the profile, never here. The name is an HMAC of the phone: the
 * Driver key alone must not be able to enumerate customers.
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

// Every code path that passes a `profile` option to Driver derives it through
// profileName and asserts it here — never a stored string. Refuses a name
// that isn't the phone's current-generation name for that platform, and
// refuses ANY name (even the right one) once the connection is revoked or
// quarantined — that is the whole point of those states.
function assertOwnership(name, phone, platform, conn = null) {
  const gen = conn ? (conn[`${platform}_profile_gen`] || 0) : 0;
  const state = conn ? conn[`${platform}_profile_state`] : null;
  if (name !== profileName(platform, phone, gen) || ["revoked", "quarantined"].includes(state)) {
    const e = new Error("profile ownership");
    e.code = "profile_ownership";
    throw e;
  }
}

module.exports = { profileName, assertOwnership, ENV };
