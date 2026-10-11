/* routes/whatsapp-gateway.js — n8n's provider-neutral send / history door:
   n8n secret required, inputs validated, Green-style calls made at
   greenApiBase (the bridge today), history handed back as { messages }. */
const assert = require("assert");
const express = require("express");
const createWhatsappGateway = require("./whatsapp-gateway");

async function serve(router) {
  const app = express();
  app.use(express.json());
  app.use("/api/whatsapp", router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/whatsapp`;
  const post = async (path, body, secret = "n8n", extra = {}) => {
    const r = await fetch(base + path, { method: "POST",
      headers: { "Content-Type": "application/json", ...(secret ? { "x-forly-secret": secret } : {}), ...extra },
      body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  return { post, close: () => server.close() };
}

(async () => {
  const calls = [];
  let reply = () => ({ ok: true, status: 200, json: async () => ({ idMessage: "ID1" }) });
  const fetchFn = async (url, o) => { calls.push({ url, body: JSON.parse(o.body) }); return reply(url); };
  const env = { GREENAPI_INSTANCE: "7105422200", GREENAPI_TOKEN: "gtok", GREENAPI_API_URL: "http://127.0.0.1:8787/greenapi" };
  const realErr = console.error; console.error = () => {};
  const { post, close } = await serve(createWhatsappGateway({ n8nSecret: "n8n", env, fetchFn, trustInternal: false }));
  const G = "http://127.0.0.1:8787/greenapi/waInstance7105422200";
  try {
    // ── n8n secret ──
    assert.equal((await post("/send", { to: "972501234567", text: "x" }, "")).status, 403);
    assert.equal((await post("/send", { to: "972501234567", text: "x" }, "wrong")).status, 403);
    assert.equal(calls.length, 0);

    // ── text: phone, @c.us or 05… all reach the same chat ──
    let r = await post("/send", { to: "972501234567", text: "שלום" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { ok: true, id: "ID1", idMessage: "ID1" });
    assert.equal(calls.at(-1).url, `${G}/sendMessage/gtok`);
    assert.deepEqual(calls.at(-1).body, { chatId: "972501234567@c.us", message: "שלום" });
    await post("/send", { to: "972501234567@c.us", text: "a", quoted_id: "Q1" });
    assert.deepEqual(calls.at(-1).body, { chatId: "972501234567@c.us", message: "a", quotedMessageId: "Q1" });
    await post("/send", { to: "120363410405308894@g.us", text: "log" });
    assert.equal(calls.at(-1).body.chatId, "120363410405308894@g.us", "groups keep @g.us");

    // ── file ──
    await post("/send", { to: "972501234567", file_url: "https://x/v.mp4", file_name: "walk.mp4", caption: "סיור" });
    assert.equal(calls.at(-1).url, `${G}/sendFileByUrl/gtok`);
    assert.deepEqual(calls.at(-1).body, { chatId: "972501234567@c.us", urlFile: "https://x/v.mp4", fileName: "walk.mp4", caption: "סיור" });

    // ── buttons ──
    await post("/send", { to: "972501234567", text: "מוכן", footer: "Forly", buttons: [{ type: "url", buttonText: "לדף", url: "https://x/p" }] });
    assert.equal(calls.at(-1).url, `${G}/sendInteractiveButtons/gtok`);
    assert.deepEqual(calls.at(-1).body, { chatId: "972501234567@c.us", header: "", body: "מוכן", footer: "Forly",
      buttons: [{ type: "url", buttonText: "לדף", url: "https://x/p", buttonId: "1" }] });

    // buttons as a JSON string (what an n8n keypair body sends)
    await post("/send", { to: "972501234567", text: "נגמר", buttons: JSON.stringify([{ type: "call", buttonText: "צור קשר", phoneNumber: "972548018957" }]) });
    assert.deepEqual(calls.at(-1).body.buttons, [{ type: "call", buttonText: "צור קשר", phoneNumber: "972548018957", buttonId: "1" }]);
    assert.equal((await post("/send", { to: "972501234567", text: "x", buttons: "[oops" })).status, 400);

    // ── validation ──
    assert.equal((await post("/send", { to: "", text: "x" })).status, 400);
    assert.equal((await post("/send", { to: "972501234567" })).status, 400, "nothing to send");
    assert.equal((await post("/send", { to: "972501234567", file_url: "javascript:alert(1)" })).status, 400);

    // ── history → { messages } in the Green shape the code nodes already read ──
    reply = () => ({ ok: true, status: 200, json: async () => ([{ type: "incoming", typeMessage: "textMessage", textMessage: "hi", idMessage: "A", timestamp: 1 }]) });
    r = await post("/history", { to: "972501234567", count: 30 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { ok: true, messages: [{ type: "incoming", typeMessage: "textMessage", textMessage: "hi", idMessage: "A", timestamp: 1 }] });
    assert.equal(calls.at(-1).url, `${G}/getChatHistory/gtok`);
    assert.deepEqual(calls.at(-1).body, { chatId: "972501234567@c.us", count: 30 });

    // ── provider refusing → 502 with no detail leaked; not configured → 503 ──
    reply = () => ({ ok: false, status: 500, json: async () => ({}) });
    assert.equal((await post("/send", { to: "972501234567", text: "x" })).status, 502);
  } finally { close(); }

  const off = await serve(createWhatsappGateway({ n8nSecret: "n8n", env: {}, fetchFn, trustInternal: false }));
  try { assert.equal((await off.post("/send", { to: "972501234567", text: "x" })).status, 503); }
  finally { off.close(); console.error = realErr; }

  // ── internal network: a direct container-to-container call needs no secret;
  //    anything carrying proxy headers (i.e. through Traefik) still does ──
  {
    const inner = await serve(createWhatsappGateway({ n8nSecret: "n8n", env, fetchFn, trustInternal: true }));
    try {
      reply = () => ({ ok: true, status: 200, json: async () => ({ idMessage: "ID2" }) });
      assert.equal((await inner.post("/send", { to: "972501234567", text: "x" }, "")).status, 200, "127.0.0.1, no proxy headers");
      assert.equal((await inner.post("/send", { to: "972501234567", text: "x" }, "", { "x-forwarded-for": "203.0.113.9" })).status, 403,
        "through the proxy, no secret → refused");
      assert.equal((await inner.post("/send", { to: "972501234567", text: "x" }, "n8n", { "x-forwarded-for": "203.0.113.9" })).status, 200,
        "through the proxy with the secret → allowed");
    } finally { inner.close(); }
  }

  console.log("routes/whatsapp-gateway.test.js: ok");
})().catch((e) => { console.error(e); process.exit(1); });
