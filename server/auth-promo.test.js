/* auth.js promo login: purpose "reel" lets a non-client get a code, and verify gives
   them a promo-only token (no dashboard, no step-up); a client still gets a session. */
const assert = require("assert");
const express = require("express");
const createAuthRouter = require("./auth");
const { verifySession, PROMO_SCOPES, UPLOAD_SCOPES } = require("./auth");

// Minimal Firestore stand-in: collection(c).doc(id).get()/set(v, {merge}).
function fakeDb(businesses) {
  const cols = { businesses: new Map(Object.entries(businesses)) };
  return { collection: (c) => {
    const m = cols[c] || (cols[c] = new Map());
    return { doc: (id) => ({
      get: async () => ({ exists: m.has(id), data: () => m.get(id) }),
      set: async (v, o) => { m.set(id, o && o.merge ? { ...(m.get(id) || {}), ...v } : v); },
    }) };
  } };
}

const log = console.log;
(async () => {
  console.log = console.error = () => {};
  let lastMsg = "";
  const leads = [];
  const app = express();
  app.use(express.json());
  app.use("/api/auth", createAuthRouter({ db: fakeDb({ "972501111111": { full_name: "Client" } }), mem: {},
    sendWhatsApp: async (to, msg) => { if (to === "972599999999") leads.push(msg); else lastMsg = msg; return true; },
    secret: "s", salesLeadPhone: "972599999999" }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/auth`;
  const post = async (path, body) => {
    const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json(), cookies: r.headers.getSetCookie() };
  };
  try {
    // not a client, normal login → refused (unchanged)
    assert.equal((await post("/otp", { phone: "0502222222" })).data.error, "not_a_client");
    const leadsBefore = leads.length;

    // not a client, /reel → code; verify → promo token only
    assert.equal((await post("/otp", { phone: "0503333333", purpose: "reel" })).status, 200);
    assert.equal(leads.length, leadsBefore, "no sales-lead notice for a /reel visitor");
    const v = await post("/otp/verify", { phone: "0503333333", code: lastMsg.match(/\d{6}/)[0] });
    assert.equal(v.status, 200, JSON.stringify(v.data));
    assert.equal(v.data.scope, "promo");
    assert.equal(verifySession("s", v.data.token), null, "a promo token is not a dashboard session");
    assert.equal(verifySession("s", v.data.token, PROMO_SCOPES).userId, "972503333333");
    assert.ok(verifySession("s", v.data.token, UPLOAD_SCOPES), "a promo token may upload photos");
    assert.ok(!v.cookies.some((c) => c.startsWith("forly_stepup=")), "no step-up for promo");

    // a client using /reel → normal full session
    await post("/otp", { phone: "0501111111", purpose: "reel" });
    const c = await post("/otp/verify", { phone: "0501111111", code: lastMsg.match(/\d{6}/)[0] });
    assert.ok(verifySession("s", c.data.token), "client gets a real session");
  } finally { server.close(); }
  log("auth-promo.test.js OK");
})().catch((e) => { log(e); process.exit(1); });
