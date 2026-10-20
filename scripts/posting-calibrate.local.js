/*
 * scripts/posting-calibrate.local.js — the first real Facebook posts,
 * watched closely (Task 24). The product owner runs this by hand, against a
 * THROWAWAY test account and groups/pages they own. Claude never runs it.
 *
 * Never touches production storage: this process never calls db.init(), so
 * server/posting-tx.js's firestore() stays null for its whole lifetime and
 * every reservation/attempt/budget/dedup write here lands in posting-attempts'
 * own in-memory maps, gone when the process exits — never Firestore, whatever
 * GOOGLE_APPLICATION_CREDENTIALS is set to. The connection record the driver
 * checks against (identity label, posting permission, the Page it may post
 * as) is a fake one this script builds from its own flags — never a row read
 * from, or written to, the real `connections` store.
 *
 * Refuses to start unless FORLY_ENV=local, CALIBRATE_ACCOUNT_CONFIRMED=1, and
 * --phone is one of the comma-separated CALIBRATE_TEST_PHONES — never an
 * agent's real phone. Reuses the real modules end to end: posting-driver's
 * postToGroup/postToPage (with dryRun), social-dwell's dwell() (run inside
 * posting-driver, not called here), posting-attempts.reserveAttempt, and
 * posting-driver-proof's readSignal/urlSegment. Nothing here reimplements
 * Facebook page logic; it only supplies fakes for the pieces that would
 * otherwise need a real onboarded account (guard's db, the connection).
 *
 * Prints, at every attempt-state transition: every SELECTORS key from
 * posting-driver (== posting-driver-proof, R3's own set), social-dwell and
 * facebook-groups-sync — found/not found — the page's current signal, and
 * elapsed time. Never prints cdpUrl, Driver profile names, a phone in full,
 * or the post's own text (its length and a short hash only — check the
 * composer by eye in the browser instead).
 *
 *   export DRIVER_API_KEY=…              (once, from the secret store)
 *   export PROFILE_KEY=…                 (matches this env's deploy.env)
 *   export FORLY_ENV=local
 *   export CALIBRATE_ACCOUNT_CONFIRMED=1
 *   export CALIBRATE_TEST_PHONES=9725xxxxxxxx
 *   export POSTING_ENABLED=1             (the env kill switch: posting is off without it)
 *
 *   # dry run (group) — stops before the Post click, three clean passes
 *   node scripts/posting-calibrate.local.js \
 *     --phone 9725xxxxxxxx --identity "<display name on the test account>" \
 *     --group https://www.facebook.com/groups/<test-group>
 *
 *   # one live post
 *   node scripts/posting-calibrate.local.js \
 *     --phone 9725xxxxxxxx --identity "<display name>" \
 *     --group https://www.facebook.com/groups/<test-group> --live
 *
 *   # a Page instead of a group
 *   node scripts/posting-calibrate.local.js \
 *     --phone 9725xxxxxxxx --identity "<the Page's own display name>" \
 *     --page https://www.facebook.com/<test-page> --page-id <numeric-page-id>
 */
const crypto = require("crypto");
const driverBrowser = require("../server/driver-browser");
const PD = require("../server/posting-driver");
const P = require("../server/posting-driver-proof");
const SD = require("../server/social-dwell");
const FG = require("../server/facebook-groups-sync");
const attemptsModule = require("../server/posting-attempts");
const { sha } = require("../server/posting-campaign");
const { buildPostCopy, trackedUrl } = require("../server/distribution/share-kit");

const SELECTOR_SETS = {
  "posting-driver": PD.SELECTORS, // == posting-driver-proof's SELECTORS: R3, the composer, the feed
  "social-dwell": SD.SELECTORS,
  "facebook-groups-sync": FG.SELECTORS,
};

const TEST_PAGE = { property: { title: "בדיקת מערכת — נא להתעלם", city: "תל אביב", rooms: 3, price: 1 }, agent: { name: "בדיקה" } };

function redactPhone(phone) {
  const s = String(phone || "");
  return s.length > 4 ? `…${s.slice(-4)}` : "(unset)";
}

function parseArgs(argv) {
  const out = { live: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--live") out.live = true;
    else if (a === "--phone") out.phone = argv[++i];
    else if (a === "--identity") out.identity = argv[++i];
    else if (a === "--group") out.groupUrl = argv[++i];
    else if (a === "--page") out.pageUrl = argv[++i];
    else if (a === "--page-id") out.pageId = argv[++i];
    else if (a === "--page-name") out.pageName = argv[++i];
  }
  return out;
}

// The three global refusal conditions (Task 24's adaptation notes), and
// nothing else — a pure check so it can be unit-tested without a browser or
// any of the modules above. → { ok, errors, phone }.
function checkPreconditions(env, argv) {
  const errors = [];
  if (env.FORLY_ENV !== "local") errors.push(`FORLY_ENV must be "local" (got ${JSON.stringify(env.FORLY_ENV || "")})`);
  if (env.CALIBRATE_ACCOUNT_CONFIRMED !== "1") errors.push('CALIBRATE_ACCOUNT_CONFIRMED must be "1" (confirms this is the throwaway test account)');
  const phone = parseArgs(argv).phone;
  const allowed = String(env.CALIBRATE_TEST_PHONES || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!phone) errors.push("--phone <phone> is required");
  else if (!allowed.includes(phone)) errors.push(`--phone ${redactPhone(phone)} is not listed in CALIBRATE_TEST_PHONES`);
  return { ok: errors.length === 0, errors, phone };
}

// The rest of the usage contract — checked only after the refusal
// conditions pass, so it never needs its own env/exit-code test.
function validateTarget(args) {
  const errors = [];
  if (!args.groupUrl && !args.pageUrl) errors.push("pass --group <url> or --page <url>");
  if (args.groupUrl && args.pageUrl) errors.push("pass only one of --group or --page");
  if (args.pageUrl && !/^\d+$/.test(String(args.pageId || ""))) errors.push("--page-id <numeric Facebook Page id> is required with --page");
  if (!args.identity) errors.push("--identity <display name shown on the test account> is required");
  return errors;
}

async function probeSelectors(page) {
  for (const [label, sels] of Object.entries(SELECTOR_SETS)) {
    for (const [key, sel] of Object.entries(sels)) {
      if (typeof sel !== "string") continue;
      let n;
      try { n = await page.locator(sel).count(); } catch { n = -1; }
      console.log(`  ${label}.${key}: ${n > 0 ? `found (${n})` : n === 0 ? "not found" : "error reading it"}`);
    }
  }
}

// Ties selector/signal/timing output to the attempt's real state transitions
// (R1) instead of a parallel notion of "step" — every step it reports is one
// posting-attempts.transition already made.
function makeStepLogger(copy) {
  let page = null;
  let t0 = 0;
  return {
    setPage(p) { page = p; t0 = Date.now(); },
    async onStep(to) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`\n=== ${to} (t+${elapsed}s) ===`);
      if (!page) { console.log("  (no page open yet)"); return; }
      await probeSelectors(page);
      try { console.log(`  signal: ${await P.readSignal(page, copy)}`); }
      catch { console.log("  signal: (unreadable)"); }
    },
  };
}

// Wraps driver-browser's real withPage only to capture the page for the step
// logger above; the session lifecycle (create/wait/connect/stop) is untouched.
function withPageAndProbe(stepLogger) {
  return (opts, fn, deps) => driverBrowser.withPage(opts, (page, active) => {
    stepLogger.setPage(page);
    return fn(page, active);
  }, deps);
}

// Wraps the real posting-attempts.transition/annotate — same state machine,
// same edges — only adding the step-logger call after each write commits.
function attemptsWithLogging(stepLogger) {
  return {
    async transition(key, to, detail) {
      const out = await attemptsModule.transition(key, to, detail, new Date());
      await stepLogger.onStep(to);
      return out;
    },
    annotate: (key, detail) => attemptsModule.annotate(key, detail, new Date()),
  };
}

function buildCopyAndComment(seed) {
  const url = trackedUrl("https://forly.example/p/test", { session: "calib", group: seed });
  const copy = buildPostCopy(TEST_PAGE, url, { variantSeed: `calib${seed}`, linkInComment: true });
  return { copy, comment: url };
}

async function reserveCalibrationAttempt({ phone, kind, targetUrl, targetId, copyHash }) {
  return attemptsModule.reserveAttempt({
    phone,
    page_id: `calib-${crypto.randomBytes(6).toString("hex")}`, // a fresh dedup/budget key every run
    target_type: kind,
    target_id: targetId,
    target_url: targetUrl,
    copy_hash: copyHash,
    publisher: "calibration",
    campaign_id: "calibrate",
    limits: { daily_cap: 50, group_global_daily_cap: 50, dedup_days: 1 },
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const { ok, errors: preErrors, args } = (() => {
    const pre = checkPreconditions(process.env, argv);
    return { ok: pre.ok, errors: pre.errors, args: parseArgs(argv) };
  })();
  const usageErrors = ok ? validateTarget(args) : [];
  const errors = preErrors.concat(usageErrors);
  if (errors.length) {
    console.error("refusing to run:");
    for (const e of errors) console.error(`  - ${e}`);
    console.error("\nsee the file header for usage.");
    process.exit(2);
  }

  const kind = args.pageUrl ? "page" : "group";
  const targetUrl = args.pageUrl || args.groupUrl;
  const slug = P.urlSegment(targetUrl, kind);
  if (!slug) { console.error(`could not read a ${kind} slug from that URL`); process.exit(2); return; }
  const targetId = kind === "group" ? `slug:${slug}` : String(args.pageId);

  const { copy, comment } = buildCopyAndComment(slug);
  const copyHash = sha(copy);

  const reserved = await reserveCalibrationAttempt({ phone: args.phone, kind, targetUrl, targetId, copyHash });
  if (!reserved.ok) { console.error(`could not reserve an attempt: ${reserved.reason}`); process.exit(1); return; }
  const attempt = reserved.attempt;

  const conn = {
    facebook_identity_label: args.identity,
    facebook_profile_gen: 0,
    posting_permission: { enabled: true, platforms: ["facebook"], allows_visible_interactions: true },
    facebook_pages: kind === "page" ? [{ id: String(args.pageId), url: targetUrl, name: args.pageName || null }] : undefined,
  };
  // A fake db: only what posting-guard.assertAllowed reads. The real guard
  // logic runs unmodified — this just keeps it off the real connections store
  // and the real settings doc. The guard is off unless switched on (the env's
  // POSTING_ENABLED=1, and a settings/posting doc with enabled: true).
  const fakeDb = { getSetting: async (k) => (k === "posting" ? { enabled: true } : null), getConnection: async () => conn };

  const stepLogger = makeStepLogger(copy);
  const deps = { conn, db: fakeDb, attempts: attemptsWithLogging(stepLogger), withPage: withPageAndProbe(stepLogger) };

  console.log(`mode=${args.live ? "LIVE" : "dry run"} kind=${kind} phone=${redactPhone(args.phone)} target=${targetUrl}`);
  console.log(`copy: ${copy.length} chars, hash ${copyHash.slice(0, 8)}… — read it in the composer, not here`);

  const call = kind === "group" ? PD.postToGroup : PD.postToPage;
  const callArgs = Object.assign(
    { attempt, copy, comment, dryRun: !args.live },
    kind === "group" ? { groupUrl: targetUrl } : { pageUrl: targetUrl },
  );

  let out;
  try { out = await call(callArgs, deps); }
  catch (e) { console.error(driverBrowser.redact(`FAIL ${e && e.code ? e.code : ""}: ${e && e.message}`)); process.exit(1); return; }

  console.log("\n=== result ===");
  console.log(driverBrowser.redact(JSON.stringify(out, null, 2)));

  const success = args.live ? out.state === "verified_posted" : out.state === "cancelled" && out.dry_run === true;
  process.exit(success ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => { console.error(driverBrowser.redact(`FAIL: ${e && e.message}`)); process.exit(1); });
}

module.exports = { checkPreconditions, parseArgs, validateTarget, _test: { buildCopyAndComment } };
