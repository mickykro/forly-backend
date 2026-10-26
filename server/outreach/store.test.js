const test = require("node:test");
const assert = require("node:assert/strict");
const { createFirestoreStore } = require("./store");
test("Firestore transaction adapter maps isolated collections and persists atomic writes", async () => {
  const rows = new Map();
  const calls = [];
  const db = {
    collection(c) {
      return {
        doc(id) {
          return { key: c + "/" + id };
        },
      };
    },
    async runTransaction(fn) {
      let written = false;
      const pending = [];
      const result = await fn({
        async get(ref) {
          assert.equal(written, false, "all Firestore reads precede writes");
          calls.push(ref.key);
          return { exists: rows.has(ref.key), data: () => rows.get(ref.key) };
        },
        set(ref, row) {
          written = true;
          pending.push(() => rows.set(ref.key, row));
        },
        delete(ref) {
          written = true;
          pending.push(() => rows.delete(ref.key));
        },
      });
      pending.forEach((fn) => fn());
      return result;
    },
  };
  const store = createFirestoreStore(db);
  await store.transaction(async (tx) => {
    assert.equal(await tx.get("leads", "a"), null);
    tx.set("leads", "a", { id: "a", omit: undefined });
  });
  assert.deepEqual(rows.get("outreach_leads/a"), { id: "a" });
  await assert.rejects(
    store.transaction(async (tx) => {
      tx.set("leads", "b", { id: "b" });
      throw Error("fail");
    }),
  );
  assert.equal(rows.has("outreach_leads/b"), false);
  assert.deepEqual(calls, ["outreach_leads/a"]);
});
