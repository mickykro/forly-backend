/*
 * posting-chain.js — more than one post in one browser session (2 Oct 2026).
 *
 * When an account has several posts ready, the browser that just posted one
 * stays open: the driver dwells on the feed for a random 1.5–5.8 minutes,
 * then posts the next, in the same session, without a new login or a new
 * warm-up of the feed. Every post is still its own reservation (R1), re-checked
 * against the switches (R2), the account's caps and the agent's approval:
 * only an approved post (or a standing campaign's next one) is taken, never
 * one the agent set for a later time, and the account's own min_gap gives way
 * to the dwell only inside the session. Any outcome but a clean post ends the
 * session: nothing is pushed after a failure or a halt.
 *
 * POSTING_CHAIN=0 turns it off (one post per session, as before).
 */
const A = require("./posting-account");
const C = require("./posting-campaign");
const safety = require("./posting-safety");

const { ms, MS_MIN, configOf } = A;
const MAX_POSTS = A.MAX_SESSION_POSTS;        // per session, the first included
const DWELL_S = [90, 348];                    // between posts: 1.5–5.8 minutes
const POST_BUDGET_MS = 12 * MS_MIN;           // a dwell and a post must still fit in the session
const SESSION_MS = (env) => Math.max(14, Number((env || process.env).POSTING_SESSION_MINUTES) || 55) * MS_MIN; // Driver's limit is 1 hour
const OK = new Set(["verified_posted", "submitted_for_approval"]);

const enabled = (deps = {}) => (deps.env || process.env).POSTING_CHAIN !== "0";

// Inside the session the account's gap is the dwell itself.
const sessionConfig = (config) => Object.assign({}, config, { min_gap_minutes: 1, gap_jitter: 0, long_break_probability: 0, day_start_jitter_min: 0 });

// The account's next post that may go now: an approved (or standing) one
// already planned — not one set for later by the agent — else one planned now.
async function prepareNext(phone, deps, x, now) {
  const T = require("./posting-tick");
  const config = sessionConfig(await configOf(deps, x));
  const d = Object.assign({}, deps, { config });
  const conn = (await x.db.getConnection(phone)) || {};
  const ready = (campaigns) => campaigns.filter((c) => c.status === "running")
    .flatMap((c) => (c.posts || []).filter((p) => p.status === "scheduled" && (!p.not_before || ms(p.not_before) <= now.getTime())).map((p) => ({ c, p })))
    .sort((a, b) => ms(a.p.scheduled_at) - ms(b.p.scheduled_at))[0];
  let campaigns = await x.store.listPostingCampaignsByPhone(phone);
  if (campaigns.some((c) => (c.posts || []).some((p) => p.status === "posting"))) return null;
  let due = ready(campaigns);
  if (!due) {
    const decision = await C.planAccount(phone, d, now, { conn, config, campaigns });
    if (!decision || !decision.campaignId || ms(decision.at) > now.getTime() + 2 * MS_MIN) return null;
    await C.schedulePost(Object.assign({}, decision, { at: now }), d, now);
    campaigns = await x.store.listPostingCampaignsByPhone(phone);
    due = ready(campaigns); // a per-post campaign's new post waits for the agent: not taken
    if (!due) return null;
  }
  const r = await T.runDue(due.c, due.p, { phone, conn, config, campaigns, lock: null, prepareOnly: true }, d, x, now);
  return r && r.prepared ? r : null;
}

// One per browser session: how many it posted, since when.
function session(phone, deps, x, lock) {
  const started = Date.now();
  let posts = 1;
  const budget = SESSION_MS(deps.env) - POST_BUDGET_MS;
  return {
    more: (state) => OK.has(state) && posts < MAX_POSTS && Date.now() - started < budget,
    prepare: async () => {
      if (Date.now() - started >= budget) return null;
      if (lock && lock.renew && !lock.renew()) return null; // our hold lapsed: the profile is someone else's
      const nx = await prepareNext(phone, deps, x, x.clock()).catch(() => null);
      if (nx) posts++;
      return nx;
    },
  };
}

const dwellMs = (rand = Math.random) => Math.round((DWELL_S[0] + rand() * (DWELL_S[1] - DWELL_S[0])) * 1000);

module.exports = { enabled, session, prepareNext, sessionConfig, dwellMs, SESSION_MS, MAX_POSTS, DWELL_S };
