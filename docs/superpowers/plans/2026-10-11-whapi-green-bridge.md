# Whapi ⇄ Green API Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get WhatsApp working again today on the same number through Whapi.Cloud. No n8n workflow changes: the Forly server impersonates Green API.

**Architecture:** A new Express router mounted at `/greenapi` on the Forly server.
- **Outgoing:** it answers Green-API-shaped calls (`/waInstance{id}/{method}/{token}`) by calling Whapi. n8n's Green API node is patched to call it, and the server and Functions use it through the existing `GREENAPI_API_URL` override.
- **Incoming:** it receives Whapi's webhook, rebuilds each message as a Green API `incomingMessageReceived` webhook, and posts it to the n8n webhook Green API used to call.

This is a stopgap until the planned move to Meta's official API, after which it is deleted.

**Tech Stack:** Node 18+ (global `fetch`, `AbortSignal.timeout`), Express 4, CommonJS, plain `assert` test scripts run with `node`.

## Global Constraints

- **Base branch:** `hotfix/whapi-green-bridge`, cut from `hotfix/greenapi-instance-host`. That branch already has the `GREENAPI_API_URL` override in `server/utils.js` and `functions/src/shared.ts`, plus the login lockout fix.
- **No new npm dependencies.**
- **No n8n workflow edits.** Only the installed Green API node's host string is patched (Task 6).
- **Never log a token, a full phone number or a full chat id.** Log only the last 4 digits.
- **Every file under 500 lines.**
- **Tests are plain `node file.test.js` scripts** using `assert`, registered in `server/package.json` `scripts.test`.
- **Chat ids:** Green `972XXXXXXXXX@c.us` ⇄ Whapi `972XXXXXXXXX@s.whatsapp.net`. Groups stay `…@g.us`.
- **Green-side auth:** the bridge accepts only the existing `GREENAPI_TOKEN` (the same token that n8n's Green API credential, the server and Functions already hold).
- **Whapi side:** `WHAPI_TOKEN`, base `https://gate.whapi.cloud`, `Authorization: Bearer <token>`.
- **Inbound webhook auth:** a secret in the URL path, `WHAPI_WEBHOOK_SECRET`.
- **Inbound responses are always 200** after the secret check, so Whapi never retries and causes a message to be handled twice.

Fields the live n8n workflows read. The bridge must produce exactly these, taken from Main Router v3 "Code - Parse Webhook" and Business Handler v6:
- `typeWebhook` (filtered on `"incomingMessageReceived"`), `timestamp`, `idMessage`
- `senderData.chatId`, `senderData.senderName`
- `messageData.typeMessage`
- `messageData.textMessageData.textMessage`
- `messageData.extendedTextMessageData.text`, `.stanzaId`
- `messageData.fileMessageData.downloadUrl`, `.caption`
- `messageData.quotedMessage.stanzaId`, `.typeMessage`, `.downloadUrl`
- `messageData.buttonsResponseMessage.selectedButtonText`
- Chat-history items: `type` (`incoming`/`outgoing`), `typeMessage`, `textMessage`, `idMessage`, `timestamp`, `downloadUrl`

Green API calls the n8n node makes (from `n8n-nodes-greenapi@0.1.8`), all `POST`, JSON:
- `sendMessage` `{chatId, message, quotedMessageId}`
- `sendFileByUrl` `{chatId, fileName, urlFile, quotedMessageId}`
- `sendInteractiveButtons` `{chatId, header, body, footer, quotedMessageId, buttons:[{type:"url"|"copy"|"call", buttonId, buttonText, url|copyCode|phoneNumber}]}`
- `getChatHistory` `{chatId}`
- `getMessage` `{chatId, idMessage}`

---

## File Structure

| File | Responsibility |
|---|---|
| `server/green-bridge/format.js` (create) | Pure mappers: chat ids, Whapi message → Green webhook, Whapi message → Green history item, buttons → text, file name → Whapi media kind |
| `server/green-bridge/format.test.js` (create) | Tests for `format.js` |
| `server/green-bridge/whapi-client.js` (create) | The minimal Whapi REST client (text, media, list, get) |
| `server/green-bridge/router.js` (create) | Express router: Green-style method routes and the Whapi inbound route |
| `server/green-bridge/router.test.js` (create) | The router over real HTTP, with a fake Whapi client and a fake n8n target |
| `server/index.js` (modify) | Mount the router at `/greenapi` |
| `server/package.json` (modify) | Register the two test files |

---

### Task 1: Chat ids and inbound webhook mapping

**Files:**
- Create: `server/green-bridge/format.js`
- Test: `server/green-bridge/format.test.js`

**Interfaces:**
- Produces:
  - `toWhapiChat(chatId: string) → string`
  - `toGreenChat(chatId: string) → string`
  - `greenType(whapiType: string) → string`
  - `toGreenWebhook(msg: WhapiMessage, opts: {idInstance, wid}) → GreenWebhook | null`

- [ ] **Step 1: Write the failing test**

Create `server/green-bridge/format.test.js`:

```js
/* green-bridge/format.js — Whapi messages rebuilt in the exact Green API
   shapes the live n8n workflows parse (Main Router v3, Business Handler v6). */
const assert = require("assert");
const F = require("./format");

// ── chat ids ──
assert.equal(F.toWhapiChat("972501234567@c.us"), "972501234567@s.whatsapp.net");
assert.equal(F.toWhapiChat("972501234567"), "972501234567@s.whatsapp.net");
assert.equal(F.toWhapiChat("120363410405308894@g.us"), "120363410405308894@g.us");
assert.equal(F.toWhapiChat(""), "");
assert.equal(F.toGreenChat("972501234567@s.whatsapp.net"), "972501234567@c.us");
assert.equal(F.toGreenChat("120363410405308894@g.us"), "120363410405308894@g.us");
assert.equal(F.greenType("voice"), "audioMessage");
assert.equal(F.greenType("text"), "textMessage");
assert.equal(F.greenType("poll"), "unknown");

const opts = { idInstance: "7105422200", wid: "972500000000@c.us" };
const base = { id: "W1", from_me: false, chat_id: "972501234567@s.whatsapp.net", from: "972501234567", from_name: "Dana", timestamp: 1760000000 };

// ── plain text → textMessage ──
{
  const h = F.toGreenWebhook({ ...base, type: "text", text: { body: "שלום" } }, opts);
  assert.equal(h.typeWebhook, "incomingMessageReceived");
  assert.equal(h.idMessage, "W1");
  assert.equal(h.timestamp, 1760000000);
  assert.deepEqual(h.instanceData, { idInstance: 7105422200, wid: "972500000000@c.us", typeInstance: "whatsapp" });
  assert.equal(h.senderData.chatId, "972501234567@c.us");
  assert.equal(h.senderData.sender, "972501234567@c.us");
  assert.equal(h.senderData.senderName, "Dana");
  assert.deepEqual(h.messageData, { typeMessage: "textMessage", textMessageData: { textMessage: "שלום" } });
}

// ── text quoting a photo → quotedMessage (Business Handler v6 edit-a-photo path) ──
{
  const h = F.toGreenWebhook({ ...base, type: "text", text: { body: "תשפר" },
    context: { quoted_id: "Q9", quoted_type: "image", quoted_author: "972500000000@s.whatsapp.net",
      quoted_content: { image: { link: "https://w/q.jpg", caption: "c" } } } }, opts);
  assert.equal(h.messageData.typeMessage, "quotedMessage");
  assert.deepEqual(h.messageData.extendedTextMessageData, { text: "תשפר", stanzaId: "Q9", participant: "972500000000@c.us" });
  assert.equal(h.messageData.quotedMessage.stanzaId, "Q9");
  assert.equal(h.messageData.quotedMessage.typeMessage, "imageMessage");
  assert.equal(h.messageData.quotedMessage.downloadUrl, "https://w/q.jpg");
}

// ── photo → imageMessage with fileMessageData ──
{
  const h = F.toGreenWebhook({ ...base, type: "image", image: { link: "https://w/1.jpg", caption: "סלון", mime_type: "image/jpeg" } }, opts);
  assert.equal(h.messageData.typeMessage, "imageMessage");
  assert.deepEqual(h.messageData.fileMessageData, { downloadUrl: "https://w/1.jpg", caption: "סלון", fileName: "", mimeType: "image/jpeg" });
}

// ── voice note → audioMessage (transcription path) ──
{
  const h = F.toGreenWebhook({ ...base, type: "voice", voice: { link: "https://w/v.ogg", mime_type: "audio/ogg" } }, opts);
  assert.equal(h.messageData.typeMessage, "audioMessage");
  assert.equal(h.messageData.fileMessageData.downloadUrl, "https://w/v.ogg");
}

// ── button tap → buttonsResponseMessage ──
{
  const h = F.toGreenWebhook({ ...base, type: "reply", reply: { type: "buttons_reply", buttons_reply: { id: "b1", title: "כן" } },
    context: { quoted_id: "Q1", quoted_type: "interactive" } }, opts);
  assert.deepEqual(h.messageData, { typeMessage: "buttonsResponseMessage",
    buttonsResponseMessage: { stanzaId: "Q1", selectedButtonId: "b1", selectedButtonText: "כן" } });
}

// ── never forwarded: our own sends, unsupported types, missing chat ──
assert.equal(F.toGreenWebhook({ ...base, from_me: true, type: "text", text: { body: "x" } }, opts), null);
assert.equal(F.toGreenWebhook({ ...base, type: "poll", poll: {} }, opts), null);
assert.equal(F.toGreenWebhook({ ...base, chat_id: "", type: "text", text: { body: "x" } }, opts), null);
assert.equal(F.toGreenWebhook(null, opts), null);

console.log("green-bridge/format.test.js: ok");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node green-bridge/format.test.js`
Expected: FAIL with `Cannot find module './format'`

- [ ] **Step 3: Write the minimal implementation**

Create `server/green-bridge/format.js`:

```js
/*
 * Green API ⇄ Whapi formats for the stopgap bridge (green-bridge/router.js).
 * n8n's Green API node and workflows stay unchanged: Whapi's messages are
 * rebuilt in the exact Green API webhook / history shapes they parse.
 * Pure functions, no I/O.
 */

const digitsOf = (chatId) => String(chatId || "").trim().replace(/@.*$/, "").replace(/\D/g, "");

// 972…@c.us (Green) ⇄ 972…@s.whatsapp.net (Whapi); groups keep @g.us.
function toWhapiChat(chatId) {
  const s = String(chatId || "").trim();
  if (s.endsWith("@g.us")) return s;
  const d = digitsOf(s);
  return d ? `${d}@s.whatsapp.net` : "";
}
function toGreenChat(chatId) {
  const s = String(chatId || "").trim();
  if (s.endsWith("@g.us")) return s;
  const d = digitsOf(s);
  return d ? `${d}@c.us` : "";
}

const MEDIA_TYPES = {
  image: "imageMessage", video: "videoMessage", gif: "videoMessage", audio: "audioMessage",
  voice: "audioMessage", document: "documentMessage", sticker: "stickerMessage",
};
const greenType = (t) => (t === "text" ? "textMessage" : MEDIA_TYPES[t] || "unknown");

const mediaOf = (m) => (m && (m.image || m.video || m.gif || m.audio || m.voice || m.document || m.sticker)) || null;
const textOf = (m) => (m && m.text && m.text.body) || (mediaOf(m) && mediaOf(m).caption) || "";

function fileData(m) {
  const f = mediaOf(m) || {};
  return { downloadUrl: f.link || "", caption: f.caption || "", fileName: f.filename || "", mimeType: f.mime_type || "" };
}

function quotedOf(ctx) {
  if (!ctx || !ctx.quoted_id) return null;
  const qc = ctx.quoted_content || {};
  const qm = qc.image || qc.video || qc.document || qc.audio || qc.voice || {};
  return {
    stanzaId: ctx.quoted_id,
    participant: toGreenChat(ctx.quoted_author || ""),
    typeMessage: greenType(ctx.quoted_type),
    textMessage: (qc.text && qc.text.body) || "",
    downloadUrl: qm.link || "",
    caption: qm.caption || "",
  };
}

// One Whapi message → one Green incomingMessageReceived webhook, or null when
// Green would not have sent one the routers handle (our own sends, polls…).
function toGreenWebhook(m, { idInstance, wid } = {}) {
  if (!m || m.from_me) return null;
  const chatId = toGreenChat(m.chat_id);
  if (!chatId) return null;
  const quoted = quotedOf(m.context);
  let messageData;
  if (m.type === "text") {
    messageData = quoted
      ? { typeMessage: "quotedMessage",
          extendedTextMessageData: { text: textOf(m), stanzaId: quoted.stanzaId, participant: quoted.participant },
          quotedMessage: quoted }
      : { typeMessage: "textMessage", textMessageData: { textMessage: textOf(m) } };
  } else if (MEDIA_TYPES[m.type]) {
    messageData = { typeMessage: MEDIA_TYPES[m.type], fileMessageData: fileData(m), ...(quoted ? { quotedMessage: quoted } : {}) };
  } else if (m.type === "reply" && m.reply && m.reply.buttons_reply) {
    const b = m.reply.buttons_reply;
    messageData = { typeMessage: "buttonsResponseMessage",
      buttonsResponseMessage: { stanzaId: quoted ? quoted.stanzaId : "", selectedButtonId: b.id || "", selectedButtonText: b.title || "" } };
  } else {
    return null;
  }
  return {
    typeWebhook: "incomingMessageReceived",
    instanceData: { idInstance: Number(idInstance) || 0, wid: wid || "", typeInstance: "whatsapp" },
    timestamp: Number(m.timestamp) || Math.floor(Date.now() / 1000),
    idMessage: m.id,
    senderData: {
      chatId, chatName: m.chat_name || m.from_name || "", sender: toGreenChat(m.from || m.chat_id),
      senderName: m.from_name || "", senderContactName: "",
    },
    messageData,
  };
}

module.exports = { toWhapiChat, toGreenChat, greenType, toGreenWebhook, fileData, textOf };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node green-bridge/format.test.js`
Expected: `green-bridge/format.test.js: ok`

- [ ] **Step 5: Commit**

```bash
git add server/green-bridge/format.js server/green-bridge/format.test.js
git commit -m "feat(green-bridge): Whapi messages as Green API webhooks"
```

---

### Task 2: History items, buttons as text, media kind

**Files:**
- Modify: `server/green-bridge/format.js`
- Test: `server/green-bridge/format.test.js`

**Interfaces:**
- Consumes: `toGreenChat`, `greenType`, `fileData`, `textOf` from Task 1.
- Produces:
  - `toGreenHistoryItem(msg: WhapiMessage) → GreenHistoryItem | null`
  - `buttonsText(payload: {header, body, footer, buttons}) → string`
  - `fileKind(nameOrUrl: string) → "image" | "video" | "audio" | "document"`

- [ ] **Step 1: Write the failing test**

Add before the final `console.log` in `server/green-bridge/format.test.js`:

```js
// ── history items: the getChatHistory shape the routers read ──
{
  const t = F.toGreenHistoryItem({ id: "A", from_me: true, type: "text", text: { body: "hi" }, chat_id: "972501234567@s.whatsapp.net", timestamp: 10 });
  assert.equal(t.type, "outgoing");
  assert.equal(t.typeMessage, "textMessage");
  assert.equal(t.textMessage, "hi");
  assert.equal(t.idMessage, "A");
  assert.equal(t.timestamp, 10);
  assert.equal(t.chatId, "972501234567@c.us");
  const i = F.toGreenHistoryItem({ id: "B", from_me: false, type: "image", image: { link: "https://w/1.jpg", caption: "c" }, chat_id: "972501234567@s.whatsapp.net", timestamp: 9 });
  assert.equal(i.type, "incoming");
  assert.equal(i.typeMessage, "imageMessage");
  assert.equal(i.downloadUrl, "https://w/1.jpg");
  assert.equal(i.caption, "c");
  assert.equal(F.toGreenHistoryItem(null), null);
}

// ── buttons → one text message, every link / code written out ──
assert.equal(F.buttonsText({ header: " ", body: "הדף מוכן", footer: "Forly", buttons: [
  { type: "url", buttonText: "לצפייה", url: "https://x.test/p" },
  { type: "copy", buttonText: "העתקה", copyCode: "https://x.test/c" },
  { type: "call", buttonText: "התקשרו", phoneNumber: "972500000000" },
] }), "הדף מוכן\n\nלצפייה: https://x.test/p\nהעתקה: https://x.test/c\nהתקשרו: 972500000000\n\nForly");
assert.equal(F.buttonsText({ body: "רק טקסט" }), "רק טקסט");

// ── media kind from the file name (or URL) ──
assert.equal(F.fileKind("slide-01.png"), "image");
assert.equal(F.fileKind("https://cdn.x/a/walk.MP4?sig=1"), "video");
assert.equal(F.fileKind("note.ogg"), "audio");
assert.equal(F.fileKind("brochure.pdf"), "document");
assert.equal(F.fileKind(""), "document");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node green-bridge/format.test.js`
Expected: FAIL with `TypeError: F.toGreenHistoryItem is not a function`

- [ ] **Step 3: Write the minimal implementation**

In `server/green-bridge/format.js`, add above `module.exports`:

```js
// One Whapi message → one Green getChatHistory / getMessage item.
function toGreenHistoryItem(m) {
  if (!m) return null;
  const typeMessage = greenType(m.type);
  const item = {
    type: m.from_me ? "outgoing" : "incoming",
    idMessage: m.id,
    timestamp: Number(m.timestamp) || 0,
    typeMessage,
    chatId: toGreenChat(m.chat_id),
    senderId: toGreenChat(m.from || ""),
    senderName: m.from_name || "",
  };
  if (typeMessage === "textMessage") item.textMessage = textOf(m);
  else Object.assign(item, fileData(m));
  return item;
}

// Green interactive buttons → one plain text (Whapi documents quick replies
// only): header, body, each button's link / code / number, footer.
function buttonsText({ header, body, footer, buttons } = {}) {
  const lines = (Array.isArray(buttons) ? buttons : []).map((b) => {
    const label = String((b && b.buttonText) || "").trim();
    const value = b && (b.url || b.copyCode || b.phoneNumber);
    return value ? `${label}: ${value}` : label;
  }).filter(Boolean);
  return [header, body, lines.join("\n"), footer].map((s) => String(s || "").trim()).filter(Boolean).join("\n\n");
}

// Which Whapi /messages/{kind} endpoint sends this file.
function fileKind(nameOrUrl) {
  const ext = (String(nameOrUrl || "").toLowerCase().split("?")[0].match(/\.([a-z0-9]+)$/) || [])[1] || "";
  if (/^(jpe?g|png|webp)$/.test(ext)) return "image";
  if (/^(mp4|mov|3gp)$/.test(ext)) return "video";
  if (/^(mp3|ogg|oga|opus|m4a|aac|wav)$/.test(ext)) return "audio";
  return "document";
}
```

Change the exports line to:

```js
module.exports = { toWhapiChat, toGreenChat, greenType, toGreenWebhook, toGreenHistoryItem, buttonsText, fileKind, fileData, textOf };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node green-bridge/format.test.js`
Expected: `green-bridge/format.test.js: ok`

- [ ] **Step 5: Commit**

```bash
git add server/green-bridge/format.js server/green-bridge/format.test.js
git commit -m "feat(green-bridge): history items, buttons as text, media kind"
```

---

### Task 3: Whapi client

**Files:**
- Create: `server/green-bridge/whapi-client.js`
- Test: `server/green-bridge/router.test.js` (client section; the file grows in Tasks 4–5)

**Interfaces:**
- Produces: `createWhapiClient({ token, baseUrl?, fetchFn? })` → an object with:
  - `sendText(to, body, quoted?) → Promise<{sent, message:{id}}>`
  - `sendMedia(kind, to, media, {caption?, filename?, quoted?}) → Promise<{sent, message:{id}}>`
  - `listMessages(chatId, count) → Promise<{messages: WhapiMessage[]}>`
  - `getMessage(id) → Promise<WhapiMessage>`
  - Every method throws `Error` with `.status` on a non-2xx response.

- [ ] **Step 1: Write the failing test**

Create `server/green-bridge/router.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node green-bridge/router.test.js`
Expected: FAIL with `Cannot find module './whapi-client'`

- [ ] **Step 3: Write the minimal implementation**

Create `server/green-bridge/whapi-client.js`:

```js
/*
 * Minimal Whapi.Cloud REST client for the Green API bridge. Base
 * https://gate.whapi.cloud, Authorization: Bearer <channel token>.
 * Errors carry .status and name the call, never the chat id.
 */

const TIMEOUT_MS = 20000;

function createWhapiClient({ token, baseUrl = "https://gate.whapi.cloud", fetchFn = fetch } = {}) {
  const base = String(baseUrl).trim().replace(/\/+$/, "");
  async function call(label, method, path, body) {
    const r = await fetchFn(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(`Whapi ${label} → ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return data;
  }
  return {
    sendText: (to, body, quoted) =>
      call("messages/text", "POST", "/messages/text", { to, body, ...(quoted ? { quoted } : {}) }),
    sendMedia: (kind, to, media, { caption, filename, quoted } = {}) =>
      call(`messages/${kind}`, "POST", `/messages/${kind}`, {
        to, media,
        ...(caption ? { caption } : {}),
        ...(kind === "document" && filename ? { filename } : {}),
        ...(quoted ? { quoted } : {}),
      }),
    listMessages: (chatId, count) =>
      call("messages/list", "GET", `/messages/list/${encodeURIComponent(chatId)}?count=${Number(count) || 100}`),
    getMessage: (id) => call("messages/get", "GET", `/messages/${encodeURIComponent(id)}`),
  };
}

module.exports = { createWhapiClient };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node green-bridge/router.test.js`
Expected: `green-bridge/router.test.js: ok`

- [ ] **Step 5: Commit**

```bash
git add server/green-bridge/whapi-client.js server/green-bridge/router.test.js
git commit -m "feat(green-bridge): minimal Whapi client"
```

---

### Task 4: Green-style method routes (outgoing)

**Files:**
- Create: `server/green-bridge/router.js`
- Test: `server/green-bridge/router.test.js`

**Interfaces:**
- Consumes:
  - from Task 1–2 (`./format`): `toWhapiChat`, `toGreenHistoryItem`, `buttonsText`, `fileKind`
  - from Task 3 (`./whapi-client`): `createWhapiClient`
  - `constantTimeEqual(a, b)` from `server/security.js`
- Produces: `createGreenBridge({ env?, fetchFn?, client? }) → express.Router` with:
  - `POST /waInstance:instance/:method/:token` handling `sendMessage`, `sendFileByUrl`, `sendInteractiveButtons`, `getChatHistory`, `getMessage`; 501 for any other method
  - `router.idle() → Promise` (used in Task 5)

- [ ] **Step 1: Write the failing test**

In `server/green-bridge/router.test.js`, add after the first `require` line:

```js
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
  return { post, close: () => server.close() };
}
```

Then add before the final `console.log`:

```js
  // ── Green-style calls → Whapi ──
  {
    const realErr = console.error; console.error = () => {};
    const client = fakeClient();
    const env = { GREENAPI_TOKEN: "gtok", WHAPI_TOKEN: "wtok" };
    const { post, close } = await serve(createGreenBridge({ env, client }));
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

      assert.equal((await post(`${P}/setSettings/gtok`, {})).status, 501);

      // Whapi refusing → Green-style error status, not a crash
      client.sendText = async () => { const e = new Error("Whapi messages/text → 400"); e.status = 400; throw e; };
      assert.equal((await post(`${P}/sendMessage/gtok`, { chatId: "972501234567@c.us", message: "x" })).status, 400);
      client.sendText = async () => { throw new Error("timeout"); };
      assert.equal((await post(`${P}/sendMessage/gtok`, { chatId: "972501234567@c.us", message: "x" })).status, 502);
    } finally { close(); console.error = realErr; }

    // bridge off (no WHAPI_TOKEN, no client) → 503
    const off = await serve(createGreenBridge({ env: { GREENAPI_TOKEN: "gtok" } }));
    try { assert.equal((await off.post(`${P}/sendMessage/gtok`, { chatId: "972501234567@c.us", message: "x" })).status, 503); }
    finally { off.close(); }
  }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node green-bridge/router.test.js`
Expected: FAIL with `Cannot find module './router'`

- [ ] **Step 3: Write the minimal implementation**

Create `server/green-bridge/router.js`:

```js
/*
 * Green API ⇄ Whapi bridge — the stopgap that keeps n8n's Green API node and
 * every workflow unchanged while the number runs on Whapi.Cloud.
 *
 *   POST /greenapi/waInstance{id}/{method}/{GREENAPI_TOKEN}
 *       Green-style calls (n8n's patched Green API node, the server and
 *       Functions via GREENAPI_API_URL) answered through Whapi.
 *   POST /greenapi/whapi-inbound/{WHAPI_WEBHOOK_SECRET}
 *       Whapi's webhook; each message is rebuilt as a Green API
 *       incomingMessageReceived webhook and posted to GREEN_BRIDGE_N8N_WEBHOOK.
 *
 * Delete this folder once Forly is on the official WhatsApp API.
 */

const express = require("express");
const { constantTimeEqual } = require("../security");
const F = require("./format");
const { createWhapiClient } = require("./whapi-client");

const FORWARD_TIMEOUT_MS = 20000;
const tail = (chatId) => `…${String(chatId || "").replace(/@.*/, "").slice(-4)}`;

module.exports = function createGreenBridge({ env = process.env, fetchFn = fetch, client } = {}) {
  const router = express.Router();
  const whapi = client || (env.WHAPI_TOKEN
    ? createWhapiClient({ token: env.WHAPI_TOKEN, baseUrl: env.WHAPI_API_URL || undefined, fetchFn })
    : null);
  let pending = Promise.resolve();
  router.idle = () => pending;

  router.post("/waInstance:instance/:method/:token", async (req, res) => {
    if (!whapi) return res.status(503).json({ error: "bridge_off" });
    if (!env.GREENAPI_TOKEN || !constantTimeEqual(req.params.token, env.GREENAPI_TOKEN)) {
      return res.status(401).json({ error: "bad_token" });
    }
    const b = req.body || {};
    const to = F.toWhapiChat(b.chatId);
    const quoted = b.quotedMessageId || undefined;
    const sent = (r) => res.json({ idMessage: (r && r.message && r.message.id) || "" });
    try {
      switch (req.params.method) {
        case "sendMessage":
          if (!to || !b.message) return res.status(400).json({ error: "chatId_and_message_required" });
          return sent(await whapi.sendText(to, String(b.message), quoted));
        case "sendFileByUrl":
          if (!to || !b.urlFile) return res.status(400).json({ error: "chatId_and_urlFile_required" });
          return sent(await whapi.sendMedia(F.fileKind(b.fileName || b.urlFile), to, String(b.urlFile),
            { caption: b.caption || undefined, filename: b.fileName || undefined, quoted }));
        case "sendInteractiveButtons": {
          const text = F.buttonsText(b);
          if (!to || !text) return res.status(400).json({ error: "chatId_and_body_required" });
          return sent(await whapi.sendText(to, text, quoted));
        }
        case "getChatHistory": {
          if (!to) return res.status(400).json({ error: "chatId_required" });
          const count = Math.min(Math.max(Number(b.count) || 100, 1), 500);
          const r = await whapi.listMessages(to, count);
          return res.json((Array.isArray(r.messages) ? r.messages : []).map(F.toGreenHistoryItem).filter(Boolean));
        }
        case "getMessage": {
          if (!b.idMessage) return res.status(400).json({ error: "idMessage_required" });
          return res.json(F.toGreenHistoryItem(await whapi.getMessage(String(b.idMessage))) || {});
        }
        default:
          return res.status(501).json({ error: "method_not_bridged", method: req.params.method });
      }
    } catch (err) {
      console.error(`[green-bridge] ${req.params.method} ${tail(b.chatId)} failed: ${err.message}`);
      return res.status(err.status >= 400 && err.status < 500 ? err.status : 502).json({ error: "whapi_failed" });
    }
  });

  return router;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node green-bridge/router.test.js`
Expected: `green-bridge/router.test.js: ok`

- [ ] **Step 5: Commit**

```bash
git add server/green-bridge/router.js server/green-bridge/router.test.js
git commit -m "feat(green-bridge): Green-style send and history calls answered by Whapi"
```

---

### Task 5: Whapi inbound → n8n

**Files:**
- Modify: `server/green-bridge/router.js`
- Test: `server/green-bridge/router.test.js`

**Interfaces:**
- Consumes: `toGreenWebhook` (Task 1); the `pending` / `router.idle()` defined in Task 4.
- Produces: `POST /whapi-inbound/:secret` → `200 {ok:true, received:n}` immediately. Forwarding then runs in order, one message at a time, and across webhooks too. `router.idle()` resolves when it is done.

- [ ] **Step 1: Write the failing test**

Add before the final `console.log` in `server/green-bridge/router.test.js`:

```js
  // ── Whapi webhook → Green-format webhooks posted to n8n, in order ──
  {
    const realErr = console.error; console.error = () => {};
    const forwarded = [];
    const fetchFn = async (url, o) => { forwarded.push({ url, body: JSON.parse(o.body) }); return { ok: true, status: 200 }; };
    const env = { GREENAPI_TOKEN: "gtok", WHAPI_WEBHOOK_SECRET: "hook-secret", GREENAPI_INSTANCE: "7105422200",
      GREEN_BRIDGE_N8N_WEBHOOK: "https://n8n.test/webhook/avisa-reply-v2" };
    const bridge = createGreenBridge({ env, fetchFn, client: fakeClient() });
    const { post, close } = await serve(bridge);
    try {
      assert.equal((await post("/whapi-inbound/wrong", { messages: [] })).status, 401);
      const r = await post("/whapi-inbound/hook-secret", { messages: [
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
        assert.equal((await s2.post("/whapi-inbound/hook-secret", { messages: [
          { id: "W9", from_me: false, type: "text", text: { body: "x" }, chat_id: "972501234567@s.whatsapp.net", timestamp: 1 }] })).status, 200);
        await failing.idle();
      } finally { s2.close(); }

      // no target configured → 503
      const noTarget = await serve(createGreenBridge({ env: { ...env, GREEN_BRIDGE_N8N_WEBHOOK: "" }, fetchFn, client: fakeClient() }));
      try { assert.equal((await noTarget.post("/whapi-inbound/hook-secret", { messages: [] })).status, 503); }
      finally { noTarget.close(); }
    } finally { close(); console.error = realErr; }
  }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node green-bridge/router.test.js`
Expected: FAIL. The first assertion gets 404 instead of 401, because the route doesn't exist yet.

- [ ] **Step 3: Write the minimal implementation**

In `server/green-bridge/router.js`, add before `return router;`:

```js
  // Whapi webhook. Answered at once (Whapi retries slow or failed calls,
  // which would handle a message twice); forwarding runs after, in order.
  router.post("/whapi-inbound/:secret", (req, res) => {
    if (!env.WHAPI_WEBHOOK_SECRET || !constantTimeEqual(req.params.secret, env.WHAPI_WEBHOOK_SECRET)) {
      return res.status(401).json({ error: "bad_secret" });
    }
    const target = String(env.GREEN_BRIDGE_N8N_WEBHOOK || "").trim();
    if (!target) return res.status(503).json({ error: "no_target" });
    const msgs = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
    res.json({ ok: true, received: msgs.length });
    pending = pending.then(async () => {
      for (const m of msgs) {
        const hook = F.toGreenWebhook(m, { idInstance: env.GREENAPI_INSTANCE, wid: env.WHATSAPP_WID });
        if (!hook) continue;
        try {
          const r = await fetchFn(target, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(hook),
            signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
          });
          if (!r.ok) console.error(`[green-bridge] n8n refused ${hook.messageData.typeMessage} from ${tail(hook.senderData.chatId)}: ${r.status}`);
        } catch (err) {
          console.error(`[green-bridge] n8n forward from ${tail(hook.senderData.chatId)} failed: ${err.message}`);
        }
      }
    });
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node green-bridge/router.test.js`
Expected: `green-bridge/router.test.js: ok`

- [ ] **Step 5: Commit**

```bash
git add server/green-bridge/router.js server/green-bridge/router.test.js
git commit -m "feat(green-bridge): Whapi webhook forwarded to n8n as Green API webhooks"
```

---

### Task 6: Mount on the server and register the tests

**Files:**
- Modify: `server/index.js` (right after the `app.use("/api/auth", createAuthRouter({...}))` block)
- Modify: `server/package.json` (`scripts.test`)

**Interfaces:**
- Consumes: `createGreenBridge` (Tasks 4–5).
- Produces: `/greenapi/*` live on the running server.

- [ ] **Step 1: Mount the router**

In `server/index.js`, directly after the closing `}));` of `app.use("/api/auth", createAuthRouter({ … }));`, insert:

```js
// ── Green API ⇄ Whapi bridge (stopgap; see server/green-bridge/router.js) ──
// Answers Green-style calls through Whapi and forwards Whapi's webhook to n8n
// in Green's format, so n8n's workflows run unchanged. Off until WHAPI_TOKEN.
app.use("/greenapi", require("./green-bridge/router")());
```

- [ ] **Step 2: Register the tests**

In `server/package.json`, in `scripts.test`, replace `node auth-otp.test.js && ` with:

```
node auth-otp.test.js && node green-bridge/format.test.js && node green-bridge/router.test.js && 
```

(keep the trailing space before the next `node`).

- [ ] **Step 3: Boot check: the route exists and refuses a bad token**

Run:
```bash
cd server && (PORT=18788 FORLY_ENV=local WHAPI_TOKEN=x GREENAPI_TOKEN=gtok timeout 10 node index.js >/tmp/bridge-boot.log 2>&1 &) ; sleep 5; \
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:18788/greenapi/waInstance1/sendMessage/nope
```
Expected: `401`

- [ ] **Step 4: Run the full server suite**

Run: `cd server && npm test`
Expected: every script prints its ok line and exit code 0. In a sandbox without DNS, `utils.test.js` fails on `example.com` both with and without this change. Confirm that by running it on the base commit, and treat it as not a regression.

- [ ] **Step 5: Commit and push**

```bash
git add server/index.js server/package.json
git commit -m "feat(green-bridge): mount at /greenapi"
git push -u origin hotfix/whapi-green-bridge
```

---

### Task 7: Go live (operator runbook; you do these steps)

No code. Every step has a check. Steps 1–4 bring back login codes and backend messages. Steps 5–7 bring back the n8n bot.

- [ ] **Step 1: Connect the number to Whapi**
  1. Create a channel at whapi.cloud.
  2. On the business phone, go to WhatsApp → Linked devices → Link a device, and scan Whapi's QR code.
  3. In Linked devices, **log out Green API's device**, so messages aren't processed twice when Green API recovers.
  4. In the Whapi channel settings, **turn on media auto-download**. Without it, photos and voice notes arrive with no link.
  5. Copy the channel's API token.

  Check: in the Whapi dashboard, channel status is `AUTH` (connected).

- [ ] **Step 2: Server env, then deploy `hotfix/whapi-green-bridge`**

  Add to the production server env:
  ```
  WHAPI_TOKEN=<Whapi channel token>
  WHAPI_WEBHOOK_SECRET=<new random string, e.g. output of: openssl rand -hex 24>
  GREEN_BRIDGE_N8N_WEBHOOK=https://n8n.srv1173890.hstgr.cloud/webhook/avisa-reply-v2
  GREENAPI_API_URL=http://127.0.0.1:8787/greenapi
  ```
  Keep the existing `GREENAPI_INSTANCE` and `GREENAPI_TOKEN`. The bridge uses that token as its password, and the server keeps sending with it.

  Check (on the server host):
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:8787/greenapi/waInstance1/sendMessage/nope
  ```
  Expected: `401`

- [ ] **Step 3: Find the server's public address**
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' https://nadlan.call4li.com/greenapi/waInstance1/sendMessage/nope
  ```
  - `401`: the public base is `https://nadlan.call4li.com`.
  - `404` or an HTML page: try the server's own host (`https://forly.srv1173890.hstgr.cloud`) the same way, and use whichever returns `401`.

  Call it `PUBLIC_BASE` below.

- [ ] **Step 4: Login codes and Functions**
  1. Request a login code for your own number at `PUBLIC_BASE`. The code should arrive on WhatsApp.
  2. Firebase Functions: set `GREENAPI_API_URL=<PUBLIC_BASE>/greenapi` in `functions/.env`, and deploy the Functions from this branch.

  Check: the code arrives. Then trigger one Functions message (for example, save a carousel draft edit) and see it arrive.

- [ ] **Step 5: Point Whapi's webhook at the bridge**

  In the Whapi channel settings, set the webhook:
  - URL: `<PUBLIC_BASE>/greenapi/whapi-inbound/<WHAPI_WEBHOOK_SECRET>`
  - Mode: `body`, method `POST`, events: `messages` only

  Check: send "בדיקה" to the business number from another phone. The server log shows no `[green-bridge]` error, and in n8n → Executions, "Main Router v2" has a new run.

- [ ] **Step 6: Point n8n's Green API node at the bridge (on the n8n VPS)**

  ```bash
  N8N=$(docker ps --format '{{.Names}}' | grep -i n8n | head -1); echo "$N8N"
  docker exec "$N8N" sh -c 'ls -d /home/node/.n8n/nodes/node_modules/n8n-nodes-greenapi/dist'
  docker exec "$N8N" sh -c 'cp -r /home/node/.n8n/nodes/node_modules/n8n-nodes-greenapi/dist /home/node/.n8n/nodes/node_modules/n8n-nodes-greenapi/dist.orig'
  docker exec "$N8N" sh -c 'grep -rl "https://api.green-api.com" /home/node/.n8n/nodes/node_modules/n8n-nodes-greenapi/dist | xargs sed -i -e "s#https://api.green-api.com/#http://forly-intake:8787/greenapi/#g" -e "s#https://api.green-api.com#http://forly-intake:8787/greenapi#g"'
  docker exec "$N8N" sh -c 'grep -rho "http://forly-intake:8787/greenapi/waInstance" /home/node/.n8n/nodes/node_modules/n8n-nodes-greenapi/dist | head -1'
  docker restart "$N8N"
  ```
  - `forly-intake` is the hostname the n8n workflows already use for the server (`http://forly-intake:8787/api/whatsapp/intake`).
  - If the `ls` path doesn't exist, find the package with `docker exec "$N8N" sh -c 'find / -path "*n8n-nodes-greenapi/dist" -type d 2>/dev/null'` and use that path in the next three commands.

  Check: the second-to-last command prints `http://forly-intake:8787/greenapi/waInstance`, and after the restart, n8n's UI loads.

- [ ] **Step 7: Smoke test from a phone, in this order**
  1. A text to the bot → the bot replies.
  2. A listing text → the draft flow starts.
  3. A photo → the bot acknowledges it, and the photo reaches the edit flow.
  4. A reply quoting that photo with "תשפר" → the edit runs on the quoted photo.
  5. A voice note → it's transcribed.
  6. Page ready → the message arrives with the links written out as text.
  7. Log to Group → a message appears in the group.

  If a step fails, check the server log for `[green-bridge]` lines and the failed n8n execution's input. The fields still unconfirmed are listed under Risks below.

- [ ] **Step 8: Rollback, if needed**
  1. In the Whapi channel settings, remove the webhook.
  2. On the n8n VPS:
     ```bash
     docker exec "$N8N" sh -c 'd=/home/node/.n8n/nodes/node_modules/n8n-nodes-greenapi; rm -rf $d/dist && mv $d/dist.orig $d/dist'
     docker restart "$N8N"
     ```
  3. Remove `GREENAPI_API_URL` from the server and `functions/.env`, and redeploy.
  4. Re-link Green API by QR when it recovers.

---

## Risks and things only live traffic can confirm

- **Quoted-photo fields.** Whapi's `context.quoted_content.image.link` comes from Whapi's published TypeScript typings, not from a live message. If the edit-a-quoted-photo step fails, log one raw Whapi webhook body (temporarily add `console.log(JSON.stringify(req.body))` in the inbound route) and fix `quotedOf()` in `format.js`.
- **Media links.** They need media auto-download on (Step 1). Whapi's media URLs must be publicly fetchable by fal.ai, Claude vision and persistMedia, the way Green's `downloadUrl`s were. Check in smoke test step 3.
- **Buttons arrive as text** with the links written out. That's intended for the stopgap.
- **A node update undoes the n8n patch** (Step 6). Don't update `n8n-nodes-greenapi` while the bridge is in use.
- **Not covered:** the "Test Walkthrough Flow" calls `api.green-api.com` from plain HTTP nodes. It's a test workflow and stays broken. The 13 workflows the audit couldn't read also go through the Green API node, so the patch covers any of them that use it.
