/* green-bridge — the Whapi client, the Green-style method routes, and the
   Whapi → n8n inbound route, over real HTTP with fakes on both sides. */
const assert = require("assert");
const { createWhapiClient } = require("./whapi-client");

(async () => {
  // ── Whapi client: Bearer token, JSON body, errors carry the status ──
  {
    const calls = [];
    const fetchFn = async (url, o) => { calls.push({ url, o }); return { ok: true, status: 200, json: async () => ({ sent: true, message: { id: "M1" } }) }; };
    const c = createWhapiClient({ token: "wtok", fetchFn });
    assert.equal((await c.sendText("972501234567@s.whatsapp.net", "hi", "Q1")).message.id, "M1");
    assert.equal(calls[0].url, "https://gate.whapi.cloud/messages/text");
    assert.equal(calls[0].o.method, "POST");
    assert.equal(calls[0].o.headers.Authorization, "Bearer wtok");
    assert.deepEqual(JSON.parse(calls[0].o.body), { to: "972501234567@s.whatsapp.net", body: "hi", quoted: "Q1" });
    await c.sendMedia("document", "972501234567@s.whatsapp.net", "https://x/a.pdf", { caption: "c", filename: "a.pdf" });
    assert.equal(calls[1].url, "https://gate.whapi.cloud/messages/document");
    assert.deepEqual(JSON.parse(calls[1].o.body), { to: "972501234567@s.whatsapp.net", media: "https://x/a.pdf", caption: "c", filename: "a.pdf" });
    await c.sendMedia("image", "972501234567@s.whatsapp.net", "https://x/a.png", { filename: "a.png" });
    assert.deepEqual(JSON.parse(calls[2].o.body), { to: "972501234567@s.whatsapp.net", media: "https://x/a.png" }, "filename only for documents");
    await c.listMessages("972501234567@s.whatsapp.net", 100);
    assert.equal(calls[3].url, "https://gate.whapi.cloud/messages/list/972501234567%40s.whatsapp.net?count=100");
    assert.equal(calls[3].o.method, "GET");
    assert.equal(calls[3].o.body, undefined);
    await c.getMessage("M 1");
    assert.equal(calls[4].url, "https://gate.whapi.cloud/messages/M%201");
    const bad = createWhapiClient({ token: "t", fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
    await assert.rejects(bad.sendText("x@s.whatsapp.net", "y"), (e) => e.status === 401 && !e.message.includes("972"));
  }

  console.log("green-bridge/router.test.js: ok");
})().catch((e) => { console.error(e); process.exit(1); });
