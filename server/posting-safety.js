/*
 * posting-safety.js — when may this account post, and where.
 *
 * Pure functions. Everything that decides whether a post happens lives here,
 * so the promise "the agent's account never looks like a bot" is a set of unit
 * tests rather than a hope.
 *
 * [Unverified] None of DEFAULTS was measured against Facebook. They sit well
 * below what an active human agent does by hand; Task 24 calibrates over 30
 * days. After any signal, a default only ever moves DOWN.
 *
 * Three ideas carry the design:
 *  - shape, not just rate: a real person does not start at 09:00 sharp every
 *    day and post the same count; dayPlan() gives each day its own start,
 *    its own target, and a one-in-five chance of nothing at all;
 *  - the account's history matters more than ours: two questions at connect
 *    time (is the Facebook account older than six months? has it posted in
 *    these groups by hand?) double the warm-up when the answer is no;
 *  - a checkpoint is a stop, not a pause: automation for that account ends
 *    until a person at Forly turns it back on.
 *
 * Time is Jerusalem time throughout (R7): every daily bucket, cap and
 * warm-up day is keyed by the Asia/Jerusalem calendar date via Intl, never
 * 24h arithmetic, so DST transitions never shift a bucket.
 *
 * Reservations are the caller's job (Task 16, R1): account.posts already
 * includes reserved/submit_started/outcome_unknown attempts as `ok: null`,
 * and a late manual report never revokes a reservation already issued — the
 * next slot simply moves. Groups are identified by group_id (Task 14): the
 * numeric id, or "slug:<slug>" until resolved; posts are matched to
 * candidates by group_id, falling back to group_url only when a post
 * predates group_id.
 */
const crypto = require("crypto");
const { normalizeCity } = require("./distribution/city-normalize");

const DEFAULTS = {
  timezone: "Asia/Jerusalem",
  active_hours: { start: 9, end: 21 },
  shabbat: { start_dow: 5, start_hour: 15, end_dow: 6, end_hour: 20 },
  // Yom Kippur, Rosh Hashana, Pesach (first/last), Shavuot, Sukkot (first), Simchat Torah — 5787 & 5788.
  holidays: ["2026-09-12", "2026-09-13", "2026-09-21", "2026-09-26", "2026-10-03", "2027-04-22", "2027-04-28", "2027-06-11",
             "2027-10-02", "2027-10-03", "2027-10-11", "2027-10-16", "2027-10-23"],
  min_gap_minutes: 120,
  gap_jitter: 0.8,                  // adds up to +80% of the gap, never subtracts
  long_break_probability: 0.25,     // sometimes the gap is 3–5 hours, like a person with a job
  daily_cap: 3,
  weekly_cap: 12,
  day_start_jitter_min: 150,        // the first post of a day lands 0–150 min after active_hours.start
  skip_day_probability: 0.2,        // one active day in five, nothing at all
  // Explicit, inclusive day ranges counted from first_connected_at in Jerusalem
  // calendar days (day 1 = the connect day). After the last range: daily_cap.
  warmup: [
    { start_day: 1, end_day: 3, daily_post_cap: 0, daily_browse_cap: 1 },
    { start_day: 4, end_day: 7, daily_post_cap: 1, daily_browse_cap: 1 },
    { start_day: 8, end_day: 21, daily_post_cap: 2, skipped_day_browse_probability: 0.5 },
  ],
  warmup_multiplier_if_unsure: 2,   // account_aged === false or posted_manually === false
  browse_sessions_per_day: 1,       // on browse-only days, and with p=0.5 on skipped days later
  group_global_daily_cap: 3,        // across ALL Forly accounts, per group, per day
  fingerprint_window_days: 7,       // another account posted the same listing to this group
  group_cooldown_days: 7,
  property_group_cooldown_days: 14,
  penalty_days: 14,                 // after rate_limited / feature_blocked
  penalty_cap_divisor: 2,
  halts_window_days: 30,
  halts_to_disable: 2,
  max_consecutive_failures: 2,
};

const MS_MIN = 60000, MS_HOUR = 3600000, MS_DAY = 24 * MS_HOUR;

function localParts(date, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, weekday: "short", hour: "numeric", minute: "numeric" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), hour: Number(p.hour) % 24, minute: Number(p.minute) };
}
const localDate = (date, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

function inShabbat({ dow, hour }, sh) {
  if (dow === sh.start_dow) return hour >= sh.start_hour;
  if (dow === sh.end_dow) return hour < sh.end_hour;
  return false;
}
function isActiveTime(date, config = DEFAULTS) {
  const lp = localParts(date, config.timezone);
  if (config.shabbat && inShabbat(lp, config.shabbat)) return false;
  if ((config.holidays || []).includes(localDate(date, config.timezone))) return false;
  return lp.hour >= config.active_hours.start && lp.hour < config.active_hours.end;
}
function nextActiveTime(from, config) {
  let t = new Date(from.getTime());
  for (let i = 0; i < 10 * 96; i++) { if (isActiveTime(t, config)) return t; t = new Date(t.getTime() + 15 * MS_MIN); }
  return t;
}

// A stable per-day random source, so every tick that day agrees on the plan.
function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return () => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h / 4294967296; };
}
function dayPlan(localDay, config = DEFAULTS, _rand) {
  const r = seeded(String(localDay));
  if (r() < config.skip_day_probability) return { start_offset_min: 0, target: 0 };
  return { start_offset_min: Math.floor(r() * config.day_start_jitter_min), target: 1 + Math.floor(r() * config.daily_cap) };
}

// The group_activity/{group_id}|{date} doc id (Task 16 writes it, R7: the
// Jerusalem calendar date, never the UTC date).
function activityKey(group_id, date) { return `${group_id}|${localDate(date, DEFAULTS.timezone)}`; }

// settings/posting may override a small, explicit allowlist of DEFAULTS
// without a deploy. Anything else in `settings` — and any non-positive-
// integer override — is ignored, so nextSlot stays pure and predictable.
function configFrom(settings) {
  const out = Object.assign({}, DEFAULTS);
  const v = settings && settings.group_global_daily_cap;
  if (Number.isInteger(v) && v > 0) out.group_global_daily_cap = v;
  return out;
}

// price rounded to a flat bucket: `div` sets how coarse the bucket is
// ("price2" = tight, "price5" = loose), the same shape for both tiers.
const priceBucket = (price, div) => Math.round((Number(price) || 0) / div);
const sqmBucket = (sqm) => (sqm === undefined || sqm === null || sqm === "" || !Number.isFinite(Number(sqm)) ? "" : Math.floor(Number(sqm) / 5));

// Same listing, whoever posted it — three tiers of confidence, each an HMAC
// so the global index (group_activity.fingerprints) stores no readable
// attribute, only tokens keyed by PROFILE_KEY.
//  - exact:  street/project known → city|street_or_project|rooms|floor|sqm|price2;
//            else an imported listing's own source id; else null (no exact tier).
//  - strong: city|rooms|sqm±5|price2 — a near-duplicate: skip AND flag for review.
//  - weak:   city|rooms|price5 — plausibly the same listing: not a block, just ranked last.
function fingerprint(prop = {}, key = process.env.PROFILE_KEY) {
  if (!key) throw new Error("fingerprint: PROFILE_KEY required");
  const p = prop || {};
  const city = normalizeCity(p.city);
  const rooms = p.rooms ?? "";
  const price2 = priceBucket(p.price, 2000);
  const price5 = priceBucket(p.price, 5000);
  const streetOrProject = p.street || p.project || null;
  let exactMaterial = null;
  if (streetOrProject) exactMaterial = `${city}|${streetOrProject}|${rooms}|${p.floor ?? ""}|${p.size_sqm ?? ""}|${price2}`;
  else if (p.source_url || p.source_id) exactMaterial = `src|${p.source_url || p.source_id}`;
  const strongMaterial = `${city}|${rooms}|${sqmBucket(p.size_sqm)}|${price2}`;
  const weakMaterial = `${city}|${rooms}|${price5}`;
  const hmac = (material) => crypto.createHmac("sha256", key).update(material).digest("hex").slice(0, 24);
  return { exact: exactMaterial ? hmac(exactMaterial) : null, strong: hmac(strongMaterial), weak: hmac(weakMaterial) };
}

// Calendar days in Asia/Jerusalem, not 24-hour spans: day 1 is the connect day.
function dayNumber(account, now, config) {
  const d0 = localDate(new Date(account.first_connected_at), config.timezone), d1 = localDate(now, config.timezone);
  return Math.round((Date.UTC(...d1.split("-").map(Number).map((x, i) => (i === 1 ? x - 1 : x))) - Date.UTC(...d0.split("-").map(Number).map((x, i) => (i === 1 ? x - 1 : x)))) / MS_DAY) + 1;
}
function warmupStage(account, now, config) {
  const mult = (account.account_aged === false || account.posted_manually === false) ? config.warmup_multiplier_if_unsure : 1;
  const day = dayNumber(account, now, config);
  return config.warmup.find((w) => day >= w.start_day * mult - (mult - 1) && day <= w.end_day * mult) || null;
}
const wantsBrowseSession = (account, now, config) => { const w = warmupStage(account, now, config); return !!(w && w.daily_post_cap === 0 && w.daily_browse_cap > 0); };

function dailyCapFor(account, now, config) {
  const w = warmupStage(account, now, config);
  if (w) return w.daily_post_cap;
  const base = config.daily_cap;
  return account.penalty_until && now.getTime() < new Date(account.penalty_until).getTime() ? Math.max(1, Math.floor(base / config.penalty_cap_divisor)) : base;
}

function nextSlot({ now, account, candidates, pageId, fingerprint: fp = null, groupActivity = {}, config = DEFAULTS, rand = Math.random }) {
  if (account.disabled_until_admin) return { at: null, reason: "disabled" };
  const recentHalts = (account.halts || []).filter((h) => now.getTime() - new Date(h.at).getTime() < config.halts_window_days * MS_DAY);
  if (recentHalts.length >= config.halts_to_disable) return { at: null, reason: "disabled" };
  // A live penalty (rate_limited / feature_blocked, R5) pauses posting outright
  // until penalty_until, rather than merely thinning the schedule: dailyCapFor's
  // halved cap is a defence in depth for any caller that computes a cap without
  // going through nextSlot's own gate.
  if (account.penalty_until && now.getTime() < new Date(account.penalty_until).getTime()) {
    return { at: null, reason: "penalty" };
  }

  if (wantsBrowseSession(account, now, config)) return { at: null, reason: "browse_only" };
  const posts = (account.posts || []).map((p) => ({ ...p, t: new Date(p.at).getTime() }));
  const today = localDate(now, config.timezone);
  const plan = dayPlan(today, config, rand);
  if (plan.target === 0) return { at: null, reason: "day_skipped" };

  const todays = posts.filter((p) => localDate(new Date(p.t), config.timezone) === today).length;
  if (todays >= Math.min(plan.target, dailyCapFor(account, now, config))) return { at: null, reason: "daily_cap" };
  if (posts.filter((p) => now.getTime() - p.t < 7 * MS_DAY).length >= config.weekly_cap) return { at: null, reason: "weekly_cap" };

  // Posts are matched to a candidate group by group_id; only a post written
  // before group_id existed falls back to matching by group_url.
  const postsFor = (c) => posts.filter((p) => (p.group_id ? p.group_id === c.group_id : p.group_url === c.url));
  const within = (iso) => now.getTime() - new Date(iso).getTime() < config.fingerprint_window_days * MS_DAY;
  const duplicateReview = [];
  const weakDup = new Set();

  const eligible = candidates.filter((c) => {
    const toGroup = postsFor(c);
    if (toGroup.some((p) => now.getTime() - p.t < config.group_cooldown_days * MS_DAY)) return false;
    if (toGroup.some((p) => p.page_id === pageId && now.getTime() - p.t < config.property_group_cooldown_days * MS_DAY)) return false;
    // What OTHER Forly accounts did to this group (group_activity/{group_id}|{date}, Task 16).
    const ga = groupActivity[c.group_id] || {};
    if ((ga.posts_today || 0) >= config.group_global_daily_cap) return false;
    const fps = ga.fingerprints || [];
    if (fp && fp.exact && fps.some((f) => f.exact === fp.exact && within(f.at))) return false; // exact: silent skip
    if (fp && fp.strong && fps.some((f) => f.strong === fp.strong && within(f.at))) { duplicateReview.push(c.group_id); return false; } // strong: skip + flag
    if (fp && fp.weak && fps.some((f) => f.weak === fp.weak && within(f.at))) weakDup.add(c.group_id); // weak: rank last, not a block
    return true;
  });
  if (!eligible.length) {
    return duplicateReview.length ? { at: null, reason: "duplicate", duplicate_review: duplicateReview.slice() } : { at: null, reason: "no_eligible_group" };
  }
  const lastTo = (c) => Math.max(0, ...postsFor(c).map((p) => p.t));
  eligible.sort((a, b) => (Number(weakDup.has(a.group_id)) - Number(weakDup.has(b.group_id))) || (lastTo(a) - lastTo(b)));

  // Earliest: after the last post OR reservation by the gap (with jitter, and
  // sometimes a long break), and never before today's randomised start.
  const lastAny = Math.max(0, ...posts.map((p) => p.t));
  const longBreak = rand() < config.long_break_probability;
  const gapMin = longBreak ? 180 + rand() * 120 : config.min_gap_minutes * (1 + config.gap_jitter * rand());
  const lp = localParts(now, config.timezone);
  const startToday = new Date(now.getTime() - (lp.hour * 60 + lp.minute) * MS_MIN + (config.active_hours.start * 60 + plan.start_offset_min) * MS_MIN);
  const earliest = new Date(Math.max(now.getTime(), lastAny + gapMin * MS_MIN, startToday.getTime()));
  const winner = eligible[0];
  const result = { at: nextActiveTime(earliest, config), group_id: winner.group_id, group_url: winner.url };
  if (duplicateReview.length) result.duplicate_review = duplicateReview.slice();
  return result;
}

// ── what the page is telling us — from the DIALOG and ALERT regions only ──
// The feed is other people's text. A member who writes "אתם חסומים זמנית" in a
// post must not halt every Forly agent who lands there.
const URL_SIGNALS = [
  ["restricted", /\/checkpoint\/block/i],
  ["checkpoint", /\/checkpoint\//i],
  ["login_required", /\/(login|recover)(\/|\?|$)/i],
];
const TEXT_SIGNALS = [
  ["captcha", /(confirm you'?re human|security check|בדיקת אבטחה|לוודא שאת)/i],
  ["feature_blocked", /(can'?t use this feature|we limit how often|לא ניתן להשתמש בתכונה|אנחנו מגבילים)/i],
  ["rate_limited", /(temporarily blocked|posting too fast|slow down|חסומים זמנית|חסום זמנית|לאט יותר)/i],
  ["restricted", /(account (is )?restricted|החשבון שלך מוגבל)/i],
  ["pending_approval", /(pending approval|will be reviewed|ממתין לאישור|ייבדק על ידי מנהל)/i],
  ["group_blocked", /(can'?t post in this group|no longer able to post|לא ניתן לפרסם בקבוצה)/i],
  ["not_member", /(join group to post|הצטרפו לקבוצה כדי לפרסם|הצטרפות לקבוצה)/i],
];
const SIGNAL_DISABLES = new Set(["checkpoint", "captcha", "restricted"]);
const SIGNAL_PENALISES = new Set(["rate_limited", "feature_blocked"]);
const SIGNAL_SKIPS = new Set(["group_blocked", "not_member", "pending_approval"]);

function classifySignal({ landedUrl, dialogText, alertText }) {
  const u = String(landedUrl || "");
  for (const [code, re] of URL_SIGNALS) if (re.test(u)) return code;
  const t = `${dialogText || ""}\n${alertText || ""}`;
  for (const [code, re] of TEXT_SIGNALS) if (re.test(t)) return code;
  return "ok";
}

module.exports = {
  DEFAULTS, nextSlot, isActiveTime, nextActiveTime, dayPlan, activityKey, configFrom, fingerprint,
  wantsBrowseSession, classifySignal, SIGNAL_DISABLES, SIGNAL_PENALISES, SIGNAL_SKIPS,
  _test: { localParts, dailyCapFor, warmupStage },
};
