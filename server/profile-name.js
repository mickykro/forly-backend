/*
 * profile-name.js — the Driver persisted-profile name for a phone+platform.
 *
 * One persisted browser profile per agent per platform. The agent logs in once
 * through the embedded browser (or an extract falls back to it); the cookies
 * live in the profile, never here. The name is an HMAC of the phone: the
 * Driver key alone must not be able to enumerate customers.
 *
 * Shared by routes/extract.js (the driver-routed scrape) and
 * routes/connections-browser.js (the login browser) — both must compute the
 * exact same name for the same phone+platform, or a freshly-connected profile
 * reads back as logged out.
 */
const crypto = require("crypto");

const SOCIAL = /(^|\.)(facebook\.com|instagram\.com|tiktok\.com|linkedin\.com|x\.com|twitter\.com)$/i;

// Accepts either a full URL (extract's call site) or a bare platform name
// (connections-browser's call site, which already knows the platform).
function profileName(urlOrPlatform, phone, key = process.env.PROFILE_KEY, env = process.env.FORLY_ENV || "prod") {
  let platform;
  if (/^https?:\/\//i.test(String(urlOrPlatform || ""))) {
    let host;
    try { host = new URL(urlOrPlatform).hostname; } catch (e) { return null; }
    const m = host.match(SOCIAL);
    if (!m) return null;
    const name = m[2].split(".")[0].toLowerCase();
    platform = name === "twitter" ? "x" : name; // one account, one profile
  } else {
    const name = String(urlOrPlatform || "").toLowerCase();
    platform = name === "twitter" ? "x" : name;
  }
  const tag = crypto.createHmac("sha256", String(key || "dev")).update(String(phone)).digest("hex").slice(0, 20);
  return `${platform}-${env}-${tag}`;
}

module.exports = { profileName };
