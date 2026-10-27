const test = require("node:test");
const assert = require("node:assert/strict");
const { createFirestoreStore } = require("./store");

test(
  "Firestore emulator commits outreach atomically and serializes conflicting approval writes",
  {
    skip:
      !process.env.FIRESTORE_EMULATOR_HOST &&
      "FIRESTORE_EMULATOR_HOST is not configured",
  },
  async () => {
    const admin = require("firebase-admin");
    const app = admin.initializeApp(
      { projectId: "demo-forly-outreach-test" },
      "outreach-" + Date.now(),
    );
    const db = app.firestore();
    const store = createFirestoreStore(db);
    const id = "emulator-" + require("crypto").randomUUID();
    try {
      await store.transaction(async (tx) => {
        tx.set("leads", id, { id, approvals: 0 });
      });
      await Promise.all(
        [1, 2].map(() =>
          store.transaction(async (tx) => {
            const lead = await tx.get("leads", id);
            tx.set("leads", id, { ...lead, approvals: lead.approvals + 1 });
          }),
        ),
      );
      assert.equal((await store.get("leads", id)).approvals, 2);
      await assert.rejects(
        store.transaction(async (tx) => {
          tx.set("leads", id, { id, approvals: 99 });
          throw new Error("intentional abort");
        }),
        /intentional abort/,
      );
      assert.equal((await store.get("leads", id)).approvals, 2);
    } finally {
      await db.collection("outreach_leads").doc(id).delete();
      await app.delete();
    }
  },
);
