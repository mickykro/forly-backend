// Durable replay, daily cost and concurrent-build admission. Memory is local/test only.
const crypto = require("node:crypto");
function createCallbackLedger({
  db = null,
  now = Date.now,
  leaseMs = 10 * 60 * 1000,
} = {}) {
  if (
    (process.env.NODE_ENV === "production" ||
      process.env.FORLY_ENV === "prod") &&
    !db
  )
    throw new Error("durable callback database required in production");
  const memory = new Map();
  let queue = Promise.resolve();
  async function run(fn) {
    if (db)
      return db.runTransaction((tx) =>
        fn({
          get: async (id) => {
            const d = await tx.get(
              db.collection("outreach_callback_limits").doc(id),
            );
            return d.exists ? d.data() : null;
          },
          set: (id, data) =>
            tx.set(db.collection("outreach_callback_limits").doc(id), data),
        }),
      );
    const pending = queue.then(() =>
      fn({
        get: async (id) => memory.get(id) || null,
        set: (id, data) => memory.set(id, data),
      }),
    );
    queue = pending.catch(() => {});
    return pending;
  }
  async function reserve({ id, purpose, day, maxDaily, maxConcurrent }) {
    if (
      typeof id !== "string" ||
      !id ||
      !/^[a-z_]+$/.test(purpose || "") ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day || "") ||
      !Number.isInteger(maxDaily) ||
      maxDaily < 1 ||
      !Number.isInteger(maxConcurrent) ||
      maxConcurrent < 1
    )
      throw new Error("invalid_callback_budget");
    const key = crypto.createHash("sha256").update(id).digest("hex");
    const bucketId = `budget_${purpose}`;
    const admitted = await run(async (tx) => {
      const [existing, old] = await Promise.all([
        tx.get(key),
        tx.get(bucketId),
      ]);
      if (existing) return false;
      const stamp = now();
      const bucket = old || { day, count: 0, leases: {} };
      const leases = Object.fromEntries(
        Object.entries(bucket.leases || {}).filter(
          ([, expiry]) => expiry > stamp,
        ),
      );
      const count = bucket.day === day ? bucket.count : 0;
      if (count >= maxDaily || Object.keys(leases).length >= maxConcurrent)
        return false;
      leases[key] = stamp + leaseMs;
      tx.set(key, {
        purpose,
        created_at: stamp,
        expire_at: new Date(stamp + 7 * 86400000),
      });
      tx.set(bucketId, { day, count: count + 1, leases });
      return true;
    });
    if (!admitted) return false;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await run(async (tx) => {
          const bucket = await tx.get(bucketId);
          if (!bucket) return;
          const leases = { ...bucket.leases };
          delete leases[key];
          tx.set(bucketId, { ...bucket, leases });
        });
      },
    };
  }
  Object.defineProperty(reserve, "durable", { value: !!db });
  return { reserve };
}
module.exports = { createCallbackLedger };
