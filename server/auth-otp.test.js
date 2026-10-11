/* auth.js POST /otp — a failed WhatsApp send is reported as such and does not
   count toward the resend spacing, so the agent can retry at once; a
   successful send still does. In-memory store, real router over HTTP. */
const assert = require("assert");
const express = require("express");
const createAuthRouter = require("./auth");

const PHONE = "0508505321";

async function withServer(sendWhatsApp, fn) {
  const mem = {};
  const app = express();
  app.use(express.json());
  app.use("/api/auth", createAuthRouter({ db: null, mem, sendWhatsApp, secret: "test-secret" }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  try { await fn(post, mem); } finally { server.close(); }
}

(async () => {
  const log = console.log, err = console.error;
  console.log = console.error = () => {};
  try {
    // ── send throws (timeout / network) → 502, retry allowed at once ──
    await withServer(async () => { throw new Error("The operation was aborted due to timeout"); }, async (post) => {
      for (let i = 0; i < 3; i++) {
        const r = await post("/api/auth/otp", { phone: PHONE });
        assert.equal(r.status, 502, `try ${i + 1}: ${JSON.stringify(r.data)}`);
        assert.equal(r.data.error, "whatsapp_send_failed");
      }
    });

    // ── Green API refuses (sendWhatsApp resolves false) → same ──
    await withServer(async () => false, async (post) => {
      assert.equal((await post("/api/auth/otp", { phone: PHONE })).data.error, "whatsapp_send_failed");
      assert.equal((await post("/api/auth/otp", { phone: PHONE })).data.error, "whatsapp_send_failed");
    });

    // ── fails, then succeeds: the delivered code logs in; resend spacing applies ──
    let fail = true, lastMsg = "";
    await withServer(async (_p, msg) => { if (fail) throw new Error("down"); lastMsg = msg; return true; }, async (post) => {
      assert.equal((await post("/api/auth/otp", { phone: PHONE })).status, 502);
      fail = false;
      const ok = await post("/api/auth/otp", { phone: PHONE });
      assert.equal(ok.status, 200);
      assert.equal(ok.data.sent, true);
      const again = await post("/api/auth/otp", { phone: PHONE });
      assert.equal(again.status, 429, "a delivered code still starts the resend wait");
      const code = lastMsg.match(/\d{6}/)[0];
      const v = await post("/api/auth/otp/verify", { phone: PHONE, code });
      assert.equal(v.status, 200, JSON.stringify(v.data));
      assert.ok(v.data.token);
    });

    // ── no creds (local dev: sendWhatsApp resolves undefined) still works ──
    await withServer(async () => undefined, async (post) => {
      assert.equal((await post("/api/auth/otp", { phone: PHONE })).status, 200);
    });
  } finally {
    console.log = log; console.error = err;
  }
  console.log("auth-otp.test.js: ok");
})().catch((e) => { console.error(e); process.exit(1); });
