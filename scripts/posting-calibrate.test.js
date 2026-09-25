/* scripts/posting-calibrate.test.js — the refusal conditions (Task 24's
   adaptation notes): no env → refuse; phone not in the allowed list →
   refuse. Pure, no browser, no Driver, no network. */
const assert = require("assert");
process.env.PROFILE_KEY = process.env.PROFILE_KEY || "test-profile-key";
const { checkPreconditions, parseArgs, validateTarget } = require("./posting-calibrate.local.js");

const GOOD_ENV = { FORLY_ENV: "local", CALIBRATE_ACCOUNT_CONFIRMED: "1", CALIBRATE_TEST_PHONES: "972500000001,972500000002" };
const GOOD_ARGV = ["--phone", "972500000001"];

// ── every one of the three conditions is refused on its own ──
{
  const out = checkPreconditions({}, []);
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /FORLY_ENV/.test(e)));
  assert.ok(out.errors.some((e) => /CALIBRATE_ACCOUNT_CONFIRMED/.test(e)));
  assert.ok(out.errors.some((e) => /--phone/.test(e)));
}
{
  const out = checkPreconditions({ ...GOOD_ENV, FORLY_ENV: "prod" }, GOOD_ARGV);
  assert.equal(out.ok, false, "FORLY_ENV=prod must refuse even with everything else set");
  assert.ok(out.errors.some((e) => /FORLY_ENV/.test(e)));
}
{
  const out = checkPreconditions({ ...GOOD_ENV, FORLY_ENV: "staging" }, GOOD_ARGV);
  assert.equal(out.ok, false, "FORLY_ENV=staging must refuse too — only local");
}
{
  const out = checkPreconditions({ ...GOOD_ENV, CALIBRATE_ACCOUNT_CONFIRMED: undefined }, GOOD_ARGV);
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /CALIBRATE_ACCOUNT_CONFIRMED/.test(e)));
}
{
  const out = checkPreconditions({ ...GOOD_ENV, CALIBRATE_ACCOUNT_CONFIRMED: "yes" }, GOOD_ARGV);
  assert.equal(out.ok, false, "only the literal string \"1\" is accepted");
}

// ── phone must be present AND in the allowed list — never an agent's ──
{
  const out = checkPreconditions(GOOD_ENV, []);
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /--phone <phone> is required/.test(e)));
}
{
  const out = checkPreconditions(GOOD_ENV, ["--phone", "972599999999"]);
  assert.equal(out.ok, false, "a phone outside CALIBRATE_TEST_PHONES must refuse");
  assert.ok(out.errors.some((e) => /not listed in CALIBRATE_TEST_PHONES/.test(e)));
}
{
  const out = checkPreconditions(GOOD_ENV, GOOD_ARGV);
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  assert.equal(out.phone, "972500000001");
}
{
  // every condition wrong at once → every error reported, not just the first
  const out = checkPreconditions({}, []);
  assert.equal(out.errors.length, 3);
}
// a phone never appears in full in an error message
{
  const out = checkPreconditions(GOOD_ENV, ["--phone", "972599999999"]);
  assert.ok(!out.errors.join(" ").includes("972599999999"), "the refused phone must not appear in full");
  assert.ok(out.errors.join(" ").includes("…9999"), "only the redacted tail");
}

// ── parseArgs: the flags the preconditions and the target both read ──
{
  const a = parseArgs(["--phone", "p1", "--identity", "Name", "--group", "https://www.facebook.com/groups/1", "--live"]);
  assert.equal(a.phone, "p1");
  assert.equal(a.identity, "Name");
  assert.equal(a.groupUrl, "https://www.facebook.com/groups/1");
  assert.equal(a.live, true);
}
{
  const a = parseArgs(["--phone", "p1"]);
  assert.equal(a.live, false, "defaults to dry run");
}

// ── validateTarget: the usage contract beyond the three refusal conditions ──
{
  const errs = validateTarget(parseArgs(["--phone", "p1", "--identity", "N"]));
  assert.ok(errs.some((e) => /--group.*or --page/.test(e)));
}
{
  const errs = validateTarget(parseArgs(["--phone", "p1", "--identity", "N", "--group", "g", "--page", "p"]));
  assert.ok(errs.some((e) => /only one/.test(e)));
}
{
  const errs = validateTarget(parseArgs(["--phone", "p1", "--identity", "N", "--page", "https://www.facebook.com/x"]));
  assert.ok(errs.some((e) => /--page-id/.test(e)), "a Page needs its numeric id — never inferred");
}
{
  const errs = validateTarget(parseArgs(["--phone", "p1", "--group", "https://www.facebook.com/groups/1"]));
  assert.ok(errs.some((e) => /--identity/.test(e)));
}
{
  const errs = validateTarget(parseArgs(["--phone", "p1", "--identity", "N", "--group", "https://www.facebook.com/groups/1"]));
  assert.deepEqual(errs, []);
}

console.log("posting-calibrate: OK");
