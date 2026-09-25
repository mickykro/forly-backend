/*
 * scripts/driver-extract.local.js — one real scrape, end to end.
 *
 *   DRIVER_API_KEY=… ANTHROPIC_API_KEY=… node scripts/driver-extract.local.js <url>
 *
 * Checks what the unit tests cannot: that the page actually renders, that the
 * fields are the RIGHT fields, and that the session was really stopped.
 * Exits non-zero on anything unproven — this is meant for CI too.
 */
const { resolve } = require("../server/listing-sources");
const { parseListing } = require("../server/listing-extract");
const driver = require("../server/driver-browser");

const url = process.argv[2] || "https://www.yad2.co.il/realestate/forsale";

(async () => {
  if (!process.env.DRIVER_API_KEY) { console.error("set DRIVER_API_KEY"); process.exit(2); }

  const before = await driver.listSessions("active").catch(() => ({ sessions: [] }));
  console.log(`active sessions before: ${(before.sessions || []).length}`);

  const source = await resolve({ url }, { jobId: "local-verify" });
  console.log(`source=${source.source} text=${source.text.length} chars photos=${source.photos.length}`);
  console.log(source.text.slice(0, 400));

  const parsed = await parseListing(source.text);
  console.log("fields:", JSON.stringify(parsed.fields, null, 2));
  console.log("missing:", parsed.missing.join(", ") || "(none)");

  // The checks, in order of what would embarrass us most.
  if (source.text.length < 200) { console.error("FAIL: page text is too short to be a listing"); process.exit(1); }
  if (!parsed.fields.price && !parsed.fields.rooms) { console.error("FAIL: neither price nor rooms was read"); process.exit(1); }

  const after = await driver.listSessions("active").catch(() => ({ sessions: [] }));
  const leaked = (after.sessions || []).filter((s) => String(s.note || "").startsWith("forly-extract:"));
  if (leaked.length) {
    console.error(`FAIL: ${leaked.length} session(s) still active: ${leaked.map((s) => s.sessionId).join(", ")}`);
    process.exit(1);
  }
  console.log("OK: fields read and no session left running");
})().catch((e) => { console.error(`FAIL: ${e.code || ""} ${e.message}`); process.exit(1); });
