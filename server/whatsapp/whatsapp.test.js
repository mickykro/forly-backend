/* whatsapp/ — WHATSAPP_PROVIDER picks the adapter; each adapter speaks its
   provider's wire format and hands back the neutral Message. Fake fetch. */
const assert = require("assert");
const W = require("./index");

const KEYS = ["WHATSAPP_PROVIDER", "GREENAPI_INSTANCE", "GREENAPI_TOKEN", "GREENAPI_API_URL", "WHAPI_TOKEN", "WHAPI_API_URL"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const realFetch = global.fetch, realLog = console.log, realErr = console.error;
const calls = [];
let reply = () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });

function env(vars) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
}

(async () => {
  global.fetch = async (url, o = {}) => { calls.push({ url, method: o.method, headers: o.headers || {}, body: o.body ? JSON.parse(o.body) : null }); return reply(url); };
  console.log = () => {}; console.error = () => {};
  try {
    // ── nothing configured → WhatsApp off, nothing sent ──
    env({});
    assert.equal(W.whatsappEnabled(), false);
    assert.equal(await W.sendWhatsApp("972500000001", "x"), undefined);
    assert.deepEqual(await W.getWhatsAppHistory("972500000001", 5), []);
    assert.equal(calls.length, 0);

    // ── unknown provider is a loud error, not a silent no-op ──
    env({ WHATSAPP_PROVIDER: "nope" });
    assert.throws(() => W.whatsappEnabled(), /WHATSAPP_PROVIDER "nope"/);

    // ── Green API: the instance's own host, @c.us ──
    env({ GREENAPI_INSTANCE: "7105422200", GREENAPI_TOKEN: "gtok" });
    assert.equal(W.providerName(), "greenapi", "default provider");
    assert.equal(await W.sendWhatsApp("972500000001", "hi"), true);
    assert.equal(calls[0].url, "https://7105.api.greenapi.com/waInstance7105422200/sendMessage/gtok");
    assert.deepEqual(calls[0].body, { chatId: "972500000001@c.us", message: "hi" });
    reply = () => ({ ok: false, status: 466, text: async () => "quota" });
    assert.equal(await W.sendWhatsApp("972500000001", "hi"), false, "a refusal is reported");
    reply = (url) => ({ ok: true, json: async () => (url.includes("getChatHistory") ? [
      { idMessage: "A", type: "outgoing", typeMessage: "extendedTextMessage", extendedTextMessage: { text: "hello" }, timestamp: 10 },
      { idMessage: "B", type: "incoming", typeMessage: "imageMessage", downloadUrl: "https://g/1.jpg", caption: "c", timestamp: 9 },
    ] : { idMessage: "B", type: "incoming", typeMessage: "imageMessage", downloadUrl: "https://g/1.jpg", timestamp: 9 }) });
    assert.deepEqual(await W.getWhatsAppHistory("972500000001", 30), [
      { id: "A", fromMe: true, type: "text", text: "hello", mediaUrl: null, timestamp: 10 },
      { id: "B", fromMe: false, type: "image", text: "c", mediaUrl: "https://g/1.jpg", timestamp: 9 },
    ]);
    assert.equal((await W.getWhatsAppMessage("972500000001", "B")).mediaUrl, "https://g/1.jpg");
    assert.deepEqual(calls.at(-1).body, { chatId: "972500000001@c.us", idMessage: "B" });

    // ── Whapi: gate.whapi.cloud, Bearer token, @s.whatsapp.net ──
    calls.length = 0;
    reply = () => ({ ok: true, status: 200, json: async () => ({ sent: true }), text: async () => "" });
    env({ WHATSAPP_PROVIDER: "whapi", WHAPI_TOKEN: "wtok", GREENAPI_INSTANCE: "7105422200", GREENAPI_TOKEN: "gtok" });
    assert.equal(await W.sendWhatsApp("972500000001", "hi"), true);
    assert.equal(calls[0].url, "https://gate.whapi.cloud/messages/text");
    assert.equal(calls[0].headers.Authorization, "Bearer wtok");
    assert.deepEqual(calls[0].body, { to: "972500000001@s.whatsapp.net", body: "hi" });

    // link buttons → text with the links spelled out (Whapi documents quick replies only)
    calls.length = 0;
    const links = { header: "h", body: "b", footer: "f", buttons: [{ type: "url", buttonText: "open", url: "https://x.test/a?t=1" }] };
    await W.sendWhatsAppRich("972500000001", links);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://gate.whapi.cloud/messages/text");
    assert.equal(calls[0].body.body, W.textOfButtons(links));
    // quick replies → interactive
    calls.length = 0;
    await W.sendWhatsAppButtons("972500000001", { body: "b", buttons: [{ buttonText: "yes", buttonId: "y" }] });
    assert.equal(calls[0].url, "https://gate.whapi.cloud/messages/interactive");
    assert.deepEqual(calls[0].body, { to: "972500000001@s.whatsapp.net", type: "button", body: { text: "b" },
      action: { buttons: [{ type: "quick_reply", title: "yes", id: "y" }] } });
    // a refused interactive send falls back to text
    calls.length = 0;
    reply = (url) => (url.endsWith("/interactive") ? { ok: false, status: 400 } : { ok: true, text: async () => "" });
    await W.sendWhatsAppRich("972500000001", { body: "b", buttons: [{ buttonText: "yes" }] });
    assert.deepEqual(calls.map((c) => c.url.split("/").pop()), ["interactive", "text"]);

    // history and one message → neutral Message
    reply = (url) => ({ ok: true, json: async () => (url.includes("/messages/list/") ? { messages: [
      { id: "m1", from_me: true, type: "text", text: { body: "hello" }, timestamp: 10 },
      { id: "m2", from_me: false, type: "image", image: { link: "https://w/1.jpg", caption: "c" }, timestamp: 9 },
      { id: "m3", from_me: false, type: "image", image: { id: "x" }, timestamp: 8 },
    ] } : { id: "m2", from_me: false, type: "image", image: { link: "https://w/1.jpg" }, timestamp: 9 }) });
    assert.deepEqual(await W.getWhatsAppHistory("972500000001", 30), [
      { id: "m1", fromMe: true, type: "text", text: "hello", mediaUrl: null, timestamp: 10 },
      { id: "m2", fromMe: false, type: "image", text: "c", mediaUrl: "https://w/1.jpg", timestamp: 9 },
      { id: "m3", fromMe: false, type: "image", text: "", mediaUrl: null, timestamp: 8 },
    ]);
    assert.equal(calls.at(-1).url, "https://gate.whapi.cloud/messages/list/972500000001%40s.whatsapp.net?count=30");
    assert.equal((await W.getWhatsAppMessage("972500000001", "m2")).mediaUrl, "https://w/1.jpg");
    assert.equal(calls.at(-1).url, "https://gate.whapi.cloud/messages/m2");
    assert.equal(calls.at(-1).method, "GET");

    // Whapi selected but no token → off, even with Green API creds set
    env({ WHATSAPP_PROVIDER: "whapi", GREENAPI_INSTANCE: "7105422200", GREENAPI_TOKEN: "gtok" });
    assert.equal(W.whatsappEnabled(), false);
  } finally {
    global.fetch = realFetch; console.log = realLog; console.error = realErr;
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  console.log("whatsapp/whatsapp.test.js: ok");
})().catch((e) => { console.error(e); process.exit(1); });
