/* posting-safety.js — every pacing promise, as an assertion. Pure, no I/O.
   All times derive from NOW, never from Date.now(): a test that ages with the
   calendar is a test that fails in November. */
process.env.PROFILE_KEY = "test-profile-key-15";
const assert = require("assert");
const S = require("./posting-safety");

const NOW = new Date("2026-09-23T10:00:00+03:00"); // Wed
const IL = (iso) => new Date(iso);
const day = (n) => n * 24 * 3600 * 1000;
const cfg = S.DEFAULTS;
const noRand = () => 0.5;
const jerusalemDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: cfg.timezone }).format(d);
const ok = (url, group_id = url) => ({ url, group_id, agent_policy: "explicitly_allowed" });
const account = (o = {}) => Object.assign({
  first_connected_at: new Date(NOW.getTime() - day(90)).toISOString(),
  halts: [], disabled_until_admin: false, penalty_until: null,
  account_aged: true, posted_manually: true, posts: [],
}, o);
const at = (d) => new Date(NOW.getTime() - d).toISOString();

// ── active hours: Israeli waking hours, never Shabbat, never a yom tov day ──
assert.equal(S.CALENDAR_OK, true, "this runtime's Hebrew calendar matches the reference dates");
assert.equal(S.isActiveTime(IL("2026-09-23T10:00:00+03:00"), cfg), true, "Wed 10:00");
assert.equal(S.isActiveTime(IL("2026-09-23T03:00:00+03:00"), cfg), false, "Wed 03:00");
assert.equal(S.isActiveTime(IL("2026-09-25T16:00:00+03:00"), cfg), false, "Fri 16:00 — Erev Shabbat");
assert.equal(S.isActiveTime(IL("2026-09-26T12:00:00+03:00"), cfg), false, "Sat noon — Shabbat");
assert.equal(S.isActiveTime(IL("2026-09-25T11:00:00+03:00"), cfg), true, "Fri 11:00 — before Erev Shabbat");
assert.equal(S.isActiveTime(IL("2026-09-21T11:00:00+03:00"), cfg), false, "Yom Kippur 2026 — computed from the Hebrew calendar");

// ── holidays: computed from the Hebrew calendar, not a hand-kept list ──
assert.equal(S.isActiveTime(IL("2027-10-02T11:00:00+03:00"), cfg), false, "Rosh Hashana 5788 (Tishri 1)");
assert.equal(S.isActiveTime(IL("2028-04-11T11:00:00+03:00"), cfg), false, "Pesach 5788 (Nisan 15) — a Tuesday, not conflated with Shabbat");
assert.equal(S.isActiveTime(IL("2026-09-20T16:00:00+03:00"), cfg), false, "Erev Yom Kippur 16:00 — the eve is inactive from 15:00");
assert.equal(S.isActiveTime(IL("2026-09-20T10:00:00+03:00"), cfg), true, "Erev Yom Kippur 10:00 — still an ordinary morning");
assert.equal(S.isActiveTime(IL("2026-09-26T20:30:00+03:00"), cfg), false, "a Saturday evening is fully inactive — no fixed Shabbat-end hour to get wrong");
assert.equal(S._test.isYomTov(IL("2028-04-11T11:00:00+03:00"), cfg.timezone), true);
assert.equal(S._test.isHolidayEve(IL("2026-09-20T10:00:00+03:00"), cfg), true);

// ── the schedule is not periodic: each day has its own start and its own target ──
{
  const a = S.dayPlan("2026-09-23", cfg, Math.random), b = S.dayPlan("2026-09-24", cfg, Math.random);
  assert.ok(a.start_offset_min >= 0 && a.start_offset_min <= cfg.day_start_jitter_min);
  assert.ok(a.target >= 0 && a.target <= cfg.daily_cap);
  assert.deepEqual(S.dayPlan("2026-09-23", cfg, Math.random), a, "a day's plan is stable across ticks");
  let skipped = 0;
  for (let i = 1; i <= 200; i++) if (S.dayPlan(`2026-10-${String((i % 28) + 1).padStart(2, "0")}-${i}`, cfg, Math.random).target === 0) skipped++;
  assert.ok(skipped > 20 && skipped < 80, `about one day in five is skipped, got ${skipped}/200`);
}

// ── per-account seeding: the shape of the schedule is per-phone, not shared ──
{
  assert.deepEqual(S.dayPlan("2026-11-03", cfg, Math.random, "seedA"), S.dayPlan("2026-11-03", cfg, Math.random, "seedA"), "same seed and date → the same plan");
  let differ = 0;
  for (let i = 0; i < 30; i++) {
    const d = `2026-11-${String((i % 28) + 1).padStart(2, "0")}`;
    const a = S.dayPlan(d, cfg, Math.random, "seedA"), b = S.dayPlan(d, cfg, Math.random, "seedB");
    if (a.target !== b.target || a.start_offset_min !== b.start_offset_min) differ++;
  }
  assert.ok(differ > 5, `different seeds give a different skip/offset pattern across 30 days, got ${differ}/30`);
  assert.deepEqual(S.dayPlan("2026-09-23", cfg, Math.random, ""), S.dayPlan("2026-09-23", cfg, Math.random), "an empty seed keeps today's (unseeded) behaviour");

  const ps1 = S.planSeed("+972500000000", "key-a"), ps2 = S.planSeed("+972500000000", "key-a");
  assert.equal(ps1, ps2, "same phone + same key → same seed");
  assert.notEqual(ps1, S.planSeed("+972500000001", "key-a"), "different phone → different seed");
  assert.notEqual(ps1, S.planSeed("+972500000000", "key-b"), "different key → different seed");
  assert.throws(() => S.planSeed("+972500000000", ""), /PROFILE_KEY/, "throws without a key");
}

// ── disabled and penalised accounts never get a slot, whatever the caps say ──
assert.equal(S.nextSlot({ now: NOW, account: account({ disabled_until_admin: true }), candidates: [ok("g")], pageId: "p", config: cfg, rand: noRand }).reason, "disabled");
assert.equal(S.nextSlot({ now: NOW, account: account({ halts: [{ at: at(day(3)), code: "rate_limited" }, { at: at(day(20)), code: "rate_limited" }] }), candidates: [ok("g")], pageId: "p", config: cfg, rand: noRand }).reason, "disabled", "two halts in 30 days = disabled");
assert.notEqual(S.nextSlot({ now: NOW, account: account({ halts: [{ at: at(day(3)), code: "login_required" }, { at: at(day(20)), code: "login_required" }] }), candidates: [ok("g")], pageId: "p", config: cfg, rand: noRand }).reason, "disabled", "login_required is a reconnect, not a punishment — two of them do not disable");
assert.equal(S.nextSlot({ now: NOW, account: account({ penalty_until: at(-day(5)), halts: [{ at: at(2 * 3600000), code: "rate_limited" }] }), candidates: [ok("g")], pageId: "p", config: cfg, rand: noRand }).reason, "penalty", "day one after a penalising signal: nothing");

// ── past day one, a live penalty halves the cap — it does not stop posting (R5) ──
{
  const cfgNoSkip = Object.assign({}, cfg, { skip_day_probability: 0 });
  const halved = account({
    penalty_until: at(-day(5)),                              // still 5 days from ending
    halts: [{ at: at(day(3)), code: "rate_limited" }],        // 3 days old — past the day-one block
    posts: [{ at: at(3600000), group_id: "a", group_url: "a", page_id: "p", ok: true }], // one post already today
  });
  assert.equal(S._test.dailyCapFor(halved, NOW, cfgNoSkip), Math.floor(cfg.daily_cap / cfg.penalty_cap_divisor), "the daily cap is halved for the rest of the penalty window");
  const r = S.nextSlot({ now: NOW, account: halved, candidates: [ok("g")], pageId: "p", config: cfgNoSkip, rand: noRand });
  assert.equal(r.reason, "daily_cap", "a post that the full cap would allow is refused at the halved cap, not blocked outright as 'penalty'");
}

// ── a live penalty halves a warm-up cap too, and the weekly cap — never below 1 ──
{
  const stage3 = account({ first_connected_at: at(day(15)), penalty_until: at(-day(5)), halts: [{ at: at(day(3)), code: "rate_limited" }] });
  assert.equal(S._test.warmupStage(stage3, NOW, cfg).daily_post_cap, 2, "sanity: warm-up stage 3's own cap is 2");
  assert.equal(S._test.dailyCapFor(stage3, NOW, cfg), 1, "a live penalty halves the warm-up cap too — floor(2/2)");
  assert.equal(S._test.weeklyCapFor(stage3, NOW, cfg), Math.max(1, Math.floor(cfg.weekly_cap / cfg.penalty_cap_divisor)), "a live penalty halves the weekly cap too");
  assert.equal(S._test.weeklyCapFor(account(), NOW, cfg), cfg.weekly_cap, "no penalty → the weekly cap is untouched");
}

// ── DST: a Jerusalem calendar day is a calendar day, whatever the clock did ──
{
  const cfgNoSkip = Object.assign({}, cfg, { skip_day_probability: 0 });
  const springForward = IL("2026-03-27T10:00:00+03:00"); // first day after the 2026 DST change
  const acct = account({ first_connected_at: IL("2026-03-24T23:30:00+02:00").toISOString() });
  assert.equal(S._test.warmupStage(acct, springForward, cfgNoSkip).start_day, 4, "day 4 by calendar, not by 72 hours");
}

// ── first_connected_at that is missing, invalid or in the future never throws, and is day 1 ──
{
  const missing = account({ first_connected_at: undefined });
  const invalid = account({ first_connected_at: "not-a-date" });
  const future = account({ first_connected_at: new Date(NOW.getTime() + day(1)).toISOString() });
  for (const [label, a] of [["missing", missing], ["invalid", invalid], ["future", future]]) {
    assert.doesNotThrow(() => S.nextSlot({ now: NOW, account: a, candidates: [ok("g")], pageId: "p", config: cfg, rand: noRand }), label);
    assert.equal(S.wantsBrowseSession(a, NOW, cfg), true, `${label} first_connected_at → treated as day 1 (browse-only)`);
    assert.equal(S._test.dayNumber(a, NOW, cfg), 1, label);
  }
}

// ── activityKey: the group_activity/{group_id}|{date} doc id, Jerusalem date always ──
{
  const utcLate = new Date("2026-03-27T23:30:00Z"); // Friday UTC, already Saturday 02:30 IDT after the DST switch
  assert.equal(S.activityKey("123", utcLate), "123|2026-03-28", "Jerusalem date, not the UTC date");
  assert.equal(S.activityKey("slug:foo", IL("2026-09-23T10:00:00+03:00")), "slug:foo|2026-09-23");
}

// ── configFrom: settings/posting may override the global per-group cap, nothing else, only with a positive integer, and never mutates DEFAULTS ──
{
  assert.equal(S.configFrom({}).group_global_daily_cap, cfg.group_global_daily_cap);
  assert.equal(S.configFrom(null).group_global_daily_cap, cfg.group_global_daily_cap, "handles a missing settings doc");
  assert.equal(S.configFrom({ group_global_daily_cap: 7 }).group_global_daily_cap, 7);
  assert.equal(S.configFrom({ group_global_daily_cap: 0 }).group_global_daily_cap, cfg.group_global_daily_cap, "non-positive ignored");
  assert.equal(S.configFrom({ group_global_daily_cap: -3 }).group_global_daily_cap, cfg.group_global_daily_cap, "negative ignored");
  assert.equal(S.configFrom({ group_global_daily_cap: 2.5 }).group_global_daily_cap, cfg.group_global_daily_cap, "non-integer ignored");
  assert.equal(S.configFrom({ group_global_daily_cap: 7, daily_cap: 99 }).daily_cap, cfg.daily_cap, "only the allowlisted key is settings-driven");
  const c = S.configFrom({});
  c.active_hours.start = 0;
  c.warmup.length = 0;
  assert.equal(cfg.active_hours.start, 9, "configFrom deep-copies — mutating the result never touches DEFAULTS");
  assert.equal(cfg.warmup.length, 3, "nested arrays are copied too");
}

// ── warm-up: a freshly connected account, or one that answered "no", posts once a day ──
{
  const cfgNoSkip = Object.assign({}, cfg, { skip_day_probability: 0 });
  const one = [{ at: at(3600000), group_id: "a", group_url: "a", page_id: "p", ok: true }];
  // day 6 by the Jerusalem calendar: warm-up stage 2 (days 4-7), one post/day
  const fresh = account({ first_connected_at: at(day(5)), posts: one });
  assert.equal(S.nextSlot({ now: NOW, account: fresh, candidates: [ok("g")], pageId: "p", config: cfgNoSkip, rand: noRand }).reason, "daily_cap", "week 1: one a day");
  // day 9 by the calendar — a mature account by now, but "unsure" doubles the
  // warm-up window, so it is still in the one-a-day stage
  const young = account({ account_aged: false, first_connected_at: at(day(8)), posts: one });
  assert.equal(S.nextSlot({ now: NOW, account: young, candidates: [ok("g")], pageId: "p", config: cfgNoSkip, rand: noRand }).reason, "daily_cap", "a young Facebook account is treated like a fresh connection");
  const mature = account({ posts: one });
  const m = S.nextSlot({ now: NOW, account: mature, candidates: [ok("g")], pageId: "p", config: cfgNoSkip, rand: noRand });
  assert.ok(m.at, "a mature account may post again today");
}

// ── minimum gap, jitter only adds, and reservations from other campaigns count ──
{
  const acct = account({ posts: [{ at: at(10 * 60000), group_id: "g0", group_url: "g0", page_id: "p0", ok: true }] });
  const cfgNoSkip = Object.assign({}, cfg, { skip_day_probability: 0, day_start_jitter_min: 0 });
  const slot = S.nextSlot({ now: NOW, account: acct, candidates: [ok("g1")], pageId: "p1", config: cfgNoSkip, rand: () => 0 });
  assert.ok((slot.at.getTime() - new Date(acct.posts[0].at).getTime()) / 60000 >= cfg.min_gap_minutes);
  assert.equal(slot.group_id, "g1");
  assert.equal(slot.group_url, "g1");
  const later = S.nextSlot({ now: NOW, account: acct, candidates: [ok("g1")], pageId: "p1", config: cfgNoSkip, rand: () => 1 });
  assert.ok(later.at.getTime() > slot.at.getTime(), "rand=1 pushes later, never earlier");
  const reserved = account({ posts: [{ at: at(-5 * 60000), group_id: "g0", group_url: "g0", page_id: "p0", ok: null }] }); // another campaign, 5 min from now
  const r = S.nextSlot({ now: NOW, account: reserved, candidates: [ok("g1")], pageId: "p1", config: cfgNoSkip, rand: () => 0 });
  assert.ok((r.at.getTime() - (NOW.getTime() + 5 * 60000)) / 60000 >= cfg.min_gap_minutes, "paced against the reservation");
}

// ── caps count attempts and reservations, not successes ──
{
  const posts = [];
  for (let i = 0; i < cfg.daily_cap; i++) posts.push({ at: at(3600000 * (i + 1)), group_id: `g${i}`, group_url: `g${i}`, page_id: "p", ok: i % 2 === 0 });
  const cfgNoSkip = Object.assign({}, cfg, { skip_day_probability: 0 });
  assert.equal(S.nextSlot({ now: NOW, account: account({ posts }), candidates: [ok("z")], pageId: "p", config: cfgNoSkip, rand: noRand }).reason, "daily_cap");
  const week = [];
  for (let i = 0; i < cfg.weekly_cap; i++) week.push({ at: at(day(1) + i * 3600000), group_id: `w${i}`, group_url: `w${i}`, page_id: "p", ok: true });
  assert.equal(S.nextSlot({ now: NOW, account: account({ posts: week }), candidates: [ok("z")], pageId: "p", config: cfgNoSkip, rand: noRand }).reason, "weekly_cap");
}

// ── the daily cap is re-checked for whatever day the slot actually lands on ──
{
  const cfgNoSkip = Object.assign({}, cfg, { skip_day_probability: 0 });

  // 20:30, nothing posted today — but another campaign already reserved all
  // three of tomorrow's slots. The gap/jitter math would naturally push the
  // next post into tomorrow; tomorrow's own cap must still be honoured.
  const reservedTomorrow = [
    { at: "2026-09-24T10:00:00+03:00", group_id: "r0", group_url: "r0", page_id: "x", ok: null },
    { at: "2026-09-24T13:00:00+03:00", group_id: "r1", group_url: "r1", page_id: "x", ok: null },
    { at: "2026-09-24T18:00:00+03:00", group_id: "r2", group_url: "r2", page_id: "x", ok: null },
  ];
  const night = IL("2026-09-23T20:30:00+03:00");
  const r = S.nextSlot({ now: night, account: account({ posts: reservedTomorrow }), candidates: [ok("g1")], pageId: "p", config: cfgNoSkip, rand: noRand });
  assert.ok(r.at, "a slot is still found");
  assert.notEqual(jerusalemDate(r.at), "2026-09-24", "tomorrow already took its 3 reservations — no 4th slot lands there");

  // An overnight `now` (today's window long closed): the slot lands on the
  // day it rolls onto, at THAT day's own start jitter — not a bare 09:00,
  // and not contaminated by today's own (irrelevant) offset.
  const lateNight = IL("2026-09-23T23:30:00+03:00");
  const overnight = S.nextSlot({ now: lateNight, account: account(), candidates: [ok("g1")], pageId: "p", config: cfgNoSkip, rand: noRand });
  assert.equal(S.isActiveTime(overnight.at, cfg), true);
  assert.ok(overnight.at.getTime() > lateNight.getTime() + 8 * 3600000);
  const landedDate = jerusalemDate(overnight.at);
  const expectedPlan = S.dayPlan(landedDate, cfgNoSkip);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone, hour12: false, hour: "numeric", minute: "numeric" }).formatToParts(overnight.at);
  const hour = Number(parts.find((x) => x.type === "hour").value) % 24, minute = Number(parts.find((x) => x.type === "minute").value);
  assert.equal(hour * 60 + minute, cfg.active_hours.start * 60 + expectedPlan.start_offset_min, "lands exactly at the landing day's own start jitter");

  // A slot never lands on a skip day, whatever day the search starts from.
  for (let i = 0; i < 30; i++) {
    const now = new Date(NOW.getTime() + i * day(1));
    const res = S.nextSlot({ now, account: account(), candidates: [ok("g")], pageId: "p", config: cfg, rand: noRand });
    if (res.at) assert.notEqual(S.dayPlan(jerusalemDate(res.at), cfg).target, 0, `slot landed on a skip day (search started ${jerusalemDate(now)})`);
  }
}

// ── warm-up day 2: a browse-only day — no slot, but a browse session is wanted ──
{
  const fresh = account({ first_connected_at: at(day(1)) });
  const r = S.nextSlot({ now: NOW, account: fresh, candidates: [ok("g")], pageId: "p", config: cfg, rand: noRand });
  assert.equal(r.reason, "browse_only");
  assert.equal(S.wantsBrowseSession(fresh, NOW, cfg), true);
}

// ── fingerprint tiers: HMACs only, keyed by PROFILE_KEY, never a readable attribute ──
{
  const propA = { city: "חיפה", rooms: 4, price: 1_000_000, size_sqm: 90, street: "הרצל 1" };
  const fpA1 = S.fingerprint(propA, "key-a"), fpA2 = S.fingerprint(propA, "key-a"), fpB = S.fingerprint(propA, "key-b");
  assert.deepEqual(fpA1, fpA2, "same property + same key → same tiers");
  assert.notEqual(fpA1.strong, fpB.strong, "different key → different tiers");
  assert.notEqual(fpA1.exact, fpB.exact);
  for (const tier of [fpA1.exact, fpA1.strong, fpA1.weak]) assert.ok(/^[0-9a-f]{24}$/.test(tier), "24 hex chars");
  const dump = JSON.stringify(fpA1);
  assert.ok(!dump.includes("חיפה") && !dump.includes("הרצל") && !dump.includes("1000000"), "no readable attribute leaks into the stored value");

  const sqm91 = S.fingerprint({ city: "חיפה", rooms: 3, price: 900000, size_sqm: 91 }, "k");
  const sqm93 = S.fingerprint({ city: "חיפה", rooms: 3, price: 900000, size_sqm: 93 }, "k");
  const sqm97 = S.fingerprint({ city: "חיפה", rooms: 3, price: 900000, size_sqm: 97 }, "k");
  assert.equal(sqm91.strong, sqm93.strong, "sqm 91 vs 93 → same strong bucket");
  assert.notEqual(sqm91.strong, sqm97.strong, "sqm 91 vs 97 → different strong bucket");

  // price buckets are relative (log-scale), not a flat NIS amount: a sale
  // price and a rent get comparably-sized buckets around their own value.
  const sale = (price) => ({ city: "חיפה", rooms: 3, size_sqm: 70, floor: 2, street: "הרצל 1", price });
  assert.equal(S.fingerprint(sale(2_000_000), "k").exact, S.fingerprint(sale(2_030_000), "k").exact, "sale price 2,000,000 vs 2,030,000 → same price2 bucket");
  assert.notEqual(S.fingerprint(sale(2_000_000), "k").exact, S.fingerprint(sale(2_200_000), "k").exact, "sale price 2,000,000 vs 2,200,000 → different price2 bucket");
  const rent = (price) => ({ city: "חיפה", rooms: 2, size_sqm: 40, price });
  assert.notEqual(S.fingerprint(rent(5000), "k").strong, S.fingerprint(rent(6000), "k").strong, "rent 5,000 vs 6,000 → different price2 bucket");
  assert.notEqual(S.fingerprint(rent(5000), "k").weak, S.fingerprint(rent(6000), "k").weak, "rent 5,000 vs 6,000 → different price5 bucket");
  assert.equal(S.fingerprint(rent(5000), "k").strong, S.fingerprint(rent(5010), "k").strong, "rent 5,000 vs 5,010 → same price2 bucket (well inside one bucket)");

  assert.equal(S.fingerprint({ city: "תל אביב - יפו", rooms: 4, price: 2_010_000, size_sqm: 91 }, "k").strong,
    S.fingerprint({ city: "תל אביב", rooms: 4, price: 2_010_000, size_sqm: 91, street: "רוטשילד 1" }, "k").strong,
    "city normalised before hashing; strong ignores street");

  // street/project case and whitespace are normalised before hashing
  const streetA = S.fingerprint({ city: "חיפה", rooms: 3, price: 900000, street: "Main St." }, "k");
  const streetB = S.fingerprint({ city: "חיפה", rooms: 3, price: 900000, street: "  MAIN   st.  " }, "k");
  assert.equal(streetA.exact, streetB.exact, "street is case- and whitespace-normalised before hashing");

  // degenerate listings: missing price/sqm never produce a false match
  const noPriceNoSqm1 = S.fingerprint({ city: "חיפה", rooms: 3 }, "k");
  const noPriceNoSqm2 = S.fingerprint({ city: "חיפה", rooms: 3 }, "k");
  assert.equal(noPriceNoSqm1.strong, null, "no sqm and no price → no strong tier");
  assert.equal(noPriceNoSqm1.weak, null, "no price → no weak tier");
  assert.deepEqual(noPriceNoSqm1, noPriceNoSqm2, "still deterministic");
  const noSqmOnly = S.fingerprint({ city: "חיפה", rooms: 3, price: 900000 }, "k");
  assert.equal(noSqmOnly.strong, null, "sqm alone missing → no strong tier");
  assert.ok(noSqmOnly.weak, "price present → weak tier still exists");

  const savedKey = process.env.PROFILE_KEY;
  delete process.env.PROFILE_KEY;
  assert.throws(() => S.fingerprint({ city: "חיפה" }), /PROFILE_KEY/, "throws when PROFILE_KEY is missing and no key arg given");
  process.env.PROFILE_KEY = savedKey; // restore for the rest of the suite
  assert.throws(() => S.fingerprint({ city: "חיפה" }, ""), /PROFILE_KEY/, "throws on an empty key");

  const imported = S.fingerprint({ city: "חיפה", rooms: 3, price: 900000, source_url: "https://yad2.co.il/x/1" }, "k");
  assert.ok(imported.exact, "an imported listing without street/project still gets an exact tier, from its source");
  const noExact = S.fingerprint({ city: "חיפה", rooms: 3, price: 900000, size_sqm: 60 }, "k");
  assert.equal(noExact.exact, null, "no street/project and no source → no exact tier");
}

// ── other accounts' activity: the global per-group cap, and duplicate detection by tier ──
{
  const cfgNoSkip = Object.assign({}, cfg, { skip_day_probability: 0 });
  const propBase = { city: "חיפה", rooms: 4, price: 1_000_000, size_sqm: 90, street: "הרצל 1" };
  const fpBase = S.fingerprint(propBase);
  const fpStrongOnly = S.fingerprint(Object.assign({}, propBase, { street: "אחר 5" })); // same bucket, different exact
  const fpWeakOnly = S.fingerprint(Object.assign({}, propBase, { size_sqm: 500, price: 1_002_000, street: "עוד 9" })); // same price5 bucket only

  const activity = {
    g1: { posts_today: cfg.group_global_daily_cap, fingerprints: [] },
    g2: { posts_today: 0, fingerprints: [{ exact: fpBase.exact, strong: fpBase.strong, weak: fpBase.weak, at: at(day(2)) }] },
    g3: { posts_today: 0, fingerprints: [{ exact: fpStrongOnly.exact, strong: fpStrongOnly.strong, weak: fpStrongOnly.weak, at: at(day(2)) }] },
    g4: { posts_today: 0, fingerprints: [{ exact: fpWeakOnly.exact, strong: fpWeakOnly.strong, weak: fpWeakOnly.weak, at: at(day(2)) }] },
    g5: { posts_today: 0, fingerprints: [] },
    g6: { posts_today: 0, fingerprints: [{ exact: null, strong: null, weak: null, at: at(day(2)) }] }, // another degenerate (no price/sqm) listing
  };

  const full = S.nextSlot({ now: NOW, account: account(), candidates: [ok("g1")], pageId: "p", config: cfgNoSkip, rand: noRand, groupActivity: activity });
  assert.equal(full.reason, "no_eligible_group", "g1 already took the global daily cap of Forly posts today");

  const exactDup = S.nextSlot({ now: NOW, account: account(), candidates: [ok("g2")], pageId: "p", fingerprint: fpBase, config: cfgNoSkip, rand: noRand, groupActivity: activity });
  assert.equal(exactDup.reason, "no_eligible_group", "the exact same listing was already posted to g2");
  assert.ok(!exactDup.duplicate_review, "an exact match is a silent skip, not a review flag");

  const strongDup = S.nextSlot({ now: NOW, account: account(), candidates: [ok("g3")], pageId: "p", fingerprint: fpBase, config: cfgNoSkip, rand: noRand, groupActivity: activity });
  assert.equal(strongDup.reason, "duplicate", "a near-duplicate listing is why nothing is eligible");
  assert.deepEqual(strongDup.duplicate_review, ["g3"]);

  const weakOrder = S.nextSlot({ now: NOW, account: account(), candidates: [ok("g4"), ok("g5")], pageId: "p", fingerprint: fpBase, config: cfgNoSkip, rand: noRand, groupActivity: activity });
  assert.equal(weakOrder.group_url, "g5", "a weak-only match is ranked last, not excluded");
  assert.ok(!weakOrder.duplicate_review, "a weak match alone is not a review flag");

  const mixed = S.nextSlot({ now: NOW, account: account(), candidates: [ok("g3"), ok("g5")], pageId: "p", fingerprint: fpBase, config: cfgNoSkip, rand: noRand, groupActivity: activity });
  assert.equal(mixed.group_url, "g5", "the strong duplicate is skipped in favour of a clean group");
  assert.deepEqual(mixed.duplicate_review, ["g3"], "but still flagged for operator review even though another group was chosen");

  // a degenerate (null-tier) query fingerprint never matches anything, even
  // against a stored degenerate entry — a null tier is skipped, not a wildcard
  const degenFp = S.fingerprint({ city: "חיפה", rooms: 3 }, process.env.PROFILE_KEY);
  const degenResult = S.nextSlot({ now: NOW, account: account(), candidates: [ok("g6")], pageId: "p", fingerprint: degenFp, config: cfgNoSkip, rand: noRand, groupActivity: activity });
  assert.ok(degenResult.at, "no price/sqm on either side → no false duplicate");
}

// ── group cooldowns pick the other group; unknown-policy groups are eligible (the agent listed them) ──
{
  const cfgNoSkip = Object.assign({}, cfg, { skip_day_probability: 0 });
  const acct = account({ posts: [{ at: at(day(2)), group_id: "g1", group_url: "g1", page_id: "other", ok: true }] });
  assert.equal(S.nextSlot({ now: NOW, account: acct, candidates: [ok("g1"), { url: "g2", group_id: "g2", agent_policy: "unknown" }], pageId: "p", config: cfgNoSkip, rand: noRand }).group_url, "g2");
  assert.equal(S.nextSlot({ now: NOW, account: acct, candidates: [ok("g1")], pageId: "p", config: cfgNoSkip, rand: noRand }).reason, "no_eligible_group");
  const old = account({ posts: [{ at: at(day(10)), group_id: "g1", group_url: "g1", page_id: "p", ok: true }] });
  assert.equal(S.nextSlot({ now: NOW, account: old, candidates: [ok("g1")], pageId: "p", config: cfgNoSkip, rand: noRand }).reason, "no_eligible_group", "same property → same group inside 14 days");
  const legacy = account({ posts: [{ at: at(day(2)), group_url: "g1", page_id: "other", ok: true }] }); // no group_id — a post written before Task 14
  assert.equal(S.nextSlot({ now: NOW, account: legacy, candidates: [ok("g1")], pageId: "p", config: cfgNoSkip, rand: noRand }).reason, "no_eligible_group", "falls back to group_url when a post has no group_id");
}

// ── signals: scoped input, and the outcomes that matter are all there ──
const sig = (o) => S.classifySignal(Object.assign({ landedUrl: "https://www.facebook.com/groups/1", dialogText: "", alertText: "" }, o));

const POSITIVES = [
  ["login.php?next=", { landedUrl: "https://www.facebook.com/login.php?next=%2Fgroups%2F1" }, "login_required"],
  ["login/?next=", { landedUrl: "https://www.facebook.com/login/?next=x" }, "login_required"],
  ["recover path", { landedUrl: "https://www.facebook.com/recover/initiate/" }, "login_required"],
  ["checkpoint path", { landedUrl: "https://www.facebook.com/checkpoint/1501092823525282/" }, "checkpoint"],
  ["checkpoint/block path", { landedUrl: "https://www.facebook.com/checkpoint/block/" }, "restricted"],
  ["captcha, exact sentence", { dialogText: "Confirm you're human" }, "captcha"],
  ["captcha, curly apostrophe", { dialogText: "Confirm you’re human" }, "captcha"],
  ["captcha, structural (hasCaptchaFrame)", { hasCaptchaFrame: true }, "captcha"],
  ["feature_blocked, straight apostrophe", { dialogText: "You can't use this feature right now" }, "feature_blocked"],
  ["feature_blocked, curly apostrophe", { dialogText: "You can’t use this feature right now" }, "feature_blocked"],
  ["feature_blocked, hebrew", { dialogText: "לא ניתן להשתמש בתכונה זו כרגע" }, "feature_blocked"],
  ["rate_limited, english", { alertText: "You're temporarily blocked from posting" }, "rate_limited"],
  ["rate_limited, curly apostrophe", { alertText: "You’re temporarily blocked from posting" }, "rate_limited"],
  ["rate_limited, hebrew (חסומים זמנית)", { alertText: "אתם חסומים זמנית" }, "rate_limited"],
  ["rate_limited, hebrew (נחסמת באופן זמני)", { alertText: "נחסמת באופן זמני" }, "rate_limited"],
  ["rate_limited, hebrew (חסימה זמנית)", { alertText: "חסימה זמנית" }, "rate_limited"],
  ["rate_limited, hebrew feminine (חסומה זמנית)", { alertText: "חסומה זמנית" }, "rate_limited"],
  ["restricted, account is restricted", { alertText: "Your account is restricted" }, "restricted"],
  ["restricted, groups-until phrasing, straight apostrophe", { alertText: "You're restricted from posting in groups until 9:00 PM" }, "restricted"],
  ["restricted, groups-until phrasing, curly apostrophe", { alertText: "You’re restricted from posting in groups until 9:00 PM" }, "restricted"],
  ["restricted, hebrew", { alertText: "החשבון שלך מוגבל" }, "restricted"],
  ["pending_approval, english", { alertText: "Your post is pending approval" }, "pending_approval"],
  ["pending_approval, hebrew", { alertText: "הפוסט שלך ממתין לאישור" }, "pending_approval"],
  ["group_blocked, straight apostrophe", { dialogText: "You can't post in this group" }, "group_blocked"],
  ["group_blocked, curly apostrophe", { dialogText: "You can’t post in this group" }, "group_blocked"],
  ["not_member", { dialogText: "Join group to post" }, "not_member"],
];
for (const [label, input, expected] of POSITIVES) assert.equal(sig(input), expected, label);

const NEGATIVES = [
  ["group-rules dialog (לוודא שאת is over-broad)", { dialogText: "מנהלי הקבוצה רוצים לוודא שאתם מכירים את הכללים" }],
  ["group-rules dialog (security check is over-broad)", { dialogText: "every post passes a security check" }],
  ["group-rules dialog (bare slow down is over-broad)", { dialogText: "Slow down — one post per day" }],
  ["a login-named group, not a login wall", { landedUrl: "https://www.facebook.com/groups/login/" }],
  ["a generic mention of verification is not a captcha", { dialogText: "Please complete verification to continue" }],
];
for (const [label, input] of NEGATIVES) assert.equal(sig(input), "ok", label);

// what the feed says is NOT a signal: another member's post must never halt an account
assert.equal(S.classifySignal({ landedUrl: "https://www.facebook.com/groups/1", dialogText: "", alertText: "", feedText: "אתם חסומים זמנית security check join group" }), "ok");
for (const x of ["checkpoint", "captcha", "restricted"]) assert.ok(S.SIGNAL_DISABLES.has(x));
for (const x of ["rate_limited", "feature_blocked"]) assert.ok(S.SIGNAL_PENALISES.has(x));
for (const x of ["group_blocked", "not_member", "pending_approval"]) assert.ok(S.SIGNAL_SKIPS.has(x));
assert.ok(!S.SIGNAL_DISABLES.has("login_required") && !S.SIGNAL_PENALISES.has("login_required"), "a cookie expiry is a reconnect, not a punishment");

// ── Shabbat stops posting, never warm-up browsing ──
{
  const sat = new Date("2026-09-26T10:00:00+03:00"); // a Saturday
  assert.equal(S.isActiveTime(sat), false, "no post on Shabbat");
  const acc = { first_connected_at: "2026-09-26T08:00:00+03:00", posts: [], halts: [], account_aged: true, posted_manually: true };
  assert.deepEqual(S.nextSlot({ now: sat, account: acc, candidates: [{ group_id: "1", url: "https://www.facebook.com/groups/1" }], pageId: "p" }), { at: null, reason: "browse_only" }, "a warm-up browse on Shabbat");
}

console.log("posting-safety.test.js ok");
