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

console.log("green-bridge/format.test.js: ok");
