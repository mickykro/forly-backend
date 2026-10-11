/*
 * Whapi.Cloud adapter. Env: WHAPI_TOKEN (the channel's API token), optional
 * WHAPI_API_URL (default https://gate.whapi.cloud). Contract: see ./index.js.
 *
 * Personal chats are {phone}@s.whatsapp.net (Whapi no longer takes @c.us).
 * Media in chat history carries a link only when the channel has media
 * auto-download on (Whapi channel settings) — without it photo-based flows
 * (edit the photos just sent, the image a reply quotes) find no photos.
 *
 * Buttons: Whapi documents only quick-reply buttons; Forly's buttons are
 * links and copy-codes, so those go as text with each link spelled out
 * (textOfButtons) — the same fallback a refused interactive send gets.
 */

const TIMEOUT_MS = 20000;

const configured = (env) => Boolean(env.WHAPI_TOKEN);
const chatId = (phone) => `${phone}@s.whatsapp.net`;
const base = (env) => String(env.WHAPI_API_URL || "https://gate.whapi.cloud").trim().replace(/\/+$/, "");

const call = (env, method, path, body) => fetch(`${base(env)}${path}`, {
  method,
  headers: { Authorization: `Bearer ${env.WHAPI_TOKEN}`, Accept: "application/json",
    ...(body ? { "Content-Type": "application/json" } : {}) },
  body: body ? JSON.stringify(body) : undefined,
  signal: AbortSignal.timeout(TIMEOUT_MS),
});

async function sendText(phone, text, env) {
  const r = await call(env, "POST", "/messages/text", { to: chatId(phone), body: text });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.error(`Whapi messages/text refused (${r.status}): ${body.slice(0, 200)}`);
  }
  return r.ok;
}

async function sendButtons(phone, payload, env) {
  const { header, body, footer, buttons } = payload;
  if (buttons.some((b) => b.url || b.copyCode || (b.type && b.type !== "reply"))) {
    const { textOfButtons } = require("./index");
    if (await sendText(phone, textOfButtons(payload), env)) return {};
    throw new Error("Whapi messages/text refused");
  }
  const r = await call(env, "POST", "/messages/interactive", {
    to: chatId(phone),
    type: "button",
    ...(header ? { header: { text: header } } : {}),
    body: { text: body },
    ...(footer ? { footer: { text: footer } } : {}),
    action: { buttons: buttons.map((b) => ({ type: "quick_reply", title: b.buttonText, id: b.buttonId })) },
  });
  if (!r.ok) throw new Error(`Whapi messages/interactive ${r.status}`);
  return r.json().catch(() => ({}));
}

// Whapi message → the neutral Message (index.js).
function toMessage(m) {
  if (!m) return null;
  const media = m.image || m.video || m.document || {};
  const type = m.type === "image" ? "image" : m.type === "text" ? "text" : "other";
  return {
    id: m.id || null,
    fromMe: Boolean(m.from_me),
    type,
    text: (m.text && m.text.body) || media.caption || "",
    mediaUrl: (m.image && m.image.link) || null,
    timestamp: Number(m.timestamp) || 0,
  };
}

async function getHistory(phone, count, env) {
  const r = await call(env, "GET", `/messages/list/${encodeURIComponent(chatId(phone))}?count=${Number(count) || 30}`);
  const j = r.ok ? await r.json().catch(() => ({})) : {};
  return Array.isArray(j.messages) ? j.messages.map(toMessage) : [];
}

async function getMessage(phone, id, env) {
  const r = await call(env, "GET", `/messages/${encodeURIComponent(id)}`);
  return r.ok ? toMessage(await r.json().catch(() => null)) : null;
}

module.exports = { configured, sendText, sendButtons, getHistory, getMessage, toMessage, base };
