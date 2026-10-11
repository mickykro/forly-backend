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
