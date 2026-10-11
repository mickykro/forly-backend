/*
 * Green API adapter (green-api.com). Env: GREENAPI_INSTANCE, GREENAPI_TOKEN,
 * optional GREENAPI_API_URL. Contract: see ./index.js.
 *
 * Calls go to the instance's own host (the first 4 digits of its id name its
 * server, e.g. 7105… → 7105.api.greenapi.com), not the shared
 * api.green-api.com: that host went down with Green API's site while instance
 * 7105 stayed up, which broke login codes.
 */

const TIMEOUT_MS = 20000;

const configured = (env) => Boolean(env.GREENAPI_INSTANCE && env.GREENAPI_TOKEN);
const chatId = (phone) => `${phone}@c.us`;

function base(env) {
  const instance = env.GREENAPI_INSTANCE;
  const override = String(env.GREENAPI_API_URL || "").trim().replace(/\/+$/, "");
  return `${override || `https://${String(instance).slice(0, 4)}.api.greenapi.com`}/waInstance${instance}`;
}

const post = (env, method, body) => fetch(`${base(env)}/${method}/${env.GREENAPI_TOKEN}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(TIMEOUT_MS),
});

async function sendText(phone, text, env) {
  const r = await post(env, "sendMessage", { chatId: chatId(phone), message: text });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.error(`Green API sendMessage refused (${r.status}): ${body.slice(0, 200)}`);
  }
  return r.ok;
}

async function sendButtons(phone, { header, body, footer, buttons }, env) {
  const r = await post(env, "sendInteractiveButtons", {
    chatId: chatId(phone),
    header: header || " ",
    body,
    footer: footer || " ",
    buttons,
  });
  if (!r.ok) throw new Error(`sendInteractiveButtons ${r.status}`);
  return r.json().catch(() => ({}));
}

// Green API message → the neutral Message (index.js).
function toMessage(m) {
  if (!m) return null;
  const text = m.textMessage || (m.extendedTextMessage || {}).text || m.caption || "";
  const type = m.typeMessage === "imageMessage" ? "image"
    : /^(textMessage|extendedTextMessage)$/.test(m.typeMessage || "") ? "text" : "other";
  return { id: m.idMessage || null, fromMe: m.type === "outgoing", type, text, mediaUrl: m.downloadUrl || null, timestamp: Number(m.timestamp) || 0 };
}

async function getHistory(phone, count, env) {
  const r = await post(env, "getChatHistory", { chatId: chatId(phone), count });
  const j = r.ok ? await r.json() : [];
  return Array.isArray(j) ? j.map(toMessage) : [];
}

async function getMessage(phone, id, env) {
  const r = await post(env, "getMessage", { chatId: chatId(phone), idMessage: id });
  return r.ok ? toMessage(await r.json()) : null;
}

module.exports = { configured, sendText, sendButtons, getHistory, getMessage, toMessage, base };
