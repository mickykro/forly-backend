#!/usr/bin/env node
/*
 * How long did each automatic post take, and how long was its dwell?
 * One row per posting attempt, from the attempt's own step history. Read-only.
 *
 *   cd server && GOOGLE_APPLICATION_CREDENTIALS=<key> node ../scripts/posting-timings.local.js [--hours 24] [--campaign <id>]
 *
 * Columns (seconds):
 *   wait     reserved → session_started   (browser / profile lock)
 *   dwell    the feed dwell before this post (dwell_ms; chained posts: the dwell since the previous post)
 *   open     session_started → composer_ready, minus a first post's dwell (page loads, group checks)
 *   compose  composer_ready → submit_started (video upload + typing)
 *   verify   submit_started → finished (submit, then confirming it is live)
 *   total    reserved → finished
 * Uses the key's own project, never GOOGLE_CLOUD_PROJECT.
 */
const fs = require("fs");
const admin = require("../server/node_modules/firebase-admin");

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const hours = Number(opt("--hours") || 24);
const campaign = opt("--campaign");
const key = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!key || !(hours > 0)) { console.error("usage: GOOGLE_APPLICATION_CREDENTIALS=<key> posting-timings.local.js [--hours N] [--campaign id]"); process.exit(1); }
admin.initializeApp({ projectId: JSON.parse(fs.readFileSync(key, "utf8")).project_id });
const db = admin.firestore();

const ms = (v) => (v ? new Date(v.toDate ? v.toDate() : v).getTime() : NaN);
const sec = (n) => (Number.isFinite(n) && n >= 0 ? (n / 1000).toFixed(0) : "-");

// stepTimes(history) → { state: ms } (first time each state was reached)
function stepTimes(history) {
  const t = {};
  for (const h of history || []) if (h && h.state && !(h.state in t)) t[h.state] = ms(h.at);
  return t;
}

// row(attempt) → the columns above, as numbers in ms (NaN when a step never happened)
function row(a) {
  const t = stepTimes(a.history);
  const end = ms(a.finished_at);
  const dwell = Number.isFinite(a.dwell_ms) ? a.dwell_ms : NaN;
  const chained = Number.isFinite(dwell) && t.session_started && t.composer_ready && t.composer_ready - t.session_started < dwell; // its dwell came before session_started
  return {
    wait: t.session_started - t.reserved, dwell,
    open: t.composer_ready - t.session_started - (chained || !Number.isFinite(dwell) ? 0 : dwell),
    compose: t.submit_started - t.composer_ready, verify: end - t.submit_started, total: end - t.reserved,
  };
}

(async () => {
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const q = db.collection("posting_attempts").where("reserved_at", ">=", since);
  const docs = (await q.get()).docs.map((d) => d.data()).filter((a) => !campaign || a.campaign_id === campaign)
    .sort((x, y) => String(x.reserved_at).localeCompare(String(y.reserved_at)));
  console.log(`${docs.length} attempts since ${since}${campaign ? ` for campaign ${campaign}` : ""} (seconds)`);
  const cols = ["wait", "dwell", "open", "compose", "verify", "total"];
  console.log(["reserved (UTC)      ", "campaign", "group               ", "state              ", ...cols].join("\t"));
  for (const a of docs) {
    const r = row(a);
    console.log([String(a.reserved_at).slice(0, 19), String(a.campaign_id || "").slice(0, 8), String(a.target_id || "").slice(0, 20).padEnd(20),
      String(a.state).padEnd(19), ...cols.map((c) => sec(r[c]))].join("\t"));
  }
})().catch((e) => { console.error(e); process.exit(1); });

