// server/posting-limits.js
/*
 * posting-limits.js — automatic posting's group limits, for posting by hand.
 * The manual tab posts with none of the pacer's rules; these are the two that
 * protect the groups and the account: at most group_daily_cap of the agent's
 * posts in one group a day, and the same property not back in a group within
 * property_group_cooldown_days (or the campaign's repeat interval). Same
 * function as the pacer (posting-safety.groupBlock), fed the agent's manual
 * posts. Plus a duration estimate for a set of posts at today's limits —
 * an estimate, never a promise.
 */
const safety = require("./posting-safety");
const A = require("./posting-account");

const DAY = 86400000;

// The agent's posts done by hand, from all their campaigns, last `days` days
// (at least 8; a repeat interval needs its own length plus a day).
function manualPosts(campaigns, now, days = 8) {
  const out = [];
  for (const c of campaigns || []) {
    for (const p of c.posts || []) {
      if (p.status !== "posted" || !p.posted_at || !p.group_id) continue;
      const t = new Date(p.posted_at).getTime();
      if (Number.isFinite(t) && now.getTime() - t < days * DAY) out.push({ t, ms: t, group_id: String(p.group_id), page_id: c.page_id });
    }
  }
  return out;
}

function limitsFor(c, campaigns, now, config) {
  const posts = manualPosts(campaigns, now, Math.max(8, (Number(c.repeat_days) || 0) + 1));
  const dateOf = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); // as groupBlock's "today"
  const today = dateOf(now);
  const out = {};
  for (const g of c.groups || []) {
    const id = String(g.group_id);
    const b = safety.groupBlock({ group_id: id, aliases: [], repeat_days: c.repeat_days || null },
      { now, posts, pageId: c.page_id, fp: null, groupActivity: {}, config });
    out[id] = {
      today: posts.filter((p) => p.group_id === id && dateOf(new Date(p.t)) === today).length,
      cap: config.group_daily_cap,
      block: b && (b.why === "group_daily_cap" || b.why === "property_cooldown") ? { why: b.why, until: b.until || null } : null,
    };
  }
  return out;
}

// The day's random target averages 3/4 of the cap; about 3 sessions of
// MAX_SESSION_POSTS fit the two posting windows; Friday has one window;
// one active day in five is skipped (skip_day_probability).
function estimate({ posts, account, now, config, daysLeft }) {
  const daily = safety._test.dailyCapFor(account, now, config);
  const perDay = Math.min(Math.round(daily * 0.75), 3 * A.MAX_SESSION_POSTS);
  const friday = Math.min(perDay, A.MAX_SESSION_POSTS);
  const perWeek = Math.min(safety._test.weeklyCapFor(account, now, config), Math.round((5 * perDay + friday) * (1 - config.skip_day_probability)));
  const days = perWeek > 0 ? Math.ceil((posts / perWeek) * 7) : null;
  return { posts, per_week: perWeek, days, fits: days !== null && days <= daysLeft, days_left: daysLeft, warmup: daily < config.daily_cap };
}

module.exports = { limitsFor, estimate, manualPosts };
