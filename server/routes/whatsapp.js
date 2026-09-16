/*
 * routes/whatsapp.js — the WhatsApp chat as a property-page intake.
 *
 *   POST /api/whatsapp/intake                                n8n (x-forly-secret)
 *     { phone, message?, message_type?, file_url? }          one inbound message
 *     { phone, event: "photos_edited", photos: [url, ...] }  after a bulk photo edit
 *     → 200 { handled, status, reply, replied, listing_id }
 *     → 403 / 503 bad or unconfigured N8N_WEBHOOK_SECRET, 400 invalid_input
 *
 * n8n (Business Handler2, node `Forly Property Intake` on the Format Image
 * Library → Check Unsupported Media connection) posts EVERY registered-agent
 * message here first and continues to its AI agent only when handled is false;
 * node `Forly Photo Offer` posts each edited photo as a photos_edited event. The server keeps the
 * per-agent draft (db.getDraft), runs whatsapp-intake.handleTurn, persists,
 * and sends the replies itself over Green API. `replied:false` means Green API
 * is not configured here — n8n should then send `reply`.
 *
 * Photo batches: a stored photo arms a 20 s timer per phone (in-process; a
 * lost instance just means no progress message, and the agent's next text
 * triggers the same report). The "page is live" message comes later from the
 * n8n Property Page Builder, as for every page.
 */
const express = require("express");
const { constantTimeEqual } = require("../security");
const db = require("../db");
const { handleTurn } = require("../whatsapp-intake");
const { isPaused, asMillis } = require("../property-draft");
const { resolve } = require("../listing-sources");
const { parseListing } = require("../listing-extract");
const { createListing } = require("../listing-create");
const { importImage, DailyLimit } = require("./extract");
const { storeBuffer } = require("../upload-store");

const EXTRACT_CAP = 20;          // link/text extractions per agent per day
const PHOTO_BATCH_MS = 20000;
const MAX_TEXT = 4000;

module.exports = function createWhatsappRouter(ctx) {
  const { n8nSecret, normalizeAuthPhone, signSession, authSecret, quota, sendWhatsApp, sendButtons,
    uploadDir, uploadPublicBase, remoteUploadBase, baseUrl, pipelineDeps } = ctx;
  const router = express.Router();
  const limit = new DailyLimit(EXTRACT_CAP);
  const timers = new Map();

  // WhatsApp delivers a multi-photo send as separate near-simultaneous webhooks,
  // so concurrent requests for the same phone would each read the draft before
  // any of them saves it back — last write wins, earlier photos silently lost.
  // Serialize everything that reads-then-writes a phone's draft (a message turn,
  // the photo timer) through this so they can never interleave.
  const locks = new Map();
  function withLock(phone, fn) {
    const prev = (locks.get(phone) || Promise.resolve()).catch(() => {});
    const run = prev.then(fn);
    const guard = run.catch(() => {});
    locks.set(phone, guard);
    guard.finally(() => { if (locks.get(phone) === guard) locks.delete(phone); });
    return run;
  }

  function requireN8n(req, res, next) {
    if (!n8nSecret) return res.status(503).json({ error: "n8n_secret_not_configured" });
    if (!constantTimeEqual(req.get("x-forly-secret"), n8nSecret)) return res.status(403).json({ error: "forbidden" });
    next();
  }

  // Photos are re-hosted on Forly's store. The remote-store relay re-authorizes
  // with the caller's session; there is no browser here, so mint the agent's
  // own session for the hop (same trust as the agent uploading from the form).
  function importPhotoFor(phone) {
    const req = { headers: { cookie: `forly_session=${signSession(authSecret, phone)}` } };
    return async (url) => {
      const img = await importImage(url);
      await storeBuffer(img, { uploadDir, remoteUploadBase, req });
      return `${uploadPublicBase}/files/${img.fname}`;
    };
  }

  function depsFor(phone, business) {
    return {
      business, resolve, parseListing, quota,
      importPhoto: importPhotoFor(phone),
      createListing: (p, body) => createListing(p, body, null, { ...pipelineDeps, source: "whatsapp" }),
      createUrl: `${baseUrl}/create.html`,
      extractAllowed: (p) => limit.take(p),
    };
  }

  async function send(phone, reply) {
    if (reply.buttons && sendButtons) {
      try {
        await sendButtons(phone, {
          header: "Forly",
          body: reply.text,
          footer: "בחרו אפשרות",
          buttons: reply.buttons.map((b, i) => ({ buttonId: String(i + 1), buttonText: b })),
        });
        return;
      } catch (err) { console.warn("[whatsapp] buttons failed, sending plain:", err.message); }
    }
    await sendWhatsApp(phone, reply.text);
  }

  async function persistAndSend(phone, turn) {
    if (turn.del) await db.deleteDraft(phone);
    else if (turn.draft) await db.saveDraft(turn.draft);
    let replied = false;
    if (turn.replies.length && sendWhatsApp) {
      replied = true;
      for (let i = 0; i < turn.replies.length; i++) {
        try { await send(phone, turn.replies[i]); }
        catch (err) {
          replied = false;
          console.warn(`[whatsapp] ${phone} reply ${i + 1}/${turn.replies.length} failed (${JSON.stringify(turn.replies[i].text)}):`, err.message);
        }
      }
    }
    if (turn.armPhotoTimer) armTimer(phone);
    return replied;
  }

  function armTimer(phone) {
    clearTimeout(timers.get(phone));
    timers.set(phone, setTimeout(async () => {
      timers.delete(phone);
      try {
        await withLock(phone, async () => {
          const [business, draft] = await Promise.all([db.getBusiness(phone), db.getDraft(phone)]);
          if (!draft) return;
          const turn = await handleTurn({ phone, event: "photo_timer", draft }, depsFor(phone, business));
          if (turn.handled) await persistAndSend(phone, turn);
        });
      } catch (err) { console.error("[whatsapp] photo timer failed:", err); }
    }, PHOTO_BATCH_MS));
  }

  router.post("/intake", requireN8n, async (req, res) => {
    const body = req.body || {};
    const phone = normalizeAuthPhone(body.phone || "");
    const text = String(body.message || "").slice(0, MAX_TEXT);
    const fileUrl = typeof body.file_url === "string" && body.file_url.trim() ? body.file_url.trim() : null;
    const event = body.event === "photos_edited" ? "photos_edited" : null;
    const photos = Array.isArray(body.photos) ? body.photos.filter((p) => typeof p === "string").slice(0, 12) : [];
    if (!phone || (!text.trim() && !fileUrl && !event)) return res.status(400).json({ error: "invalid_input" });
    try {
      const result = await withLock(phone, async () => {
        const [business, draft] = await Promise.all([db.getBusiness(phone).catch(() => null), db.getDraft(phone)]);
        const now = new Date();
        console.log(
          `[whatsapp] ${phone} ← ${event ? `event:${event} photos=${photos.length}` : fileUrl ? "photo" : JSON.stringify(text)}` +
          ` | draft before: ${draft ? `${draft.status} (${draft.source}) updated_at=${new Date(asMillis(draft.updated_at)).toISOString()} silent_for_ms=${now.getTime() - asMillis(draft.updated_at)} paused=${isPaused(draft, now)}` : "none"}`
        );
        const turn = await handleTurn({ phone, text, fileUrl, event, photos, draft }, depsFor(phone, business));
        // A text that ends a photo batch must not be followed by the timer's report too.
        if (turn.handled && !turn.armPhotoTimer) { clearTimeout(timers.get(phone)); timers.delete(phone); }
        console.log(
          `[whatsapp] ${phone} → handled=${turn.handled} status=${turn.status}` +
          ` | draft after: ${turn.del ? "deleted" : turn.draft ? turn.draft.status : "unchanged"}` +
          ` | replies: ${turn.replies.length ? turn.replies.map((r) => JSON.stringify(r.text)).join(" | ") : "(none)"}`
        );
        const replied = turn.handled ? await persistAndSend(phone, turn) : false;
        console.log(`[whatsapp] ${phone} → ${turn.status} replied=${replied}${turn.listing_id ? ` ${turn.listing_id}` : ""}`);
        return {
          handled: turn.handled, status: turn.status,
          reply: turn.replies.map((r) => r.text).join("\n\n") || null,
          replied, listing_id: turn.listing_id || null,
        };
      });
      res.json(result);
    } catch (err) {
      console.error("[whatsapp] intake failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  return router;
};
