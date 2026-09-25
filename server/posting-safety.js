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
 * 24h arithmetic, so DST transitions never shift a bucket. Israel's yom tov
 * days and their eves are computed from the Hebrew calendar (also via Intl),
 * not hand-maintained — see isYomTov()/isHolidayEve() below.
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
const { classifySignal, SIGNAL_DISABLES, SIGNAL_PENALISES, SIGNAL_SKIPS } = require("./posting-signals");

const DEFAULTS = {
  timezone: "Asia/Jerusalem",
  active_hours: { start: 9, end: 21 },
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
// The Jerusalem calendar date that follows `dateStr`, as a string — anchored
// at UTC noon so the arithmetic never lands near a Jerusalem DST boundary.
function nextLocalDateStr(dateStr, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return localDate(new Date(Date.UTC(y, m - 1, d, 12) + MS_DAY), tz);
}

// ── Israel's yom tov days, computed from the Hebrew calendar (R7) ──
// Tishri 1/2 (Rosh Hashana), 10 (Yom Kippur), 15 (Sukkot I), 22 (Shmini
// Atzeret/Simchat Torah); Nisan 15/21 (Pesach I/last day); Sivan 6 (Shavuot).
// Computed, not a hand-maintained list, so it never goes stale.
const BLOCKED_HEBREW_DAYS = { Tishri: new Set([1, 2, 10, 15, 22]), Nisan: new Set([15, 21]), Sivan: new Set([6]) };
const EVE_INACTIVE_HOUR = 15; // Erev Shabbat / Erev Yom Tov: inactive from here
function hebrewParts(date, tz) {
  const f = new Intl.DateTimeFormat("en-u-ca-hebrew", { timeZone: tz, day: "numeric", month: "long" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { month: p.month, day: Number(p.day) };
}
// Fail closed: if this runtime's ICU ever spells a Hebrew month differently
// (or lacks the Hebrew calendar), every holiday check above would silently
// say "not a holiday" and posting would run on Yom Kippur. So the calendar is
// checked once against three known dates; if it disagrees, nothing is active.
const CALENDAR_OK = (() => {
  try {
    const want = [["2026-09-12T12:00:00Z", "Tishri", 1], ["2026-04-02T12:00:00Z", "Nisan", 15], ["2026-05-22T12:00:00Z", "Sivan", 6]];
    return want.every(([iso, m, d]) => { const p = hebrewParts(new Date(iso), "Asia/Jerusalem"); return p.month === m && p.day === d; });
  } catch { return false; }
})();
function isYomTov(date, tz) {
  const { month, day } = hebrewParts(date, tz);
  const days = BLOCKED_HEBREW_DAYS[month];
  return !!(days && days.has(day));
}
function isHolidayEve(date, config) {
  const tomorrowStr = nextLocalDateStr(localDate(date, config.timezone), config.timezone);
  const [y, m, d] = tomorrowStr.split("-").map(Number);
  return isYomTov(new Date(Date.UTC(y, m - 1, d, 12)), config.timezone);
}

function isActiveTime(date, config = DEFAULTS) {
  if (!CALENDAR_OK) return false; // see CALENDAR_OK: an unverifiable calendar means no posting at all
  const lp = localParts(date, config.timezone);
  if (lp.dow === 6) return false; // Saturday: Shabbat, fully inactive all day (no fixed end-hour to get wrong)
  if (isYomTov(date, config.timezone)) return false;
  if ((lp.dow === 5 || isHolidayEve(date, config)) && lp.hour >= EVE_INACTIVE_HOUR) return false; // Erev Shabbat / Erev Yom Tov
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
// `seed` (Task 16: account.plan_seed, from planSeed()) makes the plan
// per-account, so two accounts don't all skip and start on the same days —
// an empty seed reproduces the original, account-agnostic plan exactly.
function dayPlan(localDay, config = DEFAULTS, _rand, seed = "") {
  const r = seeded(seed ? `${localDay}|${seed}` : String(localDay));
  if (r() < config.skip_day_probability) return { start_offset_min: 0, target: 0 };
  return { start_offset_min: Math.floor(r() * config.day_start_jitter_min), target: 1 + Math.floor(r() * config.daily_cap) };
}
// Task 16 sets account.plan_seed = planSeed(phone): an HMAC, not the phone
// itself, so the seed carries no PII into the schedule it shapes.
function planSeed(phone, key = process.env.PROFILE_KEY) {
  if (!key) throw new Error("planSeed: PROFILE_KEY required");
  return crypto.createHmac("sha256", key).update(String(phone || "")).digest("hex").slice(0, 24);
}

// The group_activity/{group_id}|{date} doc id (Task 16 writes it, R7: the
// Jerusalem calendar date, never the UTC date).
function activityKey(group_id, date) { return `${group_id}|${localDate(date, DEFAULTS.timezone)}`; }

// settings/posting may override a small, explicit allowlist of DEFAULTS
// without a deploy. Anything else in `settings` — and any non-positive-
// integer override — is ignored, so nextSlot stays pure and predictable.
// A deep copy: a caller mutating the returned config (e.g. config.active_hours)
// must never corrupt the shared DEFAULTS object other callers read.
function configFrom(settings) {
  const out = structuredClone(DEFAULTS);
  const v = settings && settings.group_global_daily_cap;
  if (Number.isInteger(v) && v > 0) out.group_global_daily_cap = v;
  return out;
}

// price rounded to the nearest `pct` (0.02 = 2%, 0.05 = 5%) relative bucket:
// a logarithmic bucket, so the bucket width scales with price — a flat NIS
// divisor would lump most rents (e.g. 4,500 and 6,500) into one or two
// buckets, while a sale price ten times higher would barely move a bucket.
const priceBucket = (price, pct) => { const p = Number(price) || 0; return p > 0 ? Math.round(Math.log(p) / Math.log(1 + pct)) : null; };
const hasNumber = (v) => v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v)) && Number(v) > 0;
const sqmBucket = (sqm) => Math.floor(Number(sqm) / 5);
const normalizeText = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();

// Same listing, whoever posted it — three tiers of confidence, each an HMAC
// so the global index (group_activity.fingerprints) stores no readable
// attribute, only tokens keyed by PROFILE_KEY. A tier is `null` when its
// inputs are missing — a listing with no price is never a false "match" —
// and nextSlot skips a null tier rather than treating it as a wildcard.
//  - exact:  street/project known → city|street_or_project|rooms|floor|sqm|price2
//            (street/project case- and whitespace-normalised first);
//            else an imported listing's own source id; else null (no exact tier).
//  - strong: city|rooms|sqm±5|price2 — a near-duplicate: skip AND flag for review.
//            null when size_sqm or price is missing.
//  - weak:   city|rooms|price5 — plausibly the same listing: not a block, just ranked last.
//            null when price is missing.
function fingerprint(prop = {}, key = process.env.PROFILE_KEY) {
  if (!key) throw new Error("fingerprint: PROFILE_KEY required");
  const p = prop || {};
  const city = normalizeCity(p.city);
  const rooms = p.rooms ?? "";
  const hasPrice = hasNumber(p.price);
  const hasSqm = hasNumber(p.size_sqm);
  const price2 = hasPrice ? priceBucket(p.price, 0.02) : null;
  const price5 = hasPrice ? priceBucket(p.price, 0.05) : null;
  const streetOrProject = normalizeText(p.street || p.project) || null;
  let exactMaterial = null;
  if (streetOrProject) exactMaterial = `${city}|${streetOrProject}|${rooms}|${p.floor ?? ""}|${p.size_sqm ?? ""}|${price2 ?? ""}`;
  else if (p.source_url || p.source_id) exactMaterial = `src|${p.source_url || p.source_id}`;
  const strongMaterial = (hasSqm && hasPrice) ? `${city}|${rooms}|${sqmBucket(p.size_sqm)}|${price2}` : null;
  const weakMaterial = hasPrice ? `${city}|${rooms}|${price5}` : null;
  const hmac = (material) => crypto.createHmac("sha256", key).update(material).digest("hex").slice(0, 24);
  return {
    exact: exactMaterial ? hmac(exactMaterial) : null,
    strong: strongMaterial ? hmac(strongMaterial) : null,
    weak: weakMaterial ? hmac(weakMaterial) : null,
  };
}

// Calendar days in Asia/Jerusalem, not 24-hour spans: day 1 is the connect
// day. A missing, invalid or future first_connected_at is treated as day 1
// (the safest, most restrictive — browse-only) rather than throwing or
// silently granting a mature account's full cap.
function dayNumber(account, now, config) {
  const raw = account && account.first_connected_at;
  const d0date = raw ? new Date(raw) : null;
  if (!d0date || Number.isNaN(d0date.getTime()) || d0date.getTime() > now.getTime()) return 1;
  const d0 = localDate(d0date, config.timezone), d1 = localDate(now, config.timezone);
  return Math.round((Date.UTC(...d1.split("-").map(Number).map((x, i) => (i === 1 ? x - 1 : x))) - Date.UTC(...d0.split("-").map(Number).map((x, i) => (i === 1 ? x - 1 : x)))) / MS_DAY) + 1;
}
function warmupStage(account, now, config) {
  const mult = (account.account_aged === false || account.posted_manually === false) ? config.warmup_multiplier_if_unsure : 1;
  const day = dayNumber(account, now, config);
  return config.warmup.find((w) => day >= w.start_day * mult - (mult - 1) && day <= w.end_day * mult) || null;
}
const wantsBrowseSession = (account, now, config) => { const w = warmupStage(account, now, config); return !!(w && w.daily_post_cap === 0 && w.daily_browse_cap > 0); };

function isPenalised(account, now) {
  return !!(account.penalty_until && now.getTime() < new Date(account.penalty_until).getTime());
}
// R5: a live penalty halves whatever cap otherwise applies — including a
// warm-up stage's cap, not just the base daily_cap — never below 1.
function dailyCapFor(account, now, config) {
  const w = warmupStage(account, now, config);
  const base = w ? w.daily_post_cap : config.daily_cap;
  return isPenalised(account, now) ? Math.max(1, Math.floor(base / config.penalty_cap_divisor)) : base;
}
function weeklyCapFor(account, now, config) {
  return isPenalised(account, now) ? Math.max(1, Math.floor(config.weekly_cap / config.penalty_cap_divisor)) : config.weekly_cap;
}

function nextSlot({ now, account, candidates, pageId, fingerprint: fp = null, groupActivity = {}, config = DEFAULTS, rand = Math.random }) {
  if (account.disabled_until_admin) return { at: null, reason: "disabled" };
  // Only a halt that actually disables or penalises (R5) counts toward the
  // 2-in-30-days disable rule or the day-one penalty block below — a
  // reconnect-only halt like login_required is not a punishment (R5).
  const recentHalts = (account.halts || []).filter((h) => (SIGNAL_DISABLES.has(h.code) || SIGNAL_PENALISES.has(h.code)) && now.getTime() - new Date(h.at).getTime() < config.halts_window_days * MS_DAY);
  if (recentHalts.length >= config.halts_to_disable) return { at: null, reason: "disabled" };
  // R5: feature_blocked / rate_limited is a 14-day penalty with caps halved,
  // not a hard stop — except day one, which posts nothing at all. "Day one"
  // is a penalising halt (rate_limited / feature_blocked) under 24h old;
  // for the rest of penalty_until, dailyCapFor/weeklyCapFor halve the caps.
  const freshPenalisingHalt = recentHalts.some((h) => SIGNAL_PENALISES.has(h.code) && now.getTime() - new Date(h.at).getTime() < MS_DAY);
  if (isPenalised(account, now) && freshPenalisingHalt) return { at: null, reason: "penalty" };

  if (wantsBrowseSession(account, now, config)) return { at: null, reason: "browse_only" };
  const posts = (account.posts || []).map((p) => ({ ...p, t: new Date(p.at).getTime() }));
  const countOnDate = (dateStr) => posts.filter((p) => localDate(new Date(p.t), config.timezone) === dateStr).length;

  const today = localDate(now, config.timezone);
  const todayPlan = dayPlan(today, config, rand, account.plan_seed);
  if (todayPlan.target === 0) return { at: null, reason: "day_skipped" };
  if (countOnDate(today) >= Math.min(todayPlan.target, dailyCapFor(account, now, config))) return { at: null, reason: "daily_cap" };
  if (posts.filter((p) => now.getTime() - p.t < 7 * MS_DAY).length >= weeklyCapFor(account, now, config)) return { at: null, reason: "weekly_cap" };

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
    // A null tier (missing inputs) never matches anything — it is skipped,
    // not treated as a wildcard.
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
  const winner = eligible[0];

  // Earliest: after the last post OR reservation by the gap (with jitter, and
  // sometimes a long break, never earlier than `now`).
  const lastAny = Math.max(0, ...posts.map((p) => p.t));
  const longBreak = rand() < config.long_break_probability;
  const gapMin = longBreak ? 180 + rand() * 120 : config.min_gap_minutes * (1 + config.gap_jitter * rand());
  let cursor = new Date(Math.max(now.getTime(), lastAny + gapMin * MS_MIN));

  // The day the slot lands on is never taken on faith: a big gap, or another
  // campaign's reservations already claiming a future date, can push `at`
  // onto a day whose own plan or cap was never checked. Each candidate day
  // is re-validated — its own skip flag, its own start jitter, its own cap
  // (attempts AND ok:null reservations already on that Jerusalem date) —
  // advancing to the next day on any failure, for up to two weeks out.
  for (let daysTried = 0; daysTried < 14; daysTried++) {
    const lp = localParts(cursor, config.timezone);
    const dateStr = localDate(cursor, config.timezone);
    const midnight = new Date(cursor.getTime() - (lp.hour * 60 + lp.minute) * MS_MIN);
    const plan = dayPlan(dateStr, config, rand, account.plan_seed);
    const dayStart = new Date(midnight.getTime() + (config.active_hours.start * 60 + plan.start_offset_min) * MS_MIN);
    if (plan.target > 0) {
      const candidate = nextActiveTime(new Date(Math.max(cursor.getTime(), dayStart.getTime())), config);
      if (localDate(candidate, config.timezone) === dateStr) {
        const capForDay = Math.min(plan.target, dailyCapFor(account, candidate, config));
        if (countOnDate(dateStr) < capForDay) {
          const result = { at: candidate, group_id: winner.group_id, group_url: winner.url };
          if (duplicateReview.length) result.duplicate_review = duplicateReview.slice();
          return result;
        }
      }
    }
    cursor = new Date(midnight.getTime() + MS_DAY); // try the next calendar day, from its own start — never carry today's jitter into it
  }
  return { at: null, reason: "no_slot_in_horizon" };
}

module.exports = {
  DEFAULTS, CALENDAR_OK, nextSlot, isActiveTime, nextActiveTime, dayPlan, planSeed, activityKey, configFrom, fingerprint,
  wantsBrowseSession, classifySignal, SIGNAL_DISABLES, SIGNAL_PENALISES, SIGNAL_SKIPS,
  _test: { localParts, dailyCapFor, weeklyCapFor, warmupStage, dayNumber, isYomTov, isHolidayEve },
};
