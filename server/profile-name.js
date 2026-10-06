/*
 * profile-name.js — the Driver persisted-profile name for a phone+platform.
 *
 * One persisted browser profile per agent per platform. The agent logs in once
 * through the embedded browser (or an extract falls back to it); the cookies
 * live in the profile, never here. The name ends in an HMAC of the phone —
 * never the phone itself — and carries the agent's name (transliterated) so
 * an operator can find it in Driver's dashboard. The name is fixed once, at
 * the first connect (`<platform>_profile_label` on the connection): an agent
 * who later edits their name must not lose their saved login.
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
const { transliterate } = require("./portfolio");

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

// The agent's name as a profile-name segment: Latin a-z0-9 and hyphens, at
// most 24 characters, "" when nothing usable is left.
function labelOf(name) {
  return transliterate(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 24).replace(/-+$/g, "");
}

// gen: the profile "generation" for this phone+platform. 0 (the default) is
// the original profile; quarantine bumps it so a reconnect gets a fresh
// Driver profile name instead of reusing the one under suspicion.
// label: the connection's stored `<platform>_profile_label` ("" → none).
function profileName(urlOrPlatform, phone, gen = 0, label = "") {
  const platform = platformOf(urlOrPlatform);
  if (!platform) return null;
  const tag = crypto.createHmac("sha256", String(process.env.PROFILE_KEY || "dev")).update(String(phone)).digest("hex").slice(0, 20);
  const named = labelOf(label);
  return `${platform}-${ENV()}-${named ? `${named}-` : ""}${tag}${gen ? `-r${gen}` : ""}`;
}

// The connection's current profile name: its generation and stored label.
// Every caller that has the connection goes through here.
function profileNameFor(urlOrPlatform, phone, conn) {
  const platform = platformOf(urlOrPlatform);
  if (!platform) return null;
  const c = conn || {};
  return profileName(platform, phone, c[`${platform}_profile_gen`] || 0, c[`${platform}_profile_label`] || "");
}

// Every code path that passes a `profile` option to Driver derives it through
// profileName and asserts it here — never a stored string. Refuses a name
// that isn't the phone's current-generation name for that platform, and
// refuses ANY name (even the right one) once the connection is revoked or
// quarantined — that is the whole point of those states.
function assertOwnership(name, phone, platform, conn = null) {
  const gen = conn ? (conn[`${platform}_profile_gen`] || 0) : 0;
  const state = conn ? conn[`${platform}_profile_state`] : null;
  const label = conn ? (conn[`${platform}_profile_label`] || "") : "";
  if (name !== profileName(platform, phone, gen, label) || ["revoked", "quarantined"].includes(state)) {
    const e = new Error("profile ownership");
    e.code = "profile_ownership";
    throw e;
  }
}

module.exports = { profileName, profileNameFor, labelOf, assertOwnership, ENV };
