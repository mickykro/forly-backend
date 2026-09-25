/*
 * posting-store.js — storage for automated Facebook group posting (Task 16a):
 * campaigns, durable attempts (posting-attempts.js, re-exported), the
 * cross-account per-group activity, the manual-post and connection reads the
 * pacer needs, and browse (dwell) sessions.
 *
 * db.js is over its size cap, so this lives on its own. The Firestore handle
 * is read from require("./db").db at call time; null means the in-memory
 * store, whose Maps live here (posting_campaigns, dwell_sessions) and in
 * posting-attempts.js. `_test.reset()` clears all of them. No log lines.
 */
const crypto = require("crypto");
const attempts = require("./posting-attempts");
const { firestore, runTx, fail, hmacHex, toDate, toIso, assertId, isPlainObject, stripUndefined, deepMerge } = require("./posting-tx");

const CAMP = "posting_campaigns", DWELL = "dwell_sessions";
const maps = { [CAMP]: new Map(), [DWELL]: new Map() };
const MS_DAY = 86400000;
const PLATFORM = /^[a-z][a-z0-9_]{0,31}$/;

const memDb = () => require("./db").mem;
const clone = (v) => structuredClone(v);

// ── campaigns (posting_campaigns/{id}) ──
// One campaign per (phone, page): the id is derived, so a retried activation
// can never create a second one.
function campaignId(phone, page_id) {
  return hmacHex(`${assertId(phone, "phone")}|${assertId(page_id, "page_id")}|campaign`, 32);
}

// → { created, campaign }. Never overwrites: an existing campaign is returned untouched.
async function createPostingCampaignIfAbsent(c) {
  if (!isPlainObject(c)) throw fail("invalid_input", "campaign must be an object");
  const id = campaignId(c.phone, c.page_id);
  if (c.id !== undefined && c.id !== id) throw fail("invalid_input", "campaign id must be campaignId(phone, page_id)");
  const doc = stripUndefined({ ...c, id });
  return runTx(maps, async (tx) => {
    const cur = await tx.get(CAMP, id);
    if (cur) return { created: false, campaign: cur };
    tx.set(CAMP, id, doc);
    return { created: true, campaign: clone(doc) };
  });
}

async function getPostingCampaign(id) {
  if (typeof id !== "string" || !id || id.includes("/")) return null;
  const fdb = firestore();
  if (fdb) { const d = await fdb.collection(CAMP).doc(id).get(); return d.exists ? d.data() : null; }
  return maps[CAMP].has(id) ? clone(maps[CAMP].get(id)) : null;
}

// Merge-patch an EXISTING campaign (maps deep-merge, arrays replace — the same
// on both paths). A missing campaign is not created: → null. Else the merged campaign.
async function updatePostingCampaign(id, patch) {
  if (typeof id !== "string" || !id || id.includes("/")) throw fail("invalid_input", "campaign id required");
  if (!isPlainObject(patch)) throw fail("invalid_input", "patch must be an object");
  for (const k of ["id", "phone", "page_id"]) if (k in patch && patch[k] !== undefined) throw fail("invalid_input", `patch may not change ${k}`);
  const clean = stripUndefined(patch);
  return runTx(maps, async (tx) => {
    const cur = await tx.get(CAMP, id);
    if (!cur) return null;
    tx.set(CAMP, id, clean, { merge: true });
    return deepMerge(cur, clean);
  });
}

// Read-modify-write in ONE transaction: fn(campaign) → a patch, or null for
// "no change". Every read-modify-write of a campaign (its `posts` above all,
// which a patch replaces as a whole) goes through here, so two writers
// — an approval and a tick — can never lose each other's change. `fn` must be
// PURE: Firestore re-runs it when the transaction retries.
// → the merged campaign; the current one when fn returns null; null if missing.
async function mutatePostingCampaign(id, fn) {
  if (typeof id !== "string" || !id || id.includes("/")) throw fail("invalid_input", "campaign id required");
  if (typeof fn !== "function") throw fail("invalid_input", "fn required");
  return runTx(maps, async (tx) => {
    const cur = await tx.get(CAMP, id);
    if (!cur) return null;
    const patch = fn(clone(cur));
    if (patch === null || patch === undefined) return cur;
    if (!isPlainObject(patch)) throw fail("invalid_input", "patch must be an object");
    for (const k of ["id", "phone", "page_id"]) if (k in patch && patch[k] !== undefined && patch[k] !== cur[k]) throw fail("invalid_input", `patch may not change ${k}`);
    const clean = stripUndefined(patch);
    tx.set(CAMP, id, clean, { merge: true });
    return deepMerge(cur, clean);
  });
}

async function listCampaignsWhere(field, value, limit) {
  const fdb = firestore();
  if (fdb) return (await fdb.collection(CAMP).where(field, "==", value).limit(limit).get()).docs.map((d) => d.data());
  return [...maps[CAMP].values()].filter((c) => c[field] === value).slice(0, limit).map(clone);
}
const listPostingCampaignsByStatus = (status, limit = 50) => listCampaignsWhere("status", status, limit);
const listPostingCampaignsByPhone = (phone, limit = 100) => listCampaignsWhere("phone", phone, limit);

// ── manual share-kit posts (post_actions, append-only audit) ──
// The pacer must see what the agent posted by hand. The writers
// (routes/distribution.js share-session/mark, distribution/jobs.js) key the
// row by `business_phone`; `at` comes back as an ISO string on both paths.
async function listPostActionsByPhone(phone, sinceMs) {
  assertId(phone, "phone");
  const since = sinceMs ? toDate(sinceMs) : null;
  const norm = (a) => ({ ...a, at: a.at ? toIso(a.at) : null });
  const fdb = firestore();
  if (fdb) {
    let q = fdb.collection("post_actions").where("business_phone", "==", phone);
    if (since) q = q.where("at", ">=", since);
    return (await q.get()).docs.map((d) => norm(d.data()));
  }
  return memDb().postActions
    .filter((a) => (a.business_phone === phone || a.phone === phone) && (!since || (a.at && toDate(a.at).getTime() >= since.getTime())))
    .map((a) => norm(clone(a)));
}

// ── connections (businesses/{phone}/connections/facebook) ──
// Firestore: a collection-group query; the phone is the grandparent doc id.
async function phonesWhere(field, op, value, memTest) {
  const fdb = firestore();
  if (fdb) {
    const snap = await fdb.collectionGroup("connections").where(field, op, value).get();
    return [...new Set(snap.docs.map((d) => d.ref.parent.parent && d.ref.parent.parent.id).filter(Boolean))];
  }
  return [...memDb().connections.entries()].filter(([, c]) => c && memTest(c[field])).map(([phone]) => phone);
}

function listConnectedPhones(platform = "facebook") {
  if (!PLATFORM.test(platform)) throw fail("invalid_input", "invalid platform");
  return phonesWhere(`${platform}_browser_connected_at`, ">", "", (v) => typeof v === "string" && v > "");
}

// posting_last_halt_at is written (ISO) by the halt handler alongside posting_halts.
function listPhonesHaltedSince(iso) {
  const since = toIso(iso);
  return phonesWhere("posting_last_halt_at", ">=", since, (v) => typeof v === "string" && v >= since);
}

// ── dwell (browse) sessions (dwell_sessions/{id}) ──
// Only these fields are ever stored — no post text, names or URLs.
const DWELL_FIELDS = new Set(["phone", "platform", "at", "actions_summary", "likes", "halt_related"]);
const DWELL_RETENTION_DAYS = 90, DWELL_HALT_RETENTION_DAYS = 365;

function cleanActionsSummary(s) {
  if (s === undefined || s === null) return {};
  if (!isPlainObject(s)) throw fail("invalid_input", "actions_summary must be an object of counts");
  const entries = Object.entries(s);
  if (entries.length > 20) throw fail("invalid_input", "actions_summary too large");
  for (const [k, v] of entries) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(k) || !Number.isFinite(v) || v < 0) throw fail("invalid_input", "actions_summary must map action names to non-negative numbers");
  }
  return { ...s };
}

async function saveDwellSession(s) {
  if (!isPlainObject(s)) throw fail("invalid_input", "dwell session must be an object");
  const extra = Object.keys(s).filter((k) => !DWELL_FIELDS.has(k));
  if (extra.length) throw fail("invalid_input", `dwell session may not carry ${extra.join(", ")}`);
  const phone = assertId(s.phone, "phone");
  if (typeof s.platform !== "string" || !PLATFORM.test(s.platform)) throw fail("invalid_input", "invalid platform");
  const at = toDate(s.at);
  const likes = s.likes === undefined ? 0 : s.likes;
  if (!Number.isInteger(likes) || likes < 0) throw fail("invalid_input", "likes must be a non-negative integer");
  if (s.halt_related !== undefined && typeof s.halt_related !== "boolean") throw fail("invalid_input", "halt_related must be boolean");
  const halt_related = s.halt_related === true;
  const id = crypto.randomBytes(12).toString("hex");
  const doc = {
    id, phone, platform: s.platform, at: at.toISOString(), actions_summary: cleanActionsSummary(s.actions_summary), likes, halt_related,
    // A Date, so Firestore stores a Timestamp a TTL policy can act on.
    expire_at: new Date(at.getTime() + (halt_related ? DWELL_HALT_RETENTION_DAYS : DWELL_RETENTION_DAYS) * MS_DAY),
  };
  const fdb = firestore();
  if (fdb) await fdb.collection(DWELL).doc(id).set(doc);
  else maps[DWELL].set(id, clone(doc));
  return id;
}

async function listDwellSessionsByPhone(phone, sinceMs) {
  assertId(phone, "phone");
  const since = sinceMs ? toIso(sinceMs) : null;
  const fdb = firestore();
  let rows;
  if (fdb) {
    let q = fdb.collection(DWELL).where("phone", "==", phone);
    if (since) q = q.where("at", ">=", since);
    rows = (await q.get()).docs.map((d) => d.data());
  } else rows = [...maps[DWELL].values()].filter((d) => d.phone === phone && (!since || d.at >= since)).map(clone);
  rows = rows.map((d) => ({ ...d, at: d.at ? toIso(d.at) : null, expire_at: d.expire_at ? toIso(d.expire_at) : null }));
  return rows.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
}

module.exports = {
  // campaigns
  campaignId, createPostingCampaignIfAbsent, getPostingCampaign, updatePostingCampaign, mutatePostingCampaign,
  listPostingCampaignsByStatus, listPostingCampaignsByPhone,
  // attempts (R1) and group activity — posting-attempts.js
  LEASE_MS: attempts.LEASE_MS, EDGES: attempts.EDGES, countingStates: attempts.countingStates, isCounting: attempts.isCounting,
  attemptKey: attempts.attemptKey, reserveAttempt: attempts.reserveAttempt, transition: attempts.transition,
  reapExpired: attempts.reapExpired, cancelOpenAttempts: attempts.cancelOpenAttempts,
  getAttempt: attempts.getAttempt, listAttemptsByPhone: attempts.listAttemptsByPhone, listAttemptsByState: attempts.listAttemptsByState,
  getGroupActivityFor: attempts.getGroupActivityFor,
  // manual posts, connections
  listPostActionsByPhone, listConnectedPhones, listPhonesHaltedSince,
  // dwell sessions
  saveDwellSession, listDwellSessionsByPhone,
  _test: {
    reset() { for (const m of Object.values(maps)) m.clear(); attempts._test.reset(); },
    maps: Object.assign({}, maps, attempts._test.maps),
    dedupKey: attempts._test.dedupKey,
  },
};
