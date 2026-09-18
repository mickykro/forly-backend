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
 *
 *   GET  /api/whatsapp/review?t=<signed session>   the "confirm" reply's link
 *     Signs the agent's browser in (same as OTP login) and redirects to
 *     create.html?whatsapp=1. No x-forly-secret gate: opened by the agent.
 *   GET  /api/whatsapp/draft                        forly_session cookie
 *     → 200 { fields, photos } | 404 no_draft. create.html's prefill reads
 *     this once signed in via /review; the agent reviews, edits and builds
 *     the page themselves there — whatsapp-intake.js never builds it.
 */
const express = require("express");
const { constantTimeEqual } = require("../security");
const db = require("../db");
const { handleTurn } = require("../whatsapp-intake");
const { isPaused, asMillis, touch } = require("../property-draft");
const R = require("../whatsapp-replies");
const { resolve } = require("../listing-sources");
const { parseListing } = require("../listing-extract");
const { importImage, DailyLimit } = require("./extract");
const { storeBuffer } = require("../upload-store");
const { validateListing, createListing } = require("../listing-create");
const { verifySession, requireAuth, readToken, REVIEW_SCOPES } = require("../auth");

const REVIEW_TTL_S = 7 * 24 * 60 * 60;
const EXPIRED_PAGE = `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Forly</title>
<body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;text-align:center">
<h1 style="font-size:1.4rem">הקישור פג תוקף</h1>
<p>כתבו ״תצוגה מקדימה״ בצ׳אט עם פורלי ותקבלו קישור חדש.</p></body></html>`;

const BUILD_TIMEOUT_MS = 20 * 60 * 1000; // a chat listing with no page after this has failed
const SWEEP_MS = 5 * 60 * 1000;

// Voice note → Hebrew text with fal's Whisper ("wizper"). Notes are short, so the
// synchronous endpoint is enough (overlay.js uses fal the same way, plain fetch).
async function transcribe(audioUrl, { fetchFn = fetch, key = process.env.FAL_KEY } = {}) {
  if (!key) throw new Error("FAL_KEY not set");
  const r = await fetchFn("https://fal.run/fal-ai/wizper", {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ audio_url: audioUrl, task: "transcribe", language: "he" }),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error(`wizper ${r.status}`);
  const j = await r.json();
  return String(j.text || "").trim() || null;
}

const EXTRACT_CAP = 20;          // link/text extractions per agent per day
const PHOTO_BATCH_MS = 20000;
const MAX_TEXT = 4000;

module.exports = function createWhatsappRouter(ctx) {
  const { n8nSecret, normalizeAuthPhone, signSession, authSecret, sendWhatsApp, sendButtons,
    uploadDir, uploadPublicBase, remoteUploadBase, baseUrl, quota, pipelineDeps } = ctx;
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

  // Diagnostics only — must never be able to throw and fail the request
  // (an unreadable updated_at would make toISOString() throw a RangeError).
  function describeAge(draft, now) {
    try {
      const ms = asMillis(draft.updated_at);
      const at = Number.isFinite(ms) ? new Date(ms).toISOString() : `unreadable(${JSON.stringify(draft.updated_at)})`;
      return `updated_at=${at} silent_for_ms=${now.getTime() - ms} paused=${isPaused(draft, now)}`;
    } catch (err) { return `age=? (${err.message})`; }
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
      business, resolve, parseListing,
      importPhoto: importPhotoFor(phone),
      createUrl: `${baseUrl}/create.html`,
      extractAllowed: (p) => limit.take(p),
      // /review signs the agent straight into create.html (same trust as
      // importPhotoFor's server-side session above, just handed to their
      // browser instead) prefilled from their draft; they review, edit and
      // build the page themselves there — see the /review and /draft routes.
      reviewLink: (p) => `${baseUrl}/api/whatsapp/review?t=${encodeURIComponent(signSession(authSecret, p, { scope: "review", ttlS: REVIEW_TTL_S }))}`,
      // "ליצור" in chat: same validation and paid quota unit as the form's /properties/create.
      transcribe,
      createListing: async (body) => {
        const invalid = validateListing(body);
        if (invalid) return invalid;
        if (quota) {
          const q = await quota.consume(phone, "walkthroughs", 1, { source: "whatsapp", business,
            request: { address: body.address, city: body.city, price: body.price, rooms: body.rooms, photos: body.photos_urls.length } });
          if (!q.ok) return { error: "quota", code: 402, message: q.message };
        }
        return createListing(phone, body, null, { ...pipelineDeps, source: "whatsapp" });
      },
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

  // A chat listing whose page never arrived: mark it failed and tell the agent.
  // A draft that built it goes back to the preview/create question, so "ליצור" retries.
  async function sweepStuckBuilds(now = Date.now()) {
    const pending = await db.listPendingListings("whatsapp");
    for (const l of pending) {
      const age = now - asMillis(l.created_at);
      if (!(age > BUILD_TIMEOUT_MS)) continue;
      await db.updateListing(l.listing_id, { status: "failed" });
      if (age > 24 * 60 * 60 * 1000) continue; // older than a day: close it quietly
      const phone = l.business_phone;
      await withLock(phone, async () => {
        const draft = await db.getDraft(phone);
        const retry = !!draft && draft.status === "building" && draft.listing_id === l.listing_id;
        if (retry) {
          Object.assign(draft, { status: "active", mode: null, listing_id: null });
          await db.saveDraft(touch(draft));
        }
        if (sendWhatsApp) await sendWhatsApp(phone, R.buildFailed(retry, l).text);
      });
      console.warn(`[whatsapp] ${phone} listing ${l.listing_id} build timed out → failed`);
    }
  }
  if (ctx.sweep !== false) {
    setInterval(() => sweepStuckBuilds().catch((err) => console.error("[whatsapp] build sweep failed:", err.message)), SWEEP_MS).unref();
  }

  router.post("/intake", requireN8n, async (req, res) => {
    const body = req.body || {};
    const phone = normalizeAuthPhone(body.phone || "");
    const text = String(body.message || "").slice(0, MAX_TEXT);
    const fileUrl = typeof body.file_url === "string" && body.file_url.trim() ? body.file_url.trim() : null;
    // Main Router debounces a burst of photos sent together into one webhook
    // (file_urls); a single photo still arrives as file_url.
    const fileUrls = Array.isArray(body.file_urls) ? body.file_urls.filter((u) => typeof u === "string" && u.trim()).map((u) => u.trim()).slice(0, 12) : [];
    const event = body.event === "photos_edited" ? "photos_edited" : null;
    const photos = Array.isArray(body.photos) ? body.photos.filter((p) => typeof p === "string").slice(0, 12) : [];
    const audioUrl = typeof body.audio_url === "string" && /^https:\/\//.test(body.audio_url) ? body.audio_url : null;
    const messageType = typeof body.message_type === "string" ? body.message_type.slice(0, 40) : "";
    if (!phone || (!text.trim() && !fileUrl && !fileUrls.length && !event && !audioUrl && messageType !== "documentMessage")) {
      return res.status(400).json({ error: "invalid_input" });
    }
    try {
      const result = await withLock(phone, async () => {
        const [business, draft] = await Promise.all([db.getBusiness(phone).catch(() => null), db.getDraft(phone)]);
        const now = new Date();
        console.log(
          `[whatsapp] ${phone} ← ${event ? `event:${event} photos=${photos.length}` : fileUrls.length ? `photos(${fileUrls.length})` : fileUrl ? "photo" : audioUrl ? "voice" : messageType === "documentMessage" ? "document" : JSON.stringify(text)}` +
          ` | draft before: ${draft ? `${draft.status} (${draft.source}) ${describeAge(draft, now)}` : "none"}`
        );
        const turn = await handleTurn({ phone, text, fileUrl, fileUrls, event, photos, audioUrl, messageType, draft }, depsFor(phone, business));
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

  // A WhatsApp-delivered magic link (see depsFor's reviewLink): signs the
  // agent's browser in exactly as OTP login does, then sends them to the
  // prefilled create form. No x-forly-secret gate here — this is opened by
  // the agent's own browser, not called by n8n.
  router.get("/review", (req, res) => {
    const token = typeof req.query.t === "string" ? req.query.t : "";
    const payload = verifySession(authSecret, token, ["review"]);
    if (!payload || !payload.userId) return res.status(401).type("html").send(EXPIRED_PAGE);
    // Already logged in as this agent: keep the full session, don't downgrade it to review scope.
    const current = verifySession(authSecret, readToken(req));
    if (current && current.userId === payload.userId) return res.redirect(`${baseUrl}/create.html?whatsapp=1`);
    res.cookie("forly_session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: Math.max(0, payload.exp * 1000 - Date.now()),
    });
    res.redirect(`${baseUrl}/create.html?whatsapp=1`);
  });

  // create.html reads this once signed in via /review, to prefill the form
  // with whatever the chat has collected so far.
  router.get("/draft", requireAuth(authSecret, REVIEW_SCOPES), async (req, res) => {
    const draft = await db.getDraft(req.user.userId);
    if (!draft) return res.status(404).json({ error: "no_draft" });
    res.json({ fields: draft.fields, photos: draft.photos });
  });

  router.sweepStuckBuilds = sweepStuckBuilds; // exposed for tests
  return router;
};
module.exports.transcribe = transcribe;
