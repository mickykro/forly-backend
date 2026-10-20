/*
 * scripts/driver-connect-check.local.js — does a connected profile still work?
 *
 *   DRIVER_API_KEY=… node scripts/driver-connect-check.local.js <profile-name> <group-post-url>
 *
 * Run it right after connecting, then again the next day. If the second run
 * reports social_login_required, the profile is not keeping the login and the
 * connect flow has to become a recurring prompt rather than a one-time setup.
 */
const { fromDriver } = require("../server/listing-driver");

const [profileName, url] = process.argv.slice(2);

(async () => {
  if (!profileName || !url) { console.error("usage: <profile-name> <group-post-url>"); process.exit(2); }
  try {
    const out = await fromDriver({ url, profileName });
    console.log(`OK: read ${out.text.length} chars and ${out.photos.length} photo(s) as ${profileName}`);
    console.log(out.text.slice(0, 300));
    process.exit(0);
  } catch (e) {
    if (e.code === "social_login_required") { console.error("NOT LOGGED IN: the profile did not keep the session"); process.exit(1); }
    console.error(`FAIL: ${e.code || ""} ${e.message}`);
    process.exit(1);
  }
})();
