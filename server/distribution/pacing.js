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

/*
 * Cross-agent spacing into ONE group. Per-account limits don't catch this:
 * twenty agents posting once each is twenty normal humans, but several of
 * them landing in the same group within a minute or two is what a member
 * (and an admin) notices.
 *
 * It can be short, because the two things that made it dangerous are gone:
 * each agent's text is a different variant, and the shared link is the
 * Facebook post rather than a repeated external domain. What remains is
 * human perception, and a group that receives hundreds of posts a day does
 * not notice two listings twenty minutes apart. Big groups absorb more, so
 * the gap scales down with membership.
 */
const GROUP_GAP_MIN_MS = 10 * 60 * 1000;   // busy groups (50k+ members)
const GROUP_GAP_MAX_MS = 20 * 60 * 1000;   // small groups
const BUSY_GROUP_MEMBERS = 50000;

function groupGapMs(members) {
  const n = Number(members) || 0;
  return n >= BUSY_GROUP_MEMBERS ? GROUP_GAP_MIN_MS : GROUP_GAP_MAX_MS;
}

/*
 * Steady-state ceiling for a fully warmed-up agent. Twelve posts spread over
 * a twelve-hour window is roughly one an hour — busy, but squarely inside
 * what an active professional does by hand. Lower it for a cautious pilot
 * with DISTRIBUTION_DAILY_CAP; a new agent never starts here anyway, the
 * warm-up ramp below takes two weeks to reach it.
 */
const DAILY_CAP = Math.max(1, Math.min(20,
  Number(process.env.DISTRIBUTION_DAILY_CAP) || 12));
const WARMUP_START = 2;              // day-1 ceiling for a new agent
const WARMUP_DAYS = 14;              // days to ramp from START to CAP
const MIN_GAP_MS = 4 * 60 * 1000;    // never two posts inside 4 minutes
const MAX_GAP_MS = 20 * 60 * 1000;   // upper end of the randomized gap
/*
 * Rest between DIFFERENT properties in the same group. One post per group per
 * day is what these listing groups' own rules typically permit, so this is
 * the group's rule rather than a limit invented on top of it. It is also the
 * single biggest lever on how long a backlog takes to clear: at 48h an agent
 * with 40 listings needed a month, at 24h it halves. The "same property never
 * twice in the same group" rule below stays absolute either way.
 */
const GROUP_COOLDOWN_MS = 24 * 60 * 60 * 1000;
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
function canPost(state, { groupUrl, pageId, groupLastPostAt, groupMembers, joined },
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
  if (groupLast && now - groupLast < GROUP_COOLDOWN_MS) {
    return { ok: false, reason: "group_cooldown",
      retry_at: new Date(groupLast + GROUP_COOLDOWN_MS).toISOString() };
  }

  // Platform-wide spacing for this group, across every Forly agent.
  if (groupLastPostAt) {
    const gap = groupGapMs(groupMembers);
    const stamp = new Date(groupLastPostAt).getTime();
    if (now - stamp < gap) {
      return { ok: false, reason: "group_busy",
        retry_at: new Date(stamp + gap).toISOString() };
    }
  }

  // Membership is VERIFIED, not guessed: the extension syncs the groups the
  // agent actually belongs to, so posting into a group they never joined —
  // the fastest route to a spam report — simply cannot be scheduled.
  // `joined === undefined` means "not synced yet", which stays permitted.
  if (joined === false) return { ok: false, reason: "not_a_member" };

  return { ok: true, remaining_today: cap - today.length };
}

// The gap the client must wait before the NEXT post. Randomized on purpose:
// a constant cadence is the clearest automation tell there is.
function nextGapMs(rand = Math.random) {
  return Math.round(MIN_GAP_MS + rand() * (MAX_GAP_MS - MIN_GAP_MS));
}

function recordPost(state, { groupUrl, pageId }, { now = Date.now() } = {}) {
  const s = state || {};
  // Keep a week of history: longer than any cooldown, short enough that the
  // doc can't grow without bound.
  const posts = (Array.isArray(s.posts) ? s.posts : [])
    .filter((p) => now - new Date(p.at).getTime() < 7 * DAY_MS);
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
  GROUP_COOLDOWN_MS, LOCKOUT_MS, HOUR_START, HOUR_END,
  GROUP_GAP_MIN_MS, GROUP_GAP_MAX_MS, BUSY_GROUP_MEMBERS,
  localHour, dailyCap, groupGapMs, canPost, nextGapMs, recordPost, lock,
};
