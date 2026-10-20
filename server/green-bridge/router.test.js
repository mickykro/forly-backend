/* green-bridge — the Whapi client, the Green-style method routes, and the
   Whapi → n8n inbound route, over real HTTP with fakes on both sides. */
const assert = require("assert");
const { createWhapiClient } = require("./whapi-client");
const express = require("express");
const createGreenBridge = require("./router");

function fakeClient() {
  const calls = [];
  const rec = (name) => async (...a) => { calls.push([name, ...a]); return { sent: true, message: { id: `${name}-id` } }; };
  return {
    calls,
    sendText: rec("sendText"),
    sendMedia: rec("sendMedia"),
    listMessages: async (...a) => { calls.push(["listMessages", ...a]); return { messages: [
      { id: "A", from_me: false, type: "image", image: { link: "https://w/1.jpg" }, chat_id: "972501234567@s.whatsapp.net", timestamp: 9 },
    ] }; },
    getMessage: async (...a) => { calls.push(["getMessage", ...a]); return { id: "A", from_me: false, type: "text", text: { body: "x" }, chat_id: "972501234567@s.whatsapp.net", timestamp: 9 }; },
    listChats: async (...a) => { calls.push(["listChats", ...a]); return { chats: [
      { id: "972501234567@s.whatsapp.net", name: "Dana", type: "contact", timestamp: 9 },
      { id: "120363410405308894@g.us", name: "Forly log", type: "group", timestamp: 8 },
    ] }; },
  };
}

async function serve(router) {
  const app = express();
  app.use(express.json());
  app.use("/greenapi", router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/greenapi`;
  const post = async (path, body) => {
    const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  return { post, base, close: () => server.close() };
}

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
    await c.listChats(200);
    assert.equal(calls[5].url, "https://gate.whapi.cloud/chats?count=200");
    assert.equal(calls[5].o.method, "GET");
    const bad = createWhapiClient({ token: "t", fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
    await assert.rejects(bad.sendText("x@s.whatsapp.net", "y"), (e) => e.status === 401 && !e.message.includes("972"));
  }

  // ── Green-style calls → Whapi ──
  {
    const realErr = console.error; console.error = () => {};
    const client = fakeClient();
    const env = { GREENAPI_TOKEN: "gtok", WHATSAPP_PROVIDER_TOKEN: "wtok" };
    const { post, base, close } = await serve(createGreenBridge({ env, client }));
    const P = "/waInstance7105422200";
    try {
      // wrong or missing token → refused, nothing sent
      assert.equal((await post(`${P}/sendMessage/nope`, { chatId: "972501234567@c.us", message: "x" })).status, 401);
      assert.equal(client.calls.length, 0);

      let r = await post(`${P}/sendMessage/gtok`, { chatId: "972501234567@c.us", message: "קוד: 123456", quotedMessageId: "" });
      assert.equal(r.status, 200);
      assert.deepEqual(r.data, { idMessage: "sendText-id" });
      assert.deepEqual(client.calls.at(-1), ["sendText", "972501234567@s.whatsapp.net", "קוד: 123456", undefined]);

      assert.equal((await post(`${P}/sendMessage/gtok`, { chatId: "", message: "x" })).status, 400);

      r = await post(`${P}/sendFileByUrl/gtok`, { chatId: "972501234567@c.us", fileName: "slide-01.png", urlFile: "https://x/s.png", quotedMessageId: "Q" });
      assert.equal(r.status, 200);
      assert.deepEqual(client.calls.at(-1), ["sendMedia", "image", "972501234567@s.whatsapp.net", "https://x/s.png", { caption: undefined, filename: "slide-01.png", quoted: "Q" }]);
      await post(`${P}/sendFileByUrl/gtok`, { chatId: "972501234567@c.us", fileName: "video.mp4", urlFile: "https://x/v.mp4", asDocument: true });
      assert.equal(client.calls.at(-1)[1], "document", "asDocument forces a document");

      r = await post(`${P}/sendInteractiveButtons/gtok`, { chatId: "972501234567@c.us", header: "", body: "מוכן", footer: "",
        buttons: [{ type: "url", buttonId: "1", buttonText: "לדף", url: "https://x/p" }] });
      assert.equal(r.status, 200);
      assert.deepEqual(client.calls.at(-1), ["sendText", "972501234567@s.whatsapp.net", "מוכן\n\nלדף: https://x/p", undefined]);

      r = await post(`${P}/getChatHistory/gtok`, { chatId: "972501234567@c.us" });
      assert.equal(r.status, 200);
      assert.deepEqual(client.calls.at(-1), ["listMessages", "972501234567@s.whatsapp.net", 100]);
      assert.equal(r.data[0].type, "incoming");
      assert.equal(r.data[0].typeMessage, "imageMessage");
      assert.equal(r.data[0].downloadUrl, "https://w/1.jpg");

      r = await post(`${P}/getMessage/gtok`, { chatId: "972501234567@c.us", idMessage: "A" });
      assert.equal(r.status, 200);
      assert.equal(r.data.textMessage, "x");
      assert.deepEqual(client.calls.at(-1), ["getMessage", "A"]);

      // getChats: Green's list shape; the daily review calls it with GET and no body
      r = await post(`${P}/getChats/gtok`, {});
      assert.equal(r.status, 200);
      assert.deepEqual(client.calls.at(-1), ["listChats", 500]);
      assert.deepEqual(r.data, [
        { id: "972501234567@c.us", name: "Dana", type: "user" },
        { id: "120363410405308894@g.us", name: "Forly log", type: "group" },
      ]);
      const g = await fetch(`${base}${P}/getChats/gtok`);
      assert.equal(g.status, 200);
      assert.equal((await g.json()).length, 2);
      assert.equal((await fetch(`${base}${P}/getChats/nope`)).status, 401);
      assert.equal((await fetch(`${base}${P}/sendMessage/gtok`)).status, 404, "GET only for getChats");

      assert.equal((await post(`${P}/setSettings/gtok`, {})).status, 501);

      // Whapi refusing → Green-style error status, not a crash
      client.sendText = async () => { const e = new Error("Whapi messages/text → 400"); e.status = 400; throw e; };
      assert.equal((await post(`${P}/sendMessage/gtok`, { chatId: "972501234567@c.us", message: "x" })).status, 400);
      client.sendText = async () => { throw new Error("timeout"); };
      assert.equal((await post(`${P}/sendMessage/gtok`, { chatId: "972501234567@c.us", message: "x" })).status, 502);
    } finally { close(); console.error = realErr; }

    // bridge off (no WHATSAPP_PROVIDER_TOKEN, no client) → 503
    const off = await serve(createGreenBridge({ env: { GREENAPI_TOKEN: "gtok" } }));
    try { assert.equal((await off.post(`${P}/sendMessage/gtok`, { chatId: "972501234567@c.us", message: "x" })).status, 503); }
    finally { off.close(); }
  }

  // ── Whapi webhook → Green-format webhooks posted to n8n, in order ──
  {
    const realErr = console.error; console.error = () => {};
    const forwarded = [];
    const fetchFn = async (url, o) => { forwarded.push({ url, body: JSON.parse(o.body) }); return { ok: true, status: 200 }; };
    const env = { GREENAPI_TOKEN: "gtok", WHATSAPP_WEBHOOK_SECRET: "hook-secret", GREENAPI_INSTANCE: "7105422200",
      WHATSAPP_INBOUND_N8N_WEBHOOK: "https://n8n.test/webhook/avisa-reply-v2" };
    const bridge = createGreenBridge({ env, fetchFn, client: fakeClient() });
    const { post, close } = await serve(bridge);
    try {
      assert.equal((await post("/inbound/wrong", { messages: [] })).status, 401);
      const r = await post("/inbound/hook-secret", { messages: [
        { id: "W1", from_me: false, type: "text", text: { body: "ראשון" }, chat_id: "972501234567@s.whatsapp.net", from: "972501234567", timestamp: 1 },
        { id: "W2", from_me: true, type: "text", text: { body: "ours" }, chat_id: "972501234567@s.whatsapp.net", timestamp: 2 },
        { id: "W3", from_me: false, type: "image", image: { link: "https://w/1.jpg" }, chat_id: "972501234567@s.whatsapp.net", from: "972501234567", timestamp: 3 },
      ], event: { type: "messages", event: "post" } });
      assert.equal(r.status, 200);
      assert.deepEqual(r.data, { ok: true, received: 3 });
      await bridge.idle();
      assert.deepEqual(forwarded.map((f) => f.body.idMessage), ["W1", "W3"], "own sends dropped, order kept");
      assert.equal(forwarded[0].url, "https://n8n.test/webhook/avisa-reply-v2");
      assert.equal(forwarded[0].body.typeWebhook, "incomingMessageReceived");
      assert.equal(forwarded[0].body.instanceData.idInstance, 7105422200);
      assert.equal(forwarded[1].body.messageData.fileMessageData.downloadUrl, "https://w/1.jpg");

      // n8n down → still 200 to Whapi (no retry, no double handling), error logged
      const failing = createGreenBridge({ env, fetchFn: async () => { throw new Error("ECONNREFUSED"); }, client: fakeClient() });
      const s2 = await serve(failing);
      try {
        assert.equal((await s2.post("/inbound/hook-secret", { messages: [
          { id: "W9", from_me: false, type: "text", text: { body: "x" }, chat_id: "972501234567@s.whatsapp.net", timestamp: 1 }] })).status, 200);
        await failing.idle();
      } finally { s2.close(); }

      // no target configured → 503
      const noTarget = await serve(createGreenBridge({ env: { ...env, WHATSAPP_INBOUND_N8N_WEBHOOK: "" }, fetchFn, client: fakeClient() }));
      try { assert.equal((await noTarget.post("/inbound/hook-secret", { messages: [] })).status, 503); }
      finally { noTarget.close(); }
    } finally { close(); console.error = realErr; }
  }

  console.log("green-bridge/router.test.js: ok");
})().catch((e) => { console.error(e); process.exit(1); });
