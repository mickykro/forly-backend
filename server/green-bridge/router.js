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

  return router;
};
