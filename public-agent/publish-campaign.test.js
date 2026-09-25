/*
 * The campaign card's pure helpers (publish-campaign.js, Task 23).
 *
 * The invariants under test: nothing the card renders can carry a live
 * browser (a viewer or wss:// URL) or a raw error message; every error code
 * has Hebrew; the first-post estimate never reads as a promise; the halt box
 * follows the account's halt class, and the defaults tick at most five usable groups.
 *
 * Run: node public-agent/publish-campaign.test.js
 */
const assert = require("node:assert");
const U = require("./publish-campaign.js");

let n = 0;
const t = (name, fn) => { fn(); n++; };

t("esc escapes every HTML metacharacter in a Facebook group name", () => {
  assert.strictEqual(U.esc(`<img src=x onerror="a('b')">&`), "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;");
  assert.strictEqual(U.esc(null), "");
});

t("fbUrl keeps https facebook.com links only", () => {
  assert.strictEqual(U.fbUrl("https://www.facebook.com/groups/123/posts/456"), "https://www.facebook.com/groups/123/posts/456");
  for (const bad of ["wss://connect.driver.dev/x", "https://viewer.driver.dev/s/1", "javascript:alert(1)", "http://www.facebook.com/groups/1",
    "https://evil.com/?https://www.facebook.com/", "https://www.facebook.com/groups/1\"onmouseover=x", "https://www.facebook.com/x?u=wss://h", null, 5]) {
    assert.strictEqual(U.fbUrl(bad), null, String(bad));
  }
});

t("every API error code has Hebrew, and a raw message never shows", () => {
  const codes = ["not_member", "unknown_group", "group_disallowed", "listing_type_not_allowed", "needs_reconnect", "page_not_confirmed",
    "profile_busy", "driver_busy", "consent_outdated", "consent_required", "facebook_not_connected", "too_many_campaigns", "unknown_page"];
  for (const code of codes) {
    const s = U.errorText({ code, message: "Error: wss://secret" });
    assert.ok(/[֐-׿]/.test(s) && !/wss|Error/.test(s), code);
    assert.notStrictEqual(s, U.errorText({ code: "something_else" }), `${code} has its own text`);
  }
  assert.match(U.errorText({ code: "too_soon", body: { retry_after_s: 290 } }), /5 דק/);
  assert.strictEqual(U.errorText(new Error("boom")), "משהו השתבש — נסו שוב.");
});

t("posting_disabled is worded by its reason", () => {
  const off = U.errorText({ code: "posting_disabled", body: { reason: "global_off" } });
  assert.match(off, /כבוי כרגע אצלנו/);
  assert.notStrictEqual(U.errorText({ code: "posting_disabled", body: { reason: "account_disabled" } }), off);
  assert.match(U.errorText({ code: "posting_disabled", body: { reason: "no_permission" } }), /לאשר מחדש/);
  assert.match(U.waitText("posting_disabled:platform_off"), /בפייסבוק כבוי/);
});

t("the first-post estimate says it is an estimate", () => {
  const s = U.estimateText("2026-10-01T08:30:00Z", null);
  assert.match(s, /בערך/);
  assert.match(s, /הערכה/);
  assert.ok(!/מובטח|בוודאות/.test(s));
  assert.match(U.estimateText(null, "browse_only"), /רק גוללת/);
  assert.strictEqual(U.estimateText(null, "unavailable"), "");
  assert.match(U.FIRST_WEEK, /1–3/);
  assert.match(U.FIRST_WEEK, /פוסט אחד ביום/);
});

t("halt boxes: one class per account state, strongest first", () => {
  const running = { status: "running" };
  assert.strictEqual(U.haltInfo({ owner_review_required: true, disabled_until_admin: true }, running).cls, "owner");
  const team = U.haltInfo({ disabled_until_admin: true, needs_reconnect: true }, running);
  assert.strictEqual(team.cls, "team"); assert.ok(team.verify && !team.resume);
  const rc = U.haltInfo({ needs_reconnect: true }, { status: "paused", pause_reason: "account" });
  assert.strictEqual(rc.cls, "reconnect"); assert.ok(rc.reconnect && !rc.resume);
  assert.ok(U.haltInfo({}, { status: "paused", pause_reason: "account" }).resume, "a lifted halt lets the agent resume");
  assert.ok(U.haltInfo({}, { status: "paused", pause_reason: "consecutive_failures" }).resume);
  assert.ok(U.haltInfo({}, { status: "paused", pause_reason: "permission" }).reconsent);
  assert.strictEqual(U.haltInfo({}, { status: "running", wait_reason: "posting_disabled:global_off" }).cls, "off");
  assert.strictEqual(U.haltInfo({ penalty_until: "2026-10-09T00:00:00Z" }, running).cls, "penalty");
  assert.strictEqual(U.haltInfo({}, running), null);
  assert.strictEqual(U.haltInfo(null, null), null);
  // Worded like posting-messages.js.
  assert.match(U.HALT.reconnect, /החיבור לחשבון הפייסבוק פג/);
  assert.match(U.HALT.consecutive_failures, /שני פוסטים ברצף לא עלו/);
});

t("default picks: saved defaults first, at most five, never an unusable group", () => {
  const g = (id, extra) => Object.assign({ group_id: id, membership_state: "member", agent_policy: "unknown", in_catalog: false }, extra);
  const list = [g("1"), g("2", { agent_policy: "explicitly_allowed", in_catalog: true }), g("3", { agent_policy: "no_agents" }),
    g("4", { membership_state: "left" }), g("5"), g("6"), g("7"), g("8")];
  const d = U.defaultPicks(list);
  assert.strictEqual(d.length, 5);
  assert.strictEqual(d[0], "2");
  assert.ok(!d.includes("3") && !d.includes("4"));
  assert.deepStrictEqual(U.defaultPicks(list.map((x) => (x.group_id === "5" || x.group_id === "3" ? Object.assign({}, x, { is_default: true }) : x))), ["5"]);
  assert.deepStrictEqual(U.defaultPicks(undefined), []);
});

t("timeline texts", () => {
  assert.strictEqual(U.statusText({ status: "skipped", error_code: "stopped" }), "בוטל בעצירה");
  assert.strictEqual(U.statusText({ status: "pending_approval" }), "ממתין לאישור שלכם");
  const m = U.metricsText({ visits: 12, leads: 2, reactions: 5, comments: null, visibility: "confirmed_removed" });
  assert.match(m, /12 כניסות/); assert.match(m, /2 לידים/); assert.match(m, /5 לייקים/); assert.match(m, /הוסר/);
  assert.ok(!/תגובות ·|null/.test(m));
  assert.strictEqual(U.metricsText(null), "");
  assert.match(U.REACH_NOTE, /reach/);
  assert.match(U.planText("per_post", 3, false), /וואטסאפ/);
  assert.match(U.planText("standing", 1, true), /קבוצה ובדף העסקי/);
  assert.strictEqual(U.chipText({ status: "completed", posts: [{ status: "posted" }, { status: "skipped" }] }), "הושלם — 1 פוסטים עלו");
});

t("a restarted campaign's earlier posts are history", () => {
  const c = { restarted_at: "2026-09-20T00:00:00Z", posts: [
    { id: "a", status: "posted", posted_at: "2026-09-10T10:00:00Z" },
    { id: "b", status: "skipped", error_code: "stopped", scheduled_at: "2026-09-21T10:00:00Z" },
    { id: "c", status: "scheduled", scheduled_at: "2026-09-22T10:00:00Z" }] };
  const { current, earlier } = U.splitPasses(c);
  assert.deepStrictEqual(current.map((p) => p.id), ["c"]);
  assert.deepStrictEqual(earlier.map((p) => p.id), ["a", "b"]);
  assert.strictEqual(U.splitPasses({ posts: [{ id: "x" }] }).current.length, 1);
});

console.log(`publish-campaign.test.js: ${n} passed`);
