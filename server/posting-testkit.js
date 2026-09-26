/* Shared fixtures for posting-campaign.test.js and posting-sweeper.test.js.
   Real db.js (memory path), real posting-store, real posting-guard and
   profile-lifecycle; the driver, WhatsApp and Driver API are fakes. Every
   time derives from NOW through a settable clock. Not a test itself. */
process.env.PROFILE_KEY = process.env.PROFILE_KEY || "test-profile-key-16b";
process.env.FORLY_ENV = "local";
const db = require("./db");
const store = require("./posting-store");
const locks = require("./profile-lock");
const safety = require("./posting-safety");

const NOW = new Date("2026-09-23T10:00:00+03:00"); // a Wednesday, no holiday
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const iso = (d) => new Date(d).toISOString();
// One post a day (daily_cap 1 → every day's target is 1), no jitter: deterministic.
const cfg = Object.assign(safety.configFrom(null), { daily_cap: 1, skip_day_probability: 0, day_start_jitter_min: 0, long_break_probability: 0, gap_jitter: 0 });
const G = (id) => `https://www.facebook.com/groups/${id}`;
const PERM = { enabled: true, consent_version: "2026-09-24", granted_at: iso(NOW.getTime() - DAY), platforms: ["facebook"], targets: ["groups"], default_group_ids: ["111", "222"], page_id: null, allows_dwell: true, allows_visible_interactions: false };
const member = (id, o = {}) => Object.assign({ group_id: id, canonical_url: G(id), slug: id, name: `G${id}`, membership_state: "member", observed_at: iso(NOW), last_confirmed_at: iso(NOW), id_verified: true }, o);
const page = (id = "pg1", phone = "972500000001", o = {}) => Object.assign({
  page_id: id, status: "active", business_phone: phone, created_at: new Date(NOW.getTime() - 30 * DAY),
  property: { title: "דירה בחיפה", city: "חיפה", listing_type: "sale", price: 2000000, rooms: 4 }, agent: { name: "דנה", phone: "0500000000" },
}, o);
const groups = [{ url: G(111), name: "A", agent_policy: "explicitly_allowed" }, { url: G(222), name: "B", agent_policy: "explicitly_allowed" }];
const fakeDriver = { stopSession: async () => {}, deleteProfile: async () => ({ ok: true }) };

function reset() {
  store._test.reset();
  locks._test.reset();
  for (const k of ["connections", "pages", "settings", "listings"]) db.mem[k].clear();
  db.mem.postActions.length = 0;
  db.mem.groupCatalog.length = 0;
  db.mem.settings.set("posting", { enabled: true, version: 1 });
}

// A driver that walks the attempt through the brief's states and ends as told:
// "verified_posted" | "submitted_for_approval" | "verified_failed:<code>" (after
// composer_ready) | { throwAt: "reserved"|"composer_ready", err }.
function fakePost(outcome = "verified_posted") {
  const calls = [];
  const fn = async (args, d) => {
    calls.push(args);
    const k = args.attempt.key;
    const o = typeof outcome === "function" ? outcome(calls.length) : outcome;
    if (o && o.throwAt === "reserved") throw o.err;
    await d.attempts.transition(k, "session_started");
    await d.attempts.transition(k, "composer_ready");
    if (o && o.throwAt === "composer_ready") throw o.err;
    if (typeof o === "string" && o.startsWith("verified_failed:")) {
      await d.attempts.transition(k, "verified_failed", { error_code: o.split(":")[1] });
      return o;
    }
    await d.attempts.transition(k, "submit_started");
    await d.attempts.transition(k, "verification_pending");
    await d.attempts.transition(k, o, o === "verified_posted" ? { post_url: `${args.groupUrl || args.pageUrl}/posts/999` } : {});
    return o;
  };
  fn.calls = calls;
  return fn;
}

async function setup(phone = "972500000001", o = {}) {
  reset();
  const clk = { t: NOW };
  await db.savePage(page("pg1", phone));
  await db.setConnection(phone, Object.assign({
    facebook_browser_connected_at: iso(NOW.getTime() - 90 * DAY), facebook_browser_first_connected_at: iso(NOW.getTime() - 90 * DAY),
    posting_account_aged: true, posting_posted_manually: true, posting_permission: structuredClone(PERM), // a copy: a merge must never write into PERM
    facebook_groups_member: [member("111"), member("222")], facebook_groups_synced_at: iso(NOW),
  }, o.conn || {}));
  const notes = [], ops = [];
  const deps = {
    // Posting is off unless switched on (I5), and runs only in prod or with
    // POSTING_SWEEPER=1 (C1): the fixtures run as a switched-on production.
    config: o.config || cfg, rand: () => 0, env: { POSTING_ENABLED: "1", FORLY_ENV: "prod" }, pageBaseUrl: "https://f.ly", driver: fakeDriver,
    clock: () => clk.t, post: o.post || fakePost(),
    notify: async (ph, m) => { notes.push(m); }, notifyOperator: async (m) => { ops.push(m); },
  };
  const at = (d) => { clk.t = new Date(d); return clk.t; };
  return { deps, notes, ops, clk, at, phone };
}
const base = (o = {}) => Object.assign({ phone: "972500000001", page: page(), groups, mode: "standing", days: 14, repeat: false, consent: { at: iso(NOW), version: "2026-09-24" } }, o);
const dueOf = (c, i = 0) => new Date(new Date(c.posts[i].scheduled_at).getTime() + 1000);

module.exports = { db, store, locks, safety, NOW, MIN, HOUR, DAY, iso, cfg, G, PERM, member, page, groups, fakeDriver, fakePost, reset, setup, base, dueOf };
