const { stripUndefined } = require("../posting-tx");
const collections = [
  "leads",
  "demos",
  "assets",
  "attempts",
  "suppressions",
  "audit",
  "jobs",
  "tokens",
  "challenges",
];
const name = (c) => {
  if (!collections.includes(c)) throw new Error("invalid outreach collection");
  return `outreach_${c === "audit" ? "audit_events" : c === "attempts" ? "delivery_attempts" : c}`;
};
function createMemoryStore() {
  const maps = Object.fromEntries(collections.map((c) => [c, new Map()]));
  let chain = Promise.resolve();
  return {
    async get(c, id) {
      return structuredClone(maps[c].get(id) || null);
    },
    async getMany(c, ids) {
      return ids.map((id) => structuredClone(maps[c].get(id) || null));
    },
    async list(
      c,
      { limit = 100, pending = false, demoId, dueBefore, cursor } = {},
    ) {
      return [...maps[c].values()]
        .filter(
          (x) =>
            (!pending || x.status !== "done") &&
            (!demoId || x.demo_id === demoId) &&
            (!dueBefore || x.due_at <= dueBefore) &&
            (!cursor || x.id > cursor),
        )
        .sort((a, b) =>
          dueBefore
            ? String(a.due_at).localeCompare(String(b.due_at))
            : String(a.id).localeCompare(String(b.id)),
        )
        .slice(0, Math.min(limit, 200))
        .map((x) => structuredClone(x));
    },
    transaction(fn) {
      const run = chain.then(async () => {
        const writes = [];
        const result = await fn({
          get: async (c, id) => {
            if (writes.length) throw Error("read after write");
            return structuredClone(maps[c].get(id) || null);
          },
          set(c, id, row) {
            writes.push(() =>
              maps[c].set(id, structuredClone(stripUndefined(row))),
            );
          },
          delete(c, id) {
            writes.push(() => maps[c].delete(id));
          },
        });
        writes.forEach((f) => f());
        return result;
      });
      chain = run.catch(() => {});
      return run;
    },
  };
}
function createFirestoreStore(db) {
  return {
    async get(c, id) {
      const s = await db.collection(name(c)).doc(id).get();
      return s.exists ? s.data() : null;
    },
    async getMany(c, ids) {
      if (!ids.length) return [];
      return (
        await db.getAll(...ids.map((id) => db.collection(name(c)).doc(id)))
      ).map((s) => (s.exists ? s.data() : null));
    },
    async list(
      c,
      { limit = 100, pending = false, demoId, dueBefore, cursor } = {},
    ) {
      let q = db.collection(name(c));
      if (pending) q = q.where("status", "in", ["queued", "running"]);
      if (demoId) q = q.where("demo_id", "==", demoId);
      if (dueBefore) q = q.where("due_at", "<=", dueBefore).orderBy("due_at");
      if (c === "leads") {
        q = q.orderBy("__name__");
        if (cursor) q = q.startAfter(cursor);
      }
      const s = await q.limit(Math.min(limit, 200)).get();
      return s.docs.map((d) => d.data());
    },
    transaction(fn) {
      return db.runTransaction((t) =>
        fn({
          get: async (c, id) => {
            const s = await t.get(db.collection(name(c)).doc(id));
            return s.exists ? s.data() : null;
          },
          set(c, id, row) {
            t.set(db.collection(name(c)).doc(id), stripUndefined(row));
          },
          delete(c, id) {
            t.delete(db.collection(name(c)).doc(id));
          },
        }),
      );
    },
  };
}
const memory = createMemoryStore();
const current = () =>
  require("../db").db ? createFirestoreStore(require("../db").db) : memory;
module.exports = {
  createMemoryStore,
  createFirestoreStore,
  get: (...a) => current().get(...a),
  getMany: (...a) => current().getMany(...a),
  list: (...a) => current().list(...a),
  transaction: (...a) => current().transaction(...a),
};
