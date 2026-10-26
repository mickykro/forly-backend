const test = require("node:test");
const assert = require("node:assert/strict");
const { createFirestoreStore } = require("./store");
const { createService } = require("./service");
const { createCallbackLedger } = require("./callback-ledger");
test(
  "Firestore emulator serializes capture, send confirmation and callback budgets",
  { skip: !process.env.FIRESTORE_EMULATOR_HOST },
  async (t) => {
    const admin = require("firebase-admin");
    const app = admin.initializeApp(
      { projectId: "demo-forly-outreach" },
      "outreach-emulator-" + Date.now(),
    );
    t.after(() => app.delete());
    const db = app.firestore();
    const store = createFirestoreStore(db);
    const service = createService({
      store,
      secret: "emulator-only-outreach-purpose-key",
      config: { enabled: true, policyApproved: true },
    });
    const actor = { id: "emulator-operator" };
    const input = {
      source_post_url: `https://facebook.com/groups/fixture/posts/${Date.now()}/`,
      campaign_id: "emulator",
    };
    const captures = await Promise.all(
      Array.from({ length: 8 }, () => service.createLead(input, actor)),
    );
    assert.equal(new Set(captures.map((l) => l.id)).size, 1);
    const lead = captures[0];
    await store.transaction(async (tx) => {
      const current = await tx.get("leads", lead.id);
      tx.set("leads", lead.id, {
        ...current,
        status: "demo_active",
        demo_id: lead.id,
      });
      tx.set("demos", lead.id, {
        id: lead.id,
        lead_id: lead.id,
        status: "active",
        expires_at: new Date(Date.now() + 60000).toISOString(),
      });
    });
    await service.approveDelivery(
      lead.id,
      {
        message: "Approved emulator fixture",
        channel: "manual",
        sender: "operator",
        recipient_identifier: lead.id,
        permitted_channel: true,
      },
      actor,
    );
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        service.confirmManualDelivery(
          lead.id,
          { evidence: "emulator confirmed", sent_at: new Date().toISOString() },
          actor,
        ),
      ),
    );
    assert(results.every((r) => r.status === "manual_sent_confirmed"));
    const ledger = createCallbackLedger({ db });
    const admissions = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        ledger.reserve({
          id: lead.id + index,
          purpose: "emulator",
          day: "2026-10-26",
          maxDaily: 2,
          maxConcurrent: 1,
        }),
      ),
    );
    assert.equal(admissions.filter(Boolean).length, 1);
    await admissions.find(Boolean).release();
    assert.equal(
      await ledger.reserve({
        id: lead.id + admissions.findIndex(Boolean),
        purpose: "emulator",
        day: "2026-10-26",
        maxDaily: 2,
        maxConcurrent: 1,
      }),
      false,
    );
  },
);
