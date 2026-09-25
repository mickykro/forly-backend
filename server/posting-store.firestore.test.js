/* posting-store.js — the Firestore path, against a small in-process fake that
   enforces what real Firestore does and the memory path might hide: reads
   before writes in a transaction, no `undefined` values, range filters that
   only match values of the same type (null never matches `<`), merge
   semantics, collection-group queries. No network. */
process.env.PROFILE_KEY = "test-profile-key-16a";
process.env.FORLY_ENV = "local";
const assert = require("assert");
const dbModule = require("./db");
const S = require("./posting-store");

const isObj = (v) => Object.prototype.toString.call(v) === "[object Object]";
function assertNoUndefined(v, p = "") {
  if (v === undefined) throw new Error(`Cannot use "undefined" as a Firestore value (${p})`);
  if (Array.isArray(v)) v.forEach((x, i) => assertNoUndefined(x, `${p}[${i}]`));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) assertNoUndefined(x, `${p}.${k}`);
}
const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = isObj(v) && isObj(o[k]) ? merge(o[k], v) : v; return o; };
const val = (v) => (v instanceof Date ? v.getTime() : v);
const sameType = (a, b) => a !== null && a !== undefined && (a instanceof Date) === (b instanceof Date) && typeof a === typeof b;
const OPS = {
  "==": (a, b) => a === b || (a instanceof Date && b instanceof Date && a.getTime() === b.getTime()),
  "<": (a, b) => sameType(a, b) && val(a) < val(b),
  ">": (a, b) => sameType(a, b) && val(a) > val(b),
  ">=": (a, b) => sameType(a, b) && val(a) >= val(b),
  in: (a, b) => b.includes(a),
};

function fakeFirestore() {
  const docs = new Map();
  const stats = { txReads: 0, queries: [] };
  const snap = (path) => ({ id: path.split("/").pop(), ref: docRef(path), exists: docs.has(path), data: () => (docs.has(path) ? structuredClone(docs.get(path)) : undefined) });
  const write = (path, d, o = {}) => { assertNoUndefined(d); const c = structuredClone(d); docs.set(path, o.merge && docs.has(path) ? merge(docs.get(path), c) : c); };
  function query(match, desc, filters = [], lim = 0) {
    return {
      where: (f, op, v) => { if (!OPS[op]) throw new Error(`op ${op}`); return query(match, desc, filters.concat([[f, op, v]]), lim); },
      limit: (n) => query(match, desc, filters, n),
      async get() {
        stats.queries.push({ on: desc, filters: filters.map(([f, op]) => `${f} ${op}`) });
        let hits = [...docs.keys()].filter(match).filter((p) => filters.every(([f, op, v]) => OPS[op](docs.get(p)[f], v)));
        if (lim) hits = hits.slice(0, lim);
        return { docs: hits.map(snap) };
      },
    };
  }
  const parentOf = (p) => p.split("/").slice(0, -1).join("/");
  function colRef(path) {
    return Object.assign(query((p) => parentOf(p) === path, path), {
      id: path.split("/").pop(), doc: (id) => docRef(`${path}/${id}`),
      get parent() { const s = path.split("/"); return s.length > 1 ? docRef(s.slice(0, -1).join("/")) : null; },
    });
  }
  function docRef(path) {
    return {
      path, id: path.split("/").pop(), get parent() { return colRef(parentOf(path)); },
      collection: (c) => colRef(`${path}/${c}`),
      async get() { return snap(path); }, async set(d, o) { write(path, d, o); }, async delete() { docs.delete(path); },
    };
  }
  return {
    docs, stats,
    collection: colRef,
    collectionGroup: (name) => query((p) => parentOf(p).split("/").pop() === name && parentOf(p).includes("/"), `group:${name}`),
    async getAll(...refs) { return refs.map((r) => snap(r.path)); },
    async runTransaction(fn) {
      const buf = []; let wrote = false;
      const t = {
        async get(ref) { if (wrote) throw new Error("Firestore transactions require all reads to be executed before all writes."); stats.txReads++; return snap(ref.path); },
        set(ref, d, o) { wrote = true; assertNoUndefined(d); buf.push(() => write(ref.path, d, o)); return t; },
        delete(ref) { wrote = true; buf.push(() => docs.delete(ref.path)); return t; },
      };
      const out = await fn(t);
      for (const w of buf) w();
      return out;
    },
  };
}

const fake = fakeFirestore();
Object.defineProperty(dbModule, "db", { get: () => fake, configurable: true });

const NOW = new Date("2026-09-23T07:00:00Z");
const MIN = 60000, DAY = 86400000;
const code = (c) => (e) => e.code === c;
const fp = { exact: "a1b2", strong: "c3d4", weak: null };
const res = (o = {}) => Object.assign({ phone: "972500000001", page_id: "pg1", campaign_id: "c1", post_id: undefined, target_type: "group", target_id: "111",
  target_url: "https://www.facebook.com/groups/111", publisher: "browser", fingerprint: fp, now: NOW, limits: { daily_cap: 2, group_global_daily_cap: 2 } }, o);
const doc = (p) => fake.docs.get(p);

(async () => {
  // ── reserve writes all four docs in one transaction; second is refused ──
  const a = (await S.reserveAttempt(res())).attempt;
  assert.equal(doc(`posting_attempts/${a.key}`).state, "reserved");
  assert.equal(doc("posting_budget/972500000001|2026-09-23").count, 1);
  assert.equal(doc("group_activity/111|2026-09-23").posts, 1);
  assert.deepEqual(doc("group_activity/111|2026-09-23").fingerprints, [{ exact: "a1b2", strong: "c3d4", weak: null, at: NOW.toISOString() }]);
  assert.equal(doc(`posting_dedup/${S._test.dedupKey("pg1", "group", "111")}`).key, a.key);
  assert.deepEqual(await S.reserveAttempt(res()), { ok: false, reason: "already_reserved" });
  assert.deepEqual(await S.reserveAttempt(res({ page_id: "pg1", campaign_id: "c2", now: new Date(NOW.getTime() + DAY) })), { ok: false, reason: "duplicate" });

  // ── cancel releases on Firestore too; lease_until null is never reaped ──
  await S.transition(a.key, "session_started", { note: undefined }, NOW);
  const c = await S.transition(a.key, "cancelled", { error_code: "posting_disabled" }, NOW);
  assert.equal(c.released, true);
  assert.equal(doc("posting_budget/972500000001|2026-09-23").count, 0);
  assert.equal(doc("group_activity/111|2026-09-23").posts, 0);
  assert.deepEqual(doc("group_activity/111|2026-09-23").fingerprints, []);
  assert.equal(doc(`posting_dedup/${S._test.dedupKey("pg1", "group", "111")}`), undefined);
  assert.equal(doc(`posting_attempts/${a.key}`).lease_until, null);
  assert.deepEqual(doc(`posting_attempts/${a.key}`).history.map((h) => h.state), ["reserved", "session_started", "cancelled"]);

  // ── in-flight past submit → outcome_unknown by the reaper; pre-submit → cancelled ──
  const b = (await S.reserveAttempt(res({ page_id: "pg2" }))).attempt;
  for (const s of ["session_started", "composer_ready", "submit_started"]) await S.transition(b.key, s, {}, NOW);
  const r = (await S.reserveAttempt(res({ page_id: "pg3", target_type: "page", target_id: "fbp" }))).attempt;
  assert.equal(r.activity_key, null);
  assert.deepEqual(await S.reserveAttempt(res({ page_id: "pg4", target_id: "222" })), { ok: false, reason: "daily_cap" });
  const reaped = await S.reapExpired(new Date(NOW.getTime() + 21 * MIN));
  assert.deepEqual(reaped.map((x) => `${x.from}>${x.to}`).sort(), ["reserved>cancelled", "submit_started>outcome_unknown"]);
  assert.deepEqual(await S.reapExpired(new Date(NOW.getTime() + 3 * DAY)), []);
  await assert.rejects(S.transition(b.key, "submit_started", {}, NOW), code("illegal_transition"));
  assert.equal((await S.transition(b.key, "verified_posted", { permalink: "https://www.facebook.com/groups/111/posts/1" }, NOW)).state, "verified_posted");

  // ── cancelOpenAttempts via db.js ──
  const o = (await S.reserveAttempt(res({ phone: "972500000002", page_id: "pg5" }))).attempt;
  assert.equal(await dbModule.cancelOpenAttempts("972500000002", "facebook"), 1);
  assert.equal(doc(`posting_attempts/${o.key}`).error_code, "revoked");
  assert.equal((await S.listAttemptsByPhone("972500000001", NOW.getTime() - 1)).length, 3);
  assert.equal((await S.listAttemptsByState("verified_posted")).length, 1);
  assert.equal((await S.getAttempt(b.key)).state, "verified_posted");

  // ── group activity via getAll ──
  const ga = await S.getGroupActivityFor(["111", "999"], NOW);
  assert.equal(ga["111"].posts_today, 1, "b (posted) still counts; a was released");
  assert.equal(ga["111"].fingerprints.length, 1);
  assert.deepEqual(ga["999"], { posts_today: 0, fingerprints: [] });

  // ── campaigns: create-if-absent, update never creates, undefined stripped ──
  const first = await S.createPostingCampaignIfAbsent({ phone: "972500000001", page_id: "pg1", status: "running", posts: [{ id: "p", copy: undefined }] });
  assert.equal(first.created, true);
  assert.equal((await S.createPostingCampaignIfAbsent({ phone: "972500000001", page_id: "pg1", status: "stopped" })).created, false);
  assert.equal((await S.getPostingCampaign(first.campaign.id)).status, "running");
  assert.equal((await S.updatePostingCampaign(first.campaign.id, { status: "paused", meta: { a: 1 } })).status, "paused");
  assert.deepEqual((await S.updatePostingCampaign(first.campaign.id, { meta: { b: 2 } })).meta, { a: 1, b: 2 });
  assert.deepEqual(doc(`posting_campaigns/${first.campaign.id}`).meta, { a: 1, b: 2 });
  assert.equal(await S.updatePostingCampaign("nope", { status: "running" }), null);
  assert.equal(doc("posting_campaigns/nope"), undefined);
  assert.equal((await S.listPostingCampaignsByStatus("paused")).length, 1);
  assert.equal((await S.listPostingCampaignsByPhone("972500000001")).length, 1);

  // ── post_actions, connections (collection group), halts ──
  await fake.collection("post_actions").doc("x1").set({ business_phone: "972500000001", target: "facebook_group", at: new Date(NOW.getTime() - DAY) });
  await fake.collection("post_actions").doc("x2").set({ business_phone: "972500000001", target: "facebook_group", at: new Date(NOW.getTime() - 9 * DAY) });
  const acts = await S.listPostActionsByPhone("972500000001", NOW.getTime() - 7 * DAY);
  assert.deepEqual(acts.map((x) => x.at), [new Date(NOW.getTime() - DAY).toISOString()]);
  await fake.collection("businesses").doc("972500000011").collection("connections").doc("facebook").set({ facebook_browser_connected_at: NOW.toISOString(), posting_last_halt_at: NOW.toISOString() });
  await fake.collection("businesses").doc("972500000012").collection("connections").doc("facebook").set({ facebook_browser_connected_at: null });
  assert.deepEqual(await S.listConnectedPhones(), ["972500000011"]);
  assert.deepEqual(await S.listPhonesHaltedSince(new Date(NOW.getTime() - 3600000).toISOString()), ["972500000011"]);

  // ── dwell sessions: expire_at is a Date (a TTL-able Timestamp) ──
  const id = await S.saveDwellSession({ phone: "972500000001", platform: "facebook", at: NOW, actions_summary: { scrolls: 3 }, likes: 0 });
  assert.ok(doc(`dwell_sessions/${id}`).expire_at instanceof Date);
  assert.equal((await S.listDwellSessionsByPhone("972500000001", NOW.getTime() - 1)).length, 1);

  console.log("posting-store.firestore.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
