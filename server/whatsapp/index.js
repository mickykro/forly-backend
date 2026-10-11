/*
 * WhatsApp — the one door every server-side send and chat read goes through.
 *
 * WHATSAPP_PROVIDER picks the adapter (greenapi | whapi; default greenapi).
 * Switching providers = set the env var and that provider's credentials;
 * a new provider = one adapter file with the same five functions, registered
 * below. Nothing outside this folder knows a provider's URL, auth, chat-id
 * suffix or message shape.
 *
 * Adapter contract (each takes env last):
 *   configured(env)                  → bool, creds present
 *   sendText(phone, text, env)       → true accepted | false refused (logged)
 *   sendButtons(phone, payload, env) → resolves on send, throws when refused
 *   getHistory(phone, count, env)    → [Message] newest first
 *   getMessage(phone, id, env)       → Message | null
 * Message (provider-neutral):
 *   { id, fromMe, type: "text" | "image" | "other", text, mediaUrl, timestamp (s) }
 * phone is digits with country code (972…), no suffix.
 */

const PROVIDERS = {
  greenapi: require("./greenapi"),
  whapi: require("./whapi"),
};

function providerName(env = process.env) {
  return String(env.WHATSAPP_PROVIDER || "greenapi").trim().toLowerCase();
}

function provider(env = process.env) {
  const p = PROVIDERS[providerName(env)];
  if (!p) throw new Error(`WHATSAPP_PROVIDER "${providerName(env)}" is not one of: ${Object.keys(PROVIDERS).join(", ")}`);
  return p;
}

// Creds present for the selected provider. Off = local dev: sends are no-ops.
const whatsappEnabled = (env = process.env) => provider(env).configured(env);

// Resolves true when the provider accepted the message, false when it refused
// it, undefined when WhatsApp is off (local dev).
async function sendWhatsApp(phone, message) {
  if (!whatsappEnabled()) return;
  return provider().sendText(String(phone), String(message), process.env);
}

/*
 * Buttons. Limits enforced here rather than trusted from call sites: at most 3
 * buttons, button text ≤ 25 chars — providers reject the whole message
 * otherwise, and a rejected message is a lost notification.
 * Throws when the provider refuses, so callers can fall back to text.
 */
async function sendWhatsAppButtons(phone, { header, body, footer, buttons } = {}) {
  // Never the phone, the body or the links: a link may be a signed one-tap token.
  console.log(`[whatsapp] buttons → …${String(phone || "").slice(-4)} (${(buttons || []).length})`);
  if (!whatsappEnabled()) return;
  const clean = (buttons || []).slice(0, 3).map((b, i) => ({
    ...b,
    buttonId: String(b.buttonId || i + 1),
    buttonText: String(b.buttonText || "").slice(0, 25),
  }));
  return provider().sendButtons(String(phone), {
    header: String(header || "").slice(0, 60),
    body: String(body || ""),
    footer: String(footer || "").slice(0, 60),
    buttons: clean,
  }, process.env);
}

// The same message as plain text: header, body, each link spelled out, footer.
// What a rejected interactive send falls back to — the link is never lost.
function textOfButtons({ header, body, footer, buttons } = {}) {
  const links = (buttons || []).filter((b) => b && b.url).map((b) => `${String(b.buttonText || "").trim()}: ${b.url}`);
  return [String(header || "").trim(), String(body || "").trim(), links.join("\n"), String(footer || "").trim()]
    .filter(Boolean).join("\n\n");
}

// Links go behind buttons: the interactive message first, its text on any failure.
async function sendWhatsAppRich(phone, payload) {
  try { return await sendWhatsAppButtons(phone, payload); }
  catch (e) { console.warn(`[whatsapp] buttons failed (${e && e.message}), sending text`); }
  return sendWhatsApp(phone, textOfButtons(payload));
}

// The last `count` messages of a chat, newest first, provider-neutral.
async function getWhatsAppHistory(phone, count) {
  if (!whatsappEnabled()) return [];
  return provider().getHistory(String(phone), count, process.env);
}

// One message of a chat, e.g. the image an agent replied to.
async function getWhatsAppMessage(phone, id) {
  if (!whatsappEnabled()) return null;
  return provider().getMessage(String(phone), String(id), process.env);
}

module.exports = {
  providerName, whatsappEnabled, sendWhatsApp, sendWhatsAppButtons, sendWhatsAppRich,
  textOfButtons, getWhatsAppHistory, getWhatsAppMessage,
};
