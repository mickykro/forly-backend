/*
 * posting-attempts.js — durable posting attempts (R1) and the cross-account
 * per-group activity they reserve. Re-exported by posting-store.js.
 *
 * An attempt is written BEFORE a browser opens for a post, in one transaction
 * that also reserves the account's Jerusalem-day budget, the group's global
 * bucket and the property→target dedup key. Its key is deterministic
 * (phone|page|target|Jerusalem date), so a crashed sweep that runs again
 * finds `already_reserved` instead of posting twice. States only move along
 * EDGES; nothing ever goes back to a pre-submit state once the Post click may
 * have happened (`submit_started` is written before the click), so an attempt
 * past that point is reconciled, never re-submitted.
 *
 * Collections:
 *   posting_attempts/{key}            the attempt
 *   posting_budget/{phone}|{date}     { phone, date, count }
 *   group_activity/{group_id}|{date}  { group_id, date, posts, fingerprints: [{exact,strong,weak,at}] }
 *   posting_dedup/{hmac(page|type|target)}  { key, at, expires_at }
 *     — expires after limits.dedup_days (the property→group cooldown, or 30 d
 *       for the Page); an expired doc counts as absent and is overwritten.
 * Every {date} is the Asia/Jerusalem calendar date (R7, posting-safety).
 * Times are ISO strings, so `lease_until < now` is a plain range query.
 */
const safety = require("./posting-safety");
const { firestore, runTx, fail, hmacHex, toDate, toIso, assertId, isPlainObject, stripUndefined } = require("./posting-tx");

const LEASE_MS = 20 * 60000;
const ATT = "posting_attempts", BUD = "posting_budget", ACT = "group_activity", DED = "posting_dedup", GAL = "group_aliases";
const maps = { [ATT]: new Map(), [BUD]: new Map(), [ACT]: new Map(), [DED]: new Map(), [GAL]: new Map() };

// group_aliases (Task 18 fix round 2): one group, several ids, for EVERY
// account. group_aliases/{slug id} → { group_id, at } and
// group_aliases/{group_id} → { group_id, aliases: [slug ids], at }. Every id
// a reservation or an activity read starts from is folded through it, so a
// slug one account resolved still shares its caps with every other account.
// `get(col, id)` is a transaction read or a plain one. → [id, …the others].
async function foldGroupIds(get, id) {
  const d = await get(GAL, id);
  const canon = d && typeof d.group_id === "string" && d.group_id ? d.group_id : id;
  const cd = canon === id ? d : await get(GAL, canon);
  const others = cd && Array.isArray(cd.aliases) ? cd.aliases.map(String) : [];
  return [...new Set([id, canon, ...others])];
}
async function readDoc(col, id) {
  const fdb = firestore();
  if (fdb) { const d = await fdb.collection(col).doc(id).get(); return d.exists ? d.data() : null; }
  return maps[col].has(id) ? structuredClone(maps[col].get(id)) : null;
}
const groupIdsFor = (id) => foldGroupIds(readDoc, assertId(id, "group_id"));
// Many docs of one collection in one round: Firestore getAll, or the maps.
async function readDocs(col, ids) {
  if (!ids.length) return [];
  const fdb = firestore();
  if (fdb) return (await fdb.getAll(...ids.map((id) => fdb.collection(col).doc(id)))).map((d) => (d.exists ? d.data() : null));
  return ids.map((id) => (maps[col].has(id) ? structuredClone(maps[col].get(id)) : null));
}
// foldGroupIds for many ids at once: two batched registry reads (the ids,
// then any canonical ids they point to) instead of two awaits per id.
async function foldManyGroupIds(keys) {
  const uniq = [...new Set(keys)];
  const first = await readDocs(GAL, uniq);
  const docOf = new Map(uniq.map((k, i) => [k, first[i]]));
  const canonOf = new Map(uniq.map((k) => { const d = docOf.get(k); return [k, d && typeof d.group_id === "string" && d.group_id ? d.group_id : k]; }));
  const need = [...new Set(canonOf.values())].filter((c) => !docOf.has(c));
  (await readDocs(GAL, need)).forEach((d, i) => docOf.set(need[i], d));
  return (k) => {
    const cd = docOf.get(canonOf.get(k));
    return [...new Set([k, canonOf.get(k), ...(cd && Array.isArray(cd.aliases) ? cd.aliases.map(String) : [])])];
  };
}

// Records that `aliasId` (a vanity "slug:…" id) is `groupId`. Idempotent.
async function recordGroupAlias(aliasId, groupId, nowIn) {
  const alias = assertId(aliasId, "alias"), gid = assertId(groupId, "group_id");
  if (alias === gid) return null;
  const at = toDate(nowIn).toISOString();
  return runTx(maps, async (tx) => {
    const g = await tx.get(GAL, gid);
    const aliases = [...new Set([...((g && g.aliases) || []), alias])];
    tx.set(GAL, alias, { group_id: gid, at });
    tx.set(GAL, gid, { group_id: gid, aliases, at }, { merge: true });
    return { group_id: gid, aliases };
  });
}

const EDGES = {
  reserved: ["session_started", "cancelled"],
  session_started: ["composer_ready", "cancelled", "verified_failed"],
  composer_ready: ["submit_started", "cancelled", "verified_failed"],
  submit_started: ["verification_pending", "outcome_unknown", "verified_failed"],
  verification_pending: ["verified_posted", "submitted_for_approval", "verified_failed", "outcome_unknown"],
  outcome_unknown: ["verified_posted", "verified_failed"], // reconciliation only
};
const TERMINAL = new Set(["verified_posted", "submitted_for_approval", "verified_failed", "cancelled"]);
const PRE_SUBMIT = new Set(["reserved", "session_started", "composer_ready"]);
const IN_FLIGHT = new Set(["submit_started", "verification_pending"]);
// States whose reservation still counts against caps. A `verified_failed`
// also counts when `failed_after_submit` is true (see isCounting).
const countingStates = Object.freeze(["reserved", "session_started", "composer_ready", "submit_started", "verification_pending", "outcome_unknown", "verified_posted", "submitted_for_approval"]);
const isCounting = (a) => countingStates.includes(a.state) || (a.state === "verified_failed" && a.failed_after_submit === true);

// Fields `detail` may never overwrite: they are the attempt's identity and bookkeeping.
const PROTECTED = new Set(["key", "state", "history", "lease_until", "reserved_at", "finished_at", "updated_at", "released", "failed_after_submit",
  "phone", "page_id", "campaign_id", "post_id", "target_type", "target_id", "target_url", "publisher", "platform", "date",
  "budget_key", "activity_key", "dedup_key", "fingerprint", "copy_hash", "confirm_membership",
  "click_id", "click_issued_at", "click_expires_at"]);
const CLICK_TTL_MS = 30 * 86400000; // R4: a click id resolves for 30 days

const HEX = /^[0-9a-f]{1,64}$/;

function attemptKey({ phone, page_id, target_type, target_id, date }) {
  return hmacHex(`${phone}|${page_id}|${target_type}|${target_id}|${safety.jerusalemDate(toDate(date))}`, 32);
}
const dedupKey = (page_id, target_type, target_id) => hmacHex(`${page_id}|${target_type}|${target_id}`, 32);
const budgetKey = (phone, date) => `${phone}|${date}`;

function cleanFingerprint(fp) {
  if (fp === undefined || fp === null) return null;
  if (!isPlainObject(fp)) throw fail("invalid_input", "fingerprint must be { exact, strong, weak }");
  const out = {};
  for (const tier of ["exact", "strong", "weak"]) {
    const v = fp[tier] === undefined ? null : fp[tier];
    if (v !== null && (typeof v !== "string" || !HEX.test(v))) throw fail("invalid_input", `fingerprint.${tier} must be an HMAC hex string or null`);
    out[tier] = v;
  }
  return out.exact || out.strong || out.weak ? out : null;
}

function capOf(limits, name) {
  const v = limits && limits[name];
  if (!Number.isFinite(v) || v < 0) throw fail("invalid_input", `limits.${name} required`);
  return v;
}

function optString(v, name) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.length > 2000) throw fail("invalid_input", `${name} must be a string`);
  return v;
}

// → { ok: true, attempt } | { ok: false, reason }. One transaction, all reads first.
async function reserveAttempt(input = {}) {
  const phone = assertId(input.phone, "phone");
  const page_id = assertId(input.page_id, "page_id");
  const target_type = input.target_type;
  if (target_type !== "group" && target_type !== "page") throw fail("invalid_input", "target_type must be group|page");
  const target_id = assertId(input.target_id, "target_id");
  // Other ids of the same target (Task 18: a resolved vanity slug). Their
  // group buckets count toward the cap, and a live dedup doc under any of
  // them is a duplicate — the move to a numeric id never resets either.
  const aliasIn = input.target_aliases === undefined || input.target_aliases === null ? [] : input.target_aliases;
  if (!Array.isArray(aliasIn) || aliasIn.length > 10) throw fail("invalid_input", "target_aliases must be an array (<= 10)");
  const target_aliases = [...new Set(aliasIn.map((a) => assertId(a, "target_aliases")))].filter((a) => a !== target_id);
  const publisher = optString(input.publisher, "publisher");
  if (!publisher) throw fail("invalid_input", "publisher required (R6)");
  const fp = cleanFingerprint(input.fingerprint);
  const campaign_id = optString(input.campaign_id, "campaign_id"), post_id = optString(input.post_id, "post_id");
  const target_url = optString(input.target_url, "target_url"), copy_hash = optString(input.copy_hash, "copy_hash");
  // R4: the campaign link's ?c= id, issued per attempt (16 random bytes, hex).
  const click_id = input.click_id === undefined || input.click_id === null ? null : input.click_id;
  if (click_id !== null && (typeof click_id !== "string" || !/^[0-9a-f]{32}$/.test(click_id))) throw fail("invalid_input", "click_id must be 32 hex characters");
  const dailyCap = capOf(input.limits, "daily_cap");
  const groupCap = target_type === "group" ? capOf(input.limits, "group_global_daily_cap") : null;
  // How long the property→target dedup holds. Absent → it never expires (the
  // fail-closed default); present → a positive number of days.
  const dedupDays = input.limits && input.limits.dedup_days !== undefined ? input.limits.dedup_days : null;
  if (dedupDays !== null && (!Number.isFinite(dedupDays) || dedupDays <= 0)) throw fail("invalid_input", "limits.dedup_days must be a positive number");
  const now = toDate(input.now);
  const at = now.toISOString();
  const date = safety.jerusalemDate(now);
  const key = attemptKey({ phone, page_id, target_type, target_id, date: now });
  const bKey = budgetKey(phone, date);
  const aKey = target_type === "group" ? safety.activityKey(target_id, now) : null;
  const dKey = dedupKey(page_id, target_type, target_id);

  return runTx(maps, async (tx) => {
    const existing = await tx.get(ATT, key);
    const budget = await tx.get(BUD, bKey);
    const bucket = aKey ? await tx.get(ACT, aKey) : null;
    const dedup = await tx.get(DED, dKey);
    // Every other id of this target: the caller's aliases and the global
    // registry's (read in this transaction), folded before any key is used.
    const registry = target_type === "group" ? await foldGroupIds((c, id) => tx.get(c, id), target_id) : [target_id];
    const otherIds = [...new Set([...target_aliases, ...registry])].filter((a) => a !== target_id);
    const aliasActKeys = target_type === "group" ? otherIds.map((a) => safety.activityKey(a, now)) : [];
    const aliasDedupKeys = otherIds.map((a) => dedupKey(page_id, target_type, a));
    const aliasBuckets = [];
    for (const k of aliasActKeys) aliasBuckets.push(await tx.get(ACT, k));
    const aliasDedups = [];
    for (const k of aliasDedupKeys) aliasDedups.push(await tx.get(DED, k));
    // The existing attempt comes back so the caller can resume, reconcile or
    // cancel an orphan left by a commit whose outcome it never saw.
    if (existing) return { ok: false, reason: "already_reserved", attempt: existing };
    if (((budget && budget.count) || 0) >= dailyCap) return { ok: false, reason: "daily_cap" };
    const aliasPosts = aliasBuckets.reduce((n, b) => n + ((b && b.posts) || 0), 0);
    if (aKey && ((bucket && bucket.posts) || 0) + aliasPosts >= groupCap) return { ok: false, reason: "group_cap" };
    const live = (d) => d && !d.released && !(typeof d.expires_at === "string" && d.expires_at <= at);
    if (live(dedup) || aliasDedups.some(live)) return { ok: false, reason: "duplicate" };

    const fpEntry = aKey && fp ? { ...fp, at } : null;
    const attempt = {
      key, state: "reserved", platform: "facebook", lease_until: new Date(now.getTime() + LEASE_MS).toISOString(),
      reserved_at: at, updated_at: at, date, phone, page_id,
      campaign_id, post_id, target_type, target_id, target_url, publisher,
      copy_hash, confirm_membership: input.confirm_membership === true,
      click_id, click_issued_at: click_id ? at : null, click_expires_at: click_id ? new Date(now.getTime() + CLICK_TTL_MS).toISOString() : null,
      fingerprint: fpEntry, budget_key: bKey, activity_key: aKey, dedup_key: dKey,
      history: [{ state: "reserved", at }],
    };
    tx.set(ATT, key, attempt);
    tx.set(BUD, bKey, { phone, date, count: ((budget && budget.count) || 0) + 1 }, { merge: true });
    if (aKey) {
      const fps = ((bucket && bucket.fingerprints) || []).concat(fpEntry ? [fpEntry] : []);
      tx.set(ACT, aKey, { group_id: target_id, date, posts: ((bucket && bucket.posts) || 0) + 1, fingerprints: fps }, { merge: true });
    }
    // A full overwrite: an expired doc for this page→target is replaced, not merged.
    tx.set(DED, dKey, { key, at, expires_at: dedupDays === null ? null : new Date(now.getTime() + dedupDays * 86400000).toISOString() });
    return { ok: true, attempt };
  });
}

function cleanDetail(detail) {
  if (detail === undefined || detail === null) return {};
  if (!isPlainObject(detail)) throw fail("invalid_input", "detail must be an object");
  const bad = Object.keys(detail).filter((k) => PROTECTED.has(k));
  if (bad.length) throw fail("invalid_input", `detail may not set ${bad.join(", ")}`);
  return stripUndefined(detail);
}

// `guard(attempt)` false → no-op (returns null): the reaper and cancelOpenAttempts
// re-check, inside the transaction, that the attempt is still what they listed.
async function applyTransition(key, to, detail, nowIn, guard) {
  const extra = cleanDetail(detail);
  const now = toDate(nowIn);
  const at = now.toISOString();
  return runTx(maps, async (tx) => {
    const a = await tx.get(ATT, key);
    if (!a) throw fail("not_found", "attempt not found");
    if (guard && !guard(a)) return null;
    if (!(EDGES[a.state] || []).includes(to)) throw fail("illegal_transition", `${a.state} -> ${to}`);
    const release = to === "cancelled" || (to === "verified_failed" && PRE_SUBMIT.has(a.state));
    if (release && (typeof a.budget_key !== "string" || typeof a.dedup_key !== "string")) throw fail("corrupt_attempt", "attempt has no reservation keys");
    const budget = release ? await tx.get(BUD, a.budget_key) : null;
    const bucket = release && a.activity_key ? await tx.get(ACT, a.activity_key) : null;
    const dedup = release ? await tx.get(DED, a.dedup_key) : null;

    const next = { ...extra, state: to, updated_at: at, history: (a.history || []).concat([{ state: to, at }]) };
    if (TERMINAL.has(to)) { next.finished_at = at; next.lease_until = null; }
    else if (to === "outcome_unknown") next.lease_until = null; // parked for reconciliation, never reaped again
    else next.lease_until = new Date(now.getTime() + LEASE_MS).toISOString();
    if (to === "verified_failed" && !PRE_SUBMIT.has(a.state)) next.failed_after_submit = true;
    if (release) next.released = true;

    tx.set(ATT, key, next, { merge: true });
    if (release) {
      if (budget) tx.set(BUD, a.budget_key, { count: Math.max(0, (budget.count || 0) - 1) }, { merge: true });
      if (bucket) {
        const fps = (bucket.fingerprints || []).slice();
        const f = a.fingerprint;
        const i = f ? fps.findIndex((x) => x.at === f.at && x.exact === f.exact && x.strong === f.strong && x.weak === f.weak) : -1;
        if (i >= 0) fps.splice(i, 1);
        tx.set(ACT, a.activity_key, { posts: Math.max(0, (bucket.posts || 0) - 1), fingerprints: fps }, { merge: true });
      }
      if (dedup && dedup.key === a.key) tx.del(DED, a.dedup_key);
    }
    return Object.assign({}, a, next);
  });
}

function transition(key, to, detail = {}, now) { return applyTransition(key, to, detail, now, null); }

// A follow-up note on an attempt, WITHOUT moving it (Task 18): the link
// comment's result after verified_posted, or why a reconciliation left it
// for review. Only these fields; never state, reservations or bookkeeping.
const ANNOTATIONS = new Set(["comment_error_code", "reconcile_note"]);
async function annotate(key, detail, nowIn) {
  const extra = cleanDetail(detail);
  const bad = Object.keys(extra).filter((k) => !ANNOTATIONS.has(k) || (extra[k] !== null && (typeof extra[k] !== "string" || extra[k].length > 60)));
  if (bad.length || !Object.keys(extra).length) throw fail("invalid_input", `annotate: ${bad.join(", ") || "nothing"}`);
  const at = toDate(nowIn).toISOString();
  return runTx(maps, async (tx) => {
    const a = await tx.get(ATT, key);
    if (!a) throw fail("not_found", "attempt not found");
    tx.set(ATT, key, { ...extra, updated_at: at }, { merge: true });
    return Object.assign({}, a, extra, { updated_at: at });
  });
}

async function queryAttempts(where, memFilter, limit) {
  const fdb = firestore();
  if (fdb) {
    let q = fdb.collection(ATT);
    for (const [f, op, v] of where) q = q.where(f, op, v);
    if (limit) q = q.limit(limit);
    return (await q.get()).docs.map((d) => d.data());
  }
  const out = [...maps[ATT].values()].filter(memFilter).map((a) => structuredClone(a));
  return limit ? out.slice(0, limit) : out;
}

// Runs `applyTransition` for one listed attempt; a failure is collected as
// { key, error_code } instead of thrown, so one malformed doc never blocks
// the rest of the sweep.
async function tryTransition(failures, key, ...args) {
  try { return await applyTransition(key, ...args); }
  catch (e) { failures.push({ key, error_code: (e && e.code) || "error" }); return null; }
}

// → [{ key, from, to }]: expired leases. Pre-submit → cancelled (released);
// submit_started / verification_pending → outcome_unknown (never retried).
// The array also carries `.failures`: [{ key, error_code }] for attempts that
// could not be moved (left as they are; the next sweep tries again).
async function reapExpired(nowIn) {
  const now = toDate(nowIn);
  const iso = now.toISOString();
  const expired = (a) => typeof a.lease_until === "string" && a.lease_until < iso && (PRE_SUBMIT.has(a.state) || IN_FLIGHT.has(a.state));
  const found = (await queryAttempts([["lease_until", "<", iso]], expired, 200)).filter(expired);
  const out = [];
  const failures = [];
  for (const a of found) {
    const to = PRE_SUBMIT.has(a.state) ? "cancelled" : "outcome_unknown";
    const done = await tryTransition(failures, a.key, to, { error_code: "lease_expired" }, now, (cur) => cur.state === a.state && expired(cur));
    if (done) out.push({ key: a.key, from: a.state, to });
  }
  Object.defineProperty(out, "failures", { value: failures, enumerable: false });
  return out;
}

// Revoke/quarantine (profile-lifecycle): cancel what has not reached the
// Post click; leave submit_started+ for reconciliation. → count cancelled.
// Every open attempt is tried; if any failed, it then throws `cancel_incomplete`
// with `.cancelled` (count) and `.failures` ([{ key, error_code }]) — the
// reaper cancels those on lease expiry.
async function cancelOpenAttempts(phone, platform, nowIn) {
  if (platform && platform !== "facebook") return 0; // every attempt is a Facebook attempt today
  assertId(phone, "phone");
  const open = await queryAttempts([["phone", "==", phone], ["state", "in", [...PRE_SUBMIT]]], (a) => a.phone === phone && PRE_SUBMIT.has(a.state));
  let n = 0;
  const failures = [];
  for (const a of open) {
    const done = await tryTransition(failures, a.key, "cancelled", { error_code: "revoked" }, nowIn, (cur) => cur.phone === phone && PRE_SUBMIT.has(cur.state));
    if (done) n++;
  }
  if (failures.length) throw Object.assign(fail("cancel_incomplete", `${failures.length} attempt(s) not cancelled`), { cancelled: n, failures });
  return n;
}

async function getAttempt(key) {
  if (typeof key !== "string" || !HEX.test(key)) return null;
  const fdb = firestore();
  if (fdb) { const d = await fdb.collection(ATT).doc(key).get(); return d.exists ? d.data() : null; }
  const a = maps[ATT].get(key);
  return a ? structuredClone(a) : null;
}

async function listAttemptsByPhone(phone, sinceMs) {
  assertId(phone, "phone");
  const since = sinceMs ? toIso(sinceMs) : null;
  const where = [["phone", "==", phone]].concat(since ? [["reserved_at", ">=", since]] : []);
  const rows = await queryAttempts(where, (a) => a.phone === phone && (!since || a.reserved_at >= since));
  return rows.sort((x, y) => (x.reserved_at < y.reserved_at ? -1 : x.reserved_at > y.reserved_at ? 1 : 0));
}

// A campaign's attempts that have not reached the Post click — stop() cancels
// these, including one reserved a moment before the campaign's own doc
// recorded it. Index: posting_attempts(campaign_id, state).
async function listOpenAttemptsByCampaign(campaign_id) {
  if (typeof campaign_id !== "string" || !campaign_id || campaign_id.length > 200) throw fail("invalid_input", "campaign_id required");
  return queryAttempts([["campaign_id", "==", campaign_id], ["state", "in", [...PRE_SUBMIT]]], (a) => a.campaign_id === campaign_id && PRE_SUBMIT.has(a.state));
}

async function listAttemptsByState(state, limit = 50) {
  return queryAttempts([["state", "==", state]], (a) => a.state === state, limit);
}

// The n Jerusalem calendar dates ending at `today` (YYYY-MM-DD),
// newest first — calendar arithmetic on the date itself, not on instants.
function lastDates(today, n) {
  const [y, m, d] = today.split("-").map(Number);
  const pad = (x) => String(x).padStart(2, "0");
  return Array.from({ length: n }, (_, i) => {
    const t = new Date(Date.UTC(y, m - 1, d - i));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  });
}

// → { [group_id]: { posts_today, fingerprints } } — nextSlot's groupActivity input.
// `aliases` ({ [group_id]: [other ids] }, Task 18) and the global
// group_aliases registry: every other id's buckets are read too and folded
// into its group's entry.
async function getGroupActivityFor(group_ids, nowIn, windowDays = safety.DEFAULTS.fingerprint_window_days, aliases = {}) {
  const ids = (group_ids || []).map((g) => assertId(g, "group_id"));
  windowDays = windowDays === undefined || windowDays === null ? safety.DEFAULTS.fingerprint_window_days : windowDays;
  if (!Number.isInteger(windowDays) || windowDays < 1) throw fail("invalid_input", "windowDays must be a positive integer");
  const dates = lastDates(safety.jerusalemDate(toDate(nowIn)), windowDays);
  const givenOf = ids.map((g) => (Array.isArray(aliases && aliases[g]) ? aliases[g].map((a) => assertId(a, "alias")) : []));
  const fold = await foldManyGroupIds(ids.flatMap((g, i) => [g, ...givenOf[i]]));
  const groupsOf = ids.map((g, i) => [...new Set([g, ...givenOf[i], ...[g, ...givenOf[i]].flatMap(fold)])]);
  const docIds = groupsOf.flat().flatMap((g) => dates.map((dt) => `${g}|${dt}`));
  const docs = await readDocs(ACT, docIds); // one batch for every bucket
  const out = {};
  let at = 0;
  ids.forEach((g, gi) => {
    out[g] = { posts_today: 0, fingerprints: [] };
    for (let k = 0; k < groupsOf[gi].length; k++, at += dates.length) {
      const mine = docs.slice(at, at + dates.length); // newest date first
      out[g].posts_today += (mine[0] && mine[0].posts) || 0;
      out[g].fingerprints = out[g].fingerprints.concat(mine.flatMap((b) => (b && b.fingerprints) || []));
    }
  });
  return out;
}

function reset() { for (const m of Object.values(maps)) m.clear(); }

module.exports = {
  LEASE_MS, EDGES, countingStates, isCounting,
  attemptKey, reserveAttempt, transition, annotate, recordGroupAlias, groupIdsFor, reapExpired, cancelOpenAttempts,
  getAttempt, listAttemptsByPhone, listAttemptsByState, listOpenAttemptsByCampaign, getGroupActivityFor,
  _test: { reset, maps, dedupKey, lastDates },
};
