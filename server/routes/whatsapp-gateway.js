/*
 * n8n's provider-neutral WhatsApp door (mounted under /api/whatsapp):
 *
 *   POST /send     { to, text }                          plain text
 *                  { to, file_url, file_name, caption }  a file by URL
 *                  { to, text, header?, footer?, buttons: [{ type, buttonText, url | copyCode }] }
 *                  optional quoted_id on any of them     → { ok, id }
 *   POST /history  { to, count? }                        → { ok, messages }
 *
 * `to` is a phone (972…, 05…, …@c.us) or a group id (…@g.us). Auth is the
 * same x-forly-secret n8n sends to /intake, or a direct call from inside the
 * Docker network (see internalCaller).
 *
 * Today this speaks Green API's REST shape at greenApiBase — the Whapi bridge
 * (GREENAPI_API_URL → /greenapi) or Green API itself — and history comes back
 * in Green's item shape, which the n8n code nodes already read. Moving to the
 * official API changes this file; the workflows keep calling /send and /history.
 */

const express = require("express");
const { constantTimeEqual } = require("../security");
const { greenApiBase, normalizeAuthPhone } = require("../utils");

const TIMEOUT_MS = 20000;
const MAX_TEXT = 4096;

function chatIdOf(to) {
  const s = String(to || "").trim();
  if (/^\d{5,25}@g\.us$/.test(s)) return s;
  const phone = normalizeAuthPhone(s.replace(/@.*$/, ""));
  return phone ? `${phone}@c.us` : "";
}

// A call straight from a container on the same Docker network (n8n →
// http://forly-intake:8787): a private source address and no proxy headers.
// Everything from outside arrives through Traefik, which always adds
// X-Forwarded-For, so it still needs the secret. The container publishes no
// host port. WHATSAPP_GATEWAY_INTERNAL=0 turns this off.
const PRIVATE_IP = /^(?:::ffff:)?(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|127\.)|^::1$/;
function internalCaller(req) {
  if (req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.headers.forwarded) return false;
  return PRIVATE_IP.test(String((req.socket && req.socket.remoteAddress) || ""));
}

module.exports = function createWhatsappGateway({ n8nSecret, env = process.env, fetchFn = fetch, trustInternal } = {}) {
  const router = express.Router();
  const internalOk = trustInternal !== undefined ? trustInternal : String(env.WHATSAPP_GATEWAY_INTERNAL || "1") !== "0";

  function requireN8n(req, res, next) {
    if (n8nSecret && constantTimeEqual(req.get("x-forly-secret"), n8nSecret)) return next();
    if (internalOk && internalCaller(req)) return next();
    if (!n8nSecret && !internalOk) return res.status(503).json({ error: "n8n_secret_not_configured" });
    return res.status(403).json({ error: "forbidden" });
  }

  async function call(method, body) {
    if (!env.GREENAPI_INSTANCE || !env.GREENAPI_TOKEN) {
      const err = new Error("whatsapp_not_configured"); err.status = 503; throw err;
    }
    const r = await fetchFn(`${greenApiBase(env.GREENAPI_INSTANCE, env)}/${method}/${env.GREENAPI_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) { const err = new Error(`${method} → ${r.status}`); err.status = 502; throw err; }
    return data;
  }

  const fail = (res, where, chatId) => (err) => {
    console.error(`[whatsapp-gateway] ${where} …${chatId.replace(/@.*/, "").slice(-4)} failed: ${err.message}`);
    res.status(err.status === 503 ? 503 : 502).json({ error: err.status === 503 ? "whatsapp_not_configured" : "send_failed" });
  };

  router.post("/send", requireN8n, async (req, res) => {
    const b = req.body || {};
    const chatId = chatIdOf(b.to);
    if (!chatId) return res.status(400).json({ error: "invalid_to" });
    const text = String(b.text || "").slice(0, MAX_TEXT);
    const quoted = typeof b.quoted_id === "string" && b.quoted_id ? { quotedMessageId: b.quoted_id.slice(0, 200) } : {};
    let method, body;
    // n8n keypair bodies can only carry strings, so buttons may arrive as JSON.
    if (typeof b.buttons === "string") {
      try { b.buttons = JSON.parse(b.buttons); } catch (e) { return res.status(400).json({ error: "invalid_buttons" }); }
    }
    if (Array.isArray(b.buttons) && b.buttons.length) {
      method = "sendInteractiveButtons";
      body = { chatId, header: String(b.header || "").slice(0, 60), body: text, footer: String(b.footer || "").slice(0, 60),
        buttons: b.buttons.slice(0, 3).map((x, i) => ({ ...x, buttonText: String((x && x.buttonText) || "").slice(0, 25), buttonId: String((x && x.buttonId) || i + 1) })),
        ...quoted };
    } else if (b.file_url) {
      // The provider fetches this URL, not us, so a scheme check is enough here.
      if (!/^https?:\/\/[^\s]+$/i.test(String(b.file_url))) return res.status(400).json({ error: "invalid_file_url" });
      method = "sendFileByUrl";
      body = { chatId, urlFile: String(b.file_url), fileName: String(b.file_name || String(b.file_url).split("/").pop().split("?")[0] || "file"),
        ...(b.caption ? { caption: String(b.caption).slice(0, 1024) } : {}), ...quoted };
    } else if (text) {
      method = "sendMessage";
      body = { chatId, message: text, ...quoted };
    } else {
      return res.status(400).json({ error: "nothing_to_send" });
    }
    try {
      const data = await call(method, body);
      const id = (data && data.idMessage) || "";
      return res.json({ ok: true, id, idMessage: id }); // idMessage: what the Green API node returned
    } catch (err) { return fail(res, method, chatId)(err); }
  });

  router.post("/history", requireN8n, async (req, res) => {
    const b = req.body || {};
    const chatId = chatIdOf(b.to);
    if (!chatId) return res.status(400).json({ error: "invalid_to" });
    const count = Math.min(Math.max(Number(b.count) || 100, 1), 500);
    try {
      const data = await call("getChatHistory", { chatId, count });
      return res.json({ ok: true, messages: Array.isArray(data) ? data : [] });
    } catch (err) { return fail(res, "getChatHistory", chatId)(err); }
  });

  return router;
};
