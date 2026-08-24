/*
 * distribution/pacing.js — the safety engine for assisted group posting.
 *
 * Facebook doesn't ban "posting to groups"; it bans PATTERNS. This module is
 * the single place those patterns are prevented, and it runs SERVER-side so a
 * tampered extension can't post its way around it:
 *
 *   • velocity   — a daily cap plus a randomized gap between posts. Fixed
 *                  intervals look more robotic than high volume does, so the
 *                  gap is jittered, never constant.
 *   • warm-up    — a brand-new agent starts at 2 posts/day and ramps over two
 *                  weeks, the way a real person's usage grows.
 *   • hours      — nothing outside 09:00–21:00 Israel time. Nobody posts
 *                  listings at 04:00; that alone flags an account.
 *   • cooldown   — the same group is never touched twice within COOLDOWN_DAYS,
 *                  and the same property never goes to the same group twice.
 *   • lockout    — one checkpoint/block report freezes the agent for 24h.
 *
 * Pure functions: `now` and `rand` are injected so the tests are deterministic.
 */

// Cross-agent spacing into ONE group. Per-account limits don't catch this:
// twenty agents posting once each is twenty normal humans, but several of
// them hitting the same group with the same domain inside a few minutes is
// the coordinated-behavior signal — and the admin sees a burst of Forly
// posts. So one group receives at most one Forly post every few hours,
// across the entire platform.
const GROUP_GLOBAL_GAP_MS = 3 * 60 * 60 * 1000;
// A group the agent only just added is a group they aren't a real member of
// yet. Posting into it on day one is the fastest way to get reported.
const MEMBERSHIP_MIN_DAYS = 7;

const DAILY_CAP = 8;                 // steady-state ceiling per agent
const WARMUP_START = 2;              // day-1 ceiling for a new agent
const WARMUP_DAYS = 14;              // days to ramp from START to CAP
const MIN_GAP_MS = 4 * 60 * 1000;    // never two posts inside 4 minutes
const MAX_GAP_MS = 20 * 60 * 1000;   // upper end of the randomized gap
const COOLDOWN_DAYS = 7;             // per-group rest between posts
const LOCKOUT_MS = 24 * 60 * 60 * 1000;
const HOUR_START = 9;                // Israel local
const HOUR_END = 21;

const DAY_MS = 24 * 60 * 60 * 1000;

// Israel local hour without pulling in a tz library: Asia/Jerusalem is the
// only zone this product serves, and Intl is in the standard library.
function localHour(date) {
  const h = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem", hour: "2-digit", hour12: false,
  }).format(date);
  return Number(h);
}

// A new agent must not behave like a power user on day one.
function dailyCap(firstPostAt, now) {
  if (!firstPostAt) return WARMUP_START;
  const days = Math.floor((now - new Date(firstPostAt).getTime()) / DAY_MS);
  if (days >= WARMUP_DAYS) return DAILY_CAP;
  const ramp = (DAILY_CAP - WARMUP_START) * (days / WARMUP_DAYS);
  return Math.max(WARMUP_START, Math.round(WARMUP_START + ramp));
}

/*
 * Can this agent post to this group right now?
 * state: {
 *   first_post_at, locked_until,
 *   posts: [{ at, group_url, page_id }]   // recent history, newest anywhere
 * }
 * Returns { ok } or { ok:false, reason, retry_at } — reason is a stable code
 * the UI maps to Hebrew, never raw text.
 */
function canPost(state, { groupUrl, pageId, groupLastPostAt, groupAddedAt },
  { now = Date.now() } = {}) {
  const s = state || {};
  const posts = Array.isArray(s.posts) ? s.posts : [];
  const at = (p) => new Date(p.at).getTime();

  if (s.locked_until && new Date(s.locked_until).getTime() > now) {
    return { ok: false, reason: "locked", retry_at: new Date(s.locked_until).toISOString() };
  }

  const hour = localHour(new Date(now));
  if (hour < HOUR_START || hour >= HOUR_END) {
    return { ok: false, reason: "quiet_hours" };
  }

  const today = posts.filter((p) => now - at(p) < DAY_MS);
  const cap = dailyCap(s.first_post_at, now);
  if (today.length >= cap) {
    return { ok: false, reason: "daily_cap", cap,
      retry_at: new Date(at(today[today.length - 1]) + DAY_MS).toISOString() };
  }

  const last = posts.reduce((m, p) => Math.max(m, at(p)), 0);
  if (last && now - last < MIN_GAP_MS) {
    return { ok: false, reason: "too_soon",
      retry_at: new Date(last + MIN_GAP_MS).toISOString() };
  }

  // Same property, same group — ever. This is the duplicate-post guard the
  // group admins actually notice.
  if (posts.some((p) => p.group_url === groupUrl && p.page_id === pageId)) {
    return { ok: false, reason: "already_posted_here" };
  }

  const groupLast = posts.filter((p) => p.group_url === groupUrl)
    .reduce((m, p) => Math.max(m, at(p)), 0);
  if (groupLast && now - groupLast < COOLDOWN_DAYS * DAY_MS) {
    return { ok: false, reason: "group_cooldown",
      retry_at: new Date(groupLast + COOLDOWN_DAYS * DAY_MS).toISOString() };
  }

  // Platform-wide spacing for this group, across every Forly agent.
  if (groupLastPostAt) {
    const since = now - new Date(groupLastPostAt).getTime();
    if (since < GROUP_GLOBAL_GAP_MS) {
      return { ok: false, reason: "group_busy",
        retry_at: new Date(new Date(groupLastPostAt).getTime() + GROUP_GLOBAL_GAP_MS).toISOString() };
    }
  }

  // Don't post into a group the agent joined/added days ago — practitioner
  // consensus (no official Meta figure exists) is 1–2 weeks of membership
  // before a first promotional post.
  if (groupAddedAt) {
    const age = now - new Date(groupAddedAt).getTime();
    if (age < MEMBERSHIP_MIN_DAYS * DAY_MS) {
      return { ok: false, reason: "too_new_in_group",
        retry_at: new Date(new Date(groupAddedAt).getTime() + MEMBERSHIP_MIN_DAYS * DAY_MS).toISOString() };
    }
  }

  return { ok: true, remaining_today: cap - today.length };
}

// The gap the client must wait before the NEXT post. Randomized on purpose:
// a constant cadence is the clearest automation tell there is.
function nextGapMs(rand = Math.random) {
  return Math.round(MIN_GAP_MS + rand() * (MAX_GAP_MS - MIN_GAP_MS));
}

function recordPost(state, { groupUrl, pageId }, { now = Date.now() } = {}) {
  const s = state || {};
  const posts = (Array.isArray(s.posts) ? s.posts : [])
    .filter((p) => now - new Date(p.at).getTime() < COOLDOWN_DAYS * DAY_MS * 2);
  posts.push({ at: new Date(now).toISOString(), group_url: groupUrl, page_id: pageId });
  return {
    ...s,
    first_post_at: s.first_post_at || new Date(now).toISOString(),
    posts,
    locked_until: null,
  };
}

// Any checkpoint, block, or unrecognised composer freezes the agent for a
// day. Backing off immediately is what keeps a warning from becoming a ban.
function lock(state, reason, { now = Date.now() } = {}) {
  return {
    ...(state || {}),
    locked_until: new Date(now + LOCKOUT_MS).toISOString(),
    lock_reason: String(reason || "unknown").slice(0, 80),
  };
}

module.exports = {
  DAILY_CAP, WARMUP_START, WARMUP_DAYS, MIN_GAP_MS, MAX_GAP_MS,
  COOLDOWN_DAYS, LOCKOUT_MS, HOUR_START, HOUR_END,
  GROUP_GLOBAL_GAP_MS, MEMBERSHIP_MIN_DAYS,
  localHour, dailyCap, canPost, nextGapMs, recordPost, lock,
};
