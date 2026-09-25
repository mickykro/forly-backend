/* posting-store.js — the Firestore path, against a small in-process fake that
   enforces what real Firestore does and the memory path might hide: reads
   before writes in a transaction, no `undefined` values, range filters that
   only match values of the same type (null never matches `<`), merge
   semantics (an empty map replaces), Timestamps instead of Dates on read,
   optimistic transaction isolation with retries, collection-group queries.
   No network. */
process.env.PROFILE_KEY = "test-profile-key-16a";
process.env.FORLY_ENV = "local";
const assert = require("assert");
const dbModule = require("./db");
const S = require("./posting-store");

// Firestore hands back Timestamps, never Dates.
class Timestamp {
  constructor(ms) { this._ms = ms; }
  toDate() { return new Date(this._ms); }
  toMillis() { return this._ms; }
}
const isObj = (v) => v !== null && typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const isTime = (v) => v instanceof Date || v instanceof Timestamp;
function assertNoUndefined(v, p = "") {
  if (v === undefined) throw new Error(`Cannot use "undefined" as a Firestore value (${p})`);
  if (Array.isArray(v)) v.forEach((x, i) => assertNoUndefined(x, `${p}[${i}]`));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) assertNoUndefined(x, `${p}.${k}`);
}
// Deep copy; every Date (and Timestamp) comes out as a fresh Timestamp.
function copy(v) {
  if (isTime(v)) return new Timestamp(v instanceof Date ? v.getTime() : v.toMillis());
  if (Array.isArray(v)) return v.map(copy);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
  return v;
}
// merge:true — the mask names leaf fields; an explicitly empty map is itself a leaf and replaces.
const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = isObj(v) && Object.keys(v).length && isObj(o[k]) ? merge(o[k], v) : v; return o; };
const ms = (v) => (v instanceof Date ? v.getTime() : v instanceof Timestamp ? v.toMillis() : v);
const sameType = (a, b) => a !== null && a !== undefined && isTime(a) === isTime(b) && typeof a === typeof b;
const OPS = {
  "==": (a, b) => (isTime(a) && isTime(b) ? ms(a) === ms(b) : a === b),
  "<": (a, b) => sameType(a, b) && ms(a) < ms(b),
  ">": (a, b) => sameType(a, b) && ms(a) > ms(b),
  ">=": (a, b) => sameType(a, b) && ms(a) >= ms(b),
  in: (a, b) => b.includes(a),
};
const tick = () => new Promise((r) => setImmediate(r));

function fakeFirestore() {
  const docs = new Map();
  const versions = new Map(); // path -> write count; a missing doc is version 0 until written
  const version = (p) => versions.get(p) || 0;
  const bump = (p) => versions.set(p, version(p) + 1);
  const stats = { txRuns: 0, txRetries: 0, queries: [] };
  const snap = (path) => ({ id: path.split("/").pop(), ref: docRef(path), exists: docs.has(path), data: () => (docs.has(path) ? copy(docs.get(path)) : undefined) });
  const write = (path, d, o = {}) => { assertNoUndefined(d); const c = copy(d); docs.set(path, o.merge && docs.has(path) ? merge(docs.get(path), c) : c); bump(path); };
  const remove = (path) => { docs.delete(path); bump(path); };
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
      async get() { return snap(path); }, async set(d, o) { write(path, d, o); }, async delete() { remove(path); },
    };
  }
  return {
    docs, stats,
    collection: colRef,
    collectionGroup: (name) => query((p) => parentOf(p).split("/").pop() === name && parentOf(p).includes("/"), `group:${name}`),
    async getAll(...refs) { return refs.map((r) => snap(r.path)); },
    // Optimistic isolation: every doc read (missing ones too) is recorded with
    // its version; if any changed before commit, nothing is written and `fn`
    // re-runs — up to 5 times, then ABORTED, like the real SDK.
    async runTransaction(fn) {
      for (let run = 0; run < 5; run++) {
        stats.txRuns++;
        const reads = new Map(); const buf = []; let wrote = false;
        const t = {
          async get(ref) {
            if (wrote) throw new Error("Firestore transactions require all reads to be executed before all writes.");
            const s = snap(ref.path);
            if (!reads.has(ref.path)) reads.set(ref.path, version(ref.path));
            await tick(); // let a concurrent transaction interleave here
            return s;
          },
          set(ref, d, o) { wrote = true; assertNoUndefined(d); buf.push(() => write(ref.path, d, o)); return t; },
          delete(ref) { wrote = true; buf.push(() => remove(ref.path)); return t; },
        };
        const out = await fn(t);
        if ([...reads].every(([p, v]) => version(p) === v)) { for (const w of buf) w(); return out; }
        stats.txRetries++;
      }
      throw Object.assign(new Error("10 ABORTED: Too much contention on these documents."), { code: 10 });
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
  {
    const again = await S.reserveAttempt(res());
    assert.equal(again.reason, "already_reserved");
    assert.equal(again.attempt.key, a.key);
    assert.equal(again.attempt.state, "reserved");
  }
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
  // the group_aliases registry folds through the same batched reads (Task 18)
  await S.recordGroupAlias("slug:haifa.rent", "111", NOW);
  assert.equal(doc("group_aliases/slug:haifa.rent").group_id, "111");
  assert.equal((await S.getGroupActivityFor(["slug:haifa.rent"], NOW))["slug:haifa.rent"].posts_today, 1, "the slug sees 111's bucket");

  // ── campaigns: create-if-absent, update never creates, undefined stripped ──
  const first = await S.createPostingCampaignIfAbsent({ phone: "972500000001", page_id: "pg1", status: "running", posts: [{ id: "p", copy: undefined }] });
  assert.equal(first.created, true);
  assert.equal((await S.createPostingCampaignIfAbsent({ phone: "972500000001", page_id: "pg1", status: "stopped" })).created, false);
  assert.equal((await S.getPostingCampaign(first.campaign.id)).status, "running");
  assert.equal((await S.updatePostingCampaign(first.campaign.id, { status: "paused", meta: { a: 1 } })).status, "paused");
  assert.deepEqual((await S.updatePostingCampaign(first.campaign.id, { meta: { b: 2 } })).meta, { a: 1, b: 2 });
  assert.deepEqual(doc(`posting_campaigns/${first.campaign.id}`).meta, { a: 1, b: 2 });
  assert.deepEqual((await S.updatePostingCampaign(first.campaign.id, { meta: {} })).meta, {});
  assert.deepEqual(doc(`posting_campaigns/${first.campaign.id}`).meta, {}, "an empty map replaces, on Firestore as in memory");
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

  // ── dwell sessions: expire_at is a Date (a TTL-able Timestamp); likes is an
  // array of {post_id, at}, stored and read back plainly (no Timestamp involved) ──
  await assert.rejects(S.saveDwellSession({ phone: "972500000001", platform: "facebook", at: NOW, actions_summary: {}, likes: [{ post_id: "abc", at: NOW.toISOString() }] }), code("invalid_input"));
  await assert.rejects(S.saveDwellSession({ phone: "972500000001", platform: "facebook", at: NOW, actions_summary: {}, likes: [{ post_id: "1234567890", at: NOW }] }), code("invalid_input"), "at must be an ISO string");
  const id = await S.saveDwellSession({ phone: "972500000001", platform: "facebook", at: NOW, actions_summary: { scrolls: 3, like: 1 }, likes: [{ post_id: "1234567890", at: NOW.toISOString() }] });
  assert.ok(doc(`dwell_sessions/${id}`).expire_at instanceof Timestamp);
  assert.deepEqual(doc(`dwell_sessions/${id}`).likes, [{ post_id: "1234567890", at: NOW.toISOString() }]);
  {
    const listed = await S.listDwellSessionsByPhone("972500000001", NOW.getTime() - 1);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].expire_at, new Date(NOW.getTime() + 90 * DAY).toISOString(), "a Timestamp comes back as ISO");
    assert.equal(listed[0].at, NOW.toISOString());
    assert.deepEqual(listed[0].likes, [{ post_id: "1234567890", at: NOW.toISOString() }]);
  }
  {
    const recent = await S.listRecentLikedPostIds("972500000001", NOW.getTime() - 1);
    assert.deepEqual([...recent], ["1234567890"]);
  }

  // ── two concurrent reservations for one remaining budget slot: exactly one wins ──
  {
    const retriesBefore = fake.stats.txRetries;
    const lim = { daily_cap: 1, group_global_daily_cap: 5 };
    const both = await Promise.all([
      S.reserveAttempt(res({ phone: "972500000077", page_id: "race1", target_id: "701", limits: lim })),
      S.reserveAttempt(res({ phone: "972500000077", page_id: "race2", target_id: "702", limits: lim })),
    ]);
    assert.equal(both.filter((r) => r.ok).length, 1);
    assert.deepEqual(both.filter((r) => !r.ok).map((r) => r.reason), ["daily_cap"]);
    assert.equal(doc("posting_budget/972500000077|2026-09-23").count, 1);
    assert.ok(fake.stats.txRetries > retriesBefore, "the loser really raced and was re-run");
    // Same key twice at once: one reservation, one already_reserved.
    const same = await Promise.all([S.reserveAttempt(res({ phone: "972500000078", page_id: "race3" })), S.reserveAttempt(res({ phone: "972500000078", page_id: "race3" }))]);
    assert.deepEqual(same.map((r) => r.reason || "ok").sort(), ["already_reserved", "ok"]);
    assert.equal(doc("posting_budget/972500000078|2026-09-23").count, 1);
  }

  // ── an approval racing a tick update of another post: both changes survive
  //    (mutatePostingCampaign re-runs the loser against the winner's write) ──
  {
    const c = (await S.createPostingCampaignIfAbsent({ phone: "972500000090", page_id: "racepg", status: "running", posts: [{ id: "p1", status: "pending_approval" }, { id: "p2", status: "scheduled" }] })).campaign;
    const retriesBefore = fake.stats.txRetries;
    let approveRuns = 0;
    const setPost = (cur, id, patch) => ({ posts: cur.posts.map((p) => (p.id === id ? Object.assign({}, p, patch) : p)) });
    await Promise.all([
      S.mutatePostingCampaign(c.id, (cur) => { approveRuns++; return setPost(cur, "p1", { status: "scheduled", approved_at: NOW.toISOString() }); }),
      S.mutatePostingCampaign(c.id, (cur) => setPost(cur, "p2", { status: "posting", attempt_key: "k2" })),
    ]);
    const after = await S.getPostingCampaign(c.id);
    assert.deepEqual(after.posts.map((p) => [p.id, p.status]), [["p1", "scheduled"], ["p2", "posting"]], "both changes kept");
    assert.ok(fake.stats.txRetries > retriesBefore && approveRuns >= 1, "the two really raced; the loser was re-run on fresh data");
    assert.equal(await S.mutatePostingCampaign(c.id, () => null).then((x) => x.id), c.id, "null → no write, the current campaign");
    assert.equal(await S.mutatePostingCampaign("nope", () => ({ status: "x" })), null);
    await assert.rejects(S.mutatePostingCampaign(c.id, () => ({ phone: "other" })), code("invalid_input"));
  }

  // ── an expired dedup is overwritten on the Firestore path too ──
  {
    const lim = { daily_cap: 9, group_global_daily_cap: 9, dedup_days: 14 };
    const r1 = await S.reserveAttempt(res({ phone: "972500000091", page_id: "dd1", target_id: "801", limits: lim }));
    assert.equal(r1.ok, true);
    assert.equal((await S.reserveAttempt(res({ phone: "972500000091", page_id: "dd1", target_id: "801", limits: lim, now: new Date(NOW.getTime() + 10 * DAY) }))).reason, "duplicate");
    assert.equal((await S.reserveAttempt(res({ phone: "972500000091", page_id: "dd1", target_id: "801", limits: lim, now: new Date(NOW.getTime() + 15 * DAY) }))).ok, true);
  }

  // ── mutateConnection: two halts landing at once both survive; the later one sees
  //    the earlier and asks for the owner review (fix round 1) ──
  {
    const H = require("./posting-halts");
    const ph = "972500000095";
    await fake.collection(`businesses/${ph}/connections`).doc("facebook").set({ facebook_browser_connected_at: NOW.toISOString(), posting_halts: [] });
    const retriesBefore = fake.stats.txRetries;
    const outs = await Promise.all([
      H.haltAccount(ph, "restricted", { config: require("./posting-safety").DEFAULTS, env: {} }, { now: NOW }),
      H.haltAccount(ph, "captcha", { config: require("./posting-safety").DEFAULTS, env: {}, lifecycle: { quarantine: async () => {} } }, { now: NOW }),
    ]);
    const conn = doc(`businesses/${ph}/connections/facebook`);
    assert.deepEqual(conn.posting_halts.map((h) => h.code).sort(), ["captcha", "restricted"], "no halt entry lost");
    assert.equal(conn.posting_owner_review_required, true);
    assert.equal(outs.filter((o) => o.owner_review).length, 1, "exactly the later halt saw the earlier one");
    assert.ok(fake.stats.txRetries > retriesBefore, "they really raced");
    // null → no write; the connection comes back opened
    const same = await S.mutateConnection(ph, () => null);
    assert.equal(same.posting_owner_review_required, true);
    await assert.rejects(S.mutateConnection("a/b", () => ({})), code("invalid_input"));
  }

  console.log("posting-store.firestore.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
