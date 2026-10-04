/*
 * posting-tx.js — one transaction shape for Firestore and the in-memory store,
 * shared by posting-store.js and posting-attempts.js.
 *
 * The posting stores keep their business logic in a single `fn(tx)` that runs
 * against either backend, so the memory path the tests exercise is the same
 * code Firestore runs. `tx` offers:
 *   await tx.get(collection, id) -> plain data | null
 *   tx.set(collection, id, data, { merge })   (merge: deep-merge maps, arrays replaced)
 *   tx.del(collection, id)
 * Firestore rule, enforced on both paths: every read comes before any write.
 * The memory path buffers writes and applies them only when `fn` resolves,
 * so a throw leaves nothing half-written, and it serialises transactions so
 * two concurrent reservations cannot interleave between read and write.
 *
 * The Firestore handle is read from require("./db").db at CALL time (null =
 * the in-memory store), never cached at load.
 */
const crypto = require("crypto");

const firestore = () => require("./db").db;

function fail(code, message) { const e = new Error(message || code); e.code = code; return e; }

// A map, not a class instance: a Firestore Timestamp read back and written
// again must stay a Timestamp, never be merged into or rebuilt as a map.
const isPlainObject = (v) => v !== null && typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v));

// Firestore refuses `undefined`; drop it on both paths so memory matches.
function stripUndefined(v) {
  if (Array.isArray(v)) return v.map(stripUndefined);
  if (!isPlainObject(v)) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = stripUndefined(x);
  return out;
}

// set(..., { merge: true }) semantics: non-empty nested maps merge, anything
// else replaces. An explicitly empty map replaces too: Firestore's merge mask
// names the field itself, so `{ meta: {} }` leaves `meta` empty.
function deepMerge(target, patch) {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && Object.keys(v).length && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

// HMAC-SHA256 under PROFILE_KEY, read at call time; hex, truncated.
function hmacHex(material, len = 32) {
  const key = process.env.PROFILE_KEY;
  if (!key) throw new Error("posting-store: PROFILE_KEY required");
  return crypto.createHmac("sha256", key).update(material).digest("hex").slice(0, len);
}

function toDate(v) {
  const d = v === undefined || v === null ? new Date() : v instanceof Date ? new Date(v.getTime()) : new Date(v && v.toDate ? v.toDate() : v);
  if (Number.isNaN(d.getTime())) throw fail("invalid_input", "invalid date");
  return d;
}
const toIso = (v) => toDate(v).toISOString();

function firestoreTx(fdb, t) {
  const ref = (c, id) => fdb.collection(c).doc(id);
  return {
    async get(c, id) { const s = await t.get(ref(c, id)); return s.exists ? s.data() : null; },
    set(c, id, data, opts = {}) { t.set(ref(c, id), stripUndefined(data), opts.merge ? { merge: true } : {}); },
    del(c, id) { t.delete(ref(c, id)); },
  };
}

function memTx(maps) {
  const writes = [];
  const map = (c) => { const m = maps[c]; if (!m) throw new Error(`posting-tx: no memory map for ${c}`); return m; };
  return {
    async get(c, id) {
      if (writes.length) throw new Error("posting-tx: read after write in a transaction");
      const v = map(c).get(id);
      return v === undefined ? null : structuredClone(v);
    },
    set(c, id, data, opts = {}) {
      const m = map(c); const clean = structuredClone(stripUndefined(data));
      writes.push(() => m.set(id, opts.merge && m.has(id) ? deepMerge(m.get(id), clean) : clean));
    },
    del(c, id) { const m = map(c); writes.push(() => m.delete(id)); },
    commit() { for (const w of writes) w(); },
  };
}

let chain = Promise.resolve();
function memLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// Firestore may re-run `fn` on contention: it must have no side effects
// outside `tx`.
function runTx(maps, fn) {
  const fdb = firestore();
  if (fdb) return fdb.runTransaction((t) => fn(firestoreTx(fdb, t)));
  return memLock(async () => {
    const tx = memTx(maps);
    const out = await fn(tx);
    tx.commit();
    return out;
  });
}

// Ids end up inside document ids and HMAC material joined by "|": neither
// "/" (a Firestore path separator) nor "|" may appear.
function assertId(v, name) {
  if (typeof v !== "string" || !v || v.length > 200 || /[/|]/.test(v)) throw fail("invalid_input", `${name} must be a non-empty id without "/" or "|"`);
  return v;
}

module.exports = { firestore, runTx, fail, hmacHex, toDate, toIso, assertId, isPlainObject, stripUndefined, deepMerge };
