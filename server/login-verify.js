/*
 * login-verify.js — is an agent's SAVED login still good?
 *
 * The agent becomes "connected" only through /finish (the login window's done
 * button). An agent who logs in and closes the window instead leaves a
 * logged-in profile at Driver and no `<platform>_browser_connected_at` here,
 * so every Forly screen says "not connected". This opens that saved profile
 * in a short browser of its own, runs /finish's very check (readLogin), and
 * records the connection only when the check says logged in. Nothing is
 * written otherwise.
 *
 * One Driver session per call: it runs only when an admin asks
 * (routes/admin-manual.js).
 */
const driverLive = require("./driver-browser");
const dbLive = require("./db");
const { profileName } = require("./profile-name");

const VERIFY_SECONDS = 180;

async function verifySaved(phone, platform, deps = {}) {
  const driver = deps.driver || driverLive;
  const db = deps.db || dbLive;
  const CB = require("./routes/connections-browser");
  const spec = CB.PLATFORMS[platform];
  if (!spec) return { error: "invalid_input" };
  const conn = (await db.getConnection(phone)) || {};
  if (conn[`${platform}_browser_connected_at`]) return { state: "connected", identity_label: conn[`${platform}_identity_label`] || null };
  // A revoked or quarantined profile is not the agent's to reuse; withPage
  // would refuse it anyway (assertOwnership).
  if (["revoked", "quarantined"].includes(conn[`${platform}_profile_state`])) return { error: "profile_revoked" };

  let r;
  try {
    r = await driver.withPage(
      { duration: VERIFY_SECONDS, note: `forly-connect:verify-${platform}`, profile: { name: profileName(platform, phone, conn[`${platform}_profile_gen`] || 0), persist: true } },
      (page) => CB.readLogin(page, platform, spec, conn, db),
      { phone, platform, conn },
    );
  } catch (e) {
    // profile_busy: a login window or a post is using this profile right now.
    if (e && e.code === "profile_busy") return { error: "profile_busy" };
    if (e instanceof driverLive.DriverError && e.status === 429) return { error: "driver_busy" };
    console.error(driverLive.redact(`login-verify ${platform}: ${driverLive.describeError(e)}`));
    return { error: "verify_failed" };
  }
  if (r.unverifiable) return { error: "cannot_verify_login" };
  if (!r.loggedIn) return { state: "not_logged_in" };
  await db.setConnection(phone, CB.connectedPatch(conn, platform, r));
  return { state: "connected", identity_label: r.label || null };
}

module.exports = { verifySaved };
