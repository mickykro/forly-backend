/*
 * routes/beforeAfter.js — "Before & After" video generator.
 *
 * The generation itself runs in an n8n workflow (visible per-node), not here.
 * This router owns the job doc + the agent-facing API; it fires the n8n webhook
 * to do the fal.ai work and exposes a callback n8n posts results to.
 *
 * Flow: agent uploads a "before" image (e.g. a floor plan), one at a time, and
 * optionally an "after" image. No after image → n8n generates one with GPT-Image;
 * the agent approves/regenerates before we spend video credits; then n8n builds a
 * start→end-frame video with Kling. Finished media is re-hosted here and (for
 * logged-in agents) delivered on WhatsApp.
 *
 * Endpoints (mounted at /api/before-after):
 *   POST /create    { before_url, after_url?, description?, start?, duration? } → 202 { job_id, status }
 *   POST /approve   { job_id, action: "approve"|"regenerate", description? }    → 202 { job_id, status }
 *   POST /callback  { job_id, stage: "after"|"video", media_url?, error?, secret } (called by n8n)
 *   GET  /status?id=…                                                           → { job_id, status, after_image_url, video_url, error }
 *
 * n8n contract (webhook payload we POST):
 *   generate_after: { stage, job_id, before_url, description, callback_url, callback_secret }
 *   generate_video: { stage, job_id, start_frame_url, end_frame_url, description, duration, callback_url, callback_secret }
 */

const express = require("express");
const crypto = require("crypto");

const db = require("../db");
const { rehost, asMillis } = require("../utils");

const MAX_REGEN = 5;
// If n8n never calls back (workflow error, credential missing), a job stuck this
// long is reported failed so the UI stops spinning. n8n has no live poller here.
const JOB_TIMEOUT_MS = 15 * 60 * 1000;

// Inputs must be files uploaded through our own /api/upload-urls flow: a UUID
// filename under /files/ with an image extension. Keeps the endpoint from being
// used as an open "generate a video from any URL" proxy.
function isOwnUpload(u) {
  return typeof u === "string" &&
    /^https?:\/\//.test(u) &&
    /\/files\/[0-9a-f-]{36}\.(png|jpe?g|webp)$/i.test(u);
}

module.exports = function createBeforeAfterRouter(ctx) {
  const { requireAuth, authSecret, n8nWebhookUrl, callbackSecret, uploadDir, baseUrl, sendWhatsAppFile } = ctx;

  const router = express.Router();

  // Same demo-or-session gate as intake: an x-demo-key header (value unchecked,
  // matching the rest of the demo surface) OR a valid session cookie.
  function uploadAuth(req, res, next) {
    if ("x-demo-key" in req.headers) return next();
    return requireAuth(authSecret)(req, res, next);
  }

  function requireN8n(res) {
    if (!n8nWebhookUrl) { res.status(503).json({ error: "before/after generator not configured" }); return false; }
    return true;
  }

  const failJob = (jobId, msg) =>
    db.updateBaJob(jobId, { status: "failed", error: String(msg || "error").slice(0, 300) });

  // Fire the n8n webhook (fire-and-forget). On network failure the job is marked
  // failed so the client's /status poll surfaces it instead of hanging.
  function fireN8n(jobId, payload) {
    fetch(n8nWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    })
      .then((r) => { if (!r.ok) throw new Error(`n8n webhook → ${r.status}`); })
      .catch((err) => {
        console.error(`BA n8n webhook (${jobId}) failed:`, err.message);
        failJob(jobId, `could not start generation: ${err.message}`).catch(() => {});
      });
  }

  const callbackUrl = () => `${baseUrl}/api/before-after/callback`;

  function fireAfterStage(job) {
    fireN8n(job.job_id, {
      stage: "generate_after",
      job_id: job.job_id,
      before_url: job.before_url,
      description: job.description || "",
      callback_url: callbackUrl(),
      callback_secret: callbackSecret,
    });
  }

  function fireVideoStage(job) {
    const afterUrl = job.after_url || job.after_image_url;
    const startFrame = job.start === "after" ? afterUrl : job.before_url;
    const endFrame = job.start === "after" ? job.before_url : afterUrl;
    fireN8n(job.job_id, {
      stage: "generate_video",
      job_id: job.job_id,
      start_frame_url: startFrame,
      end_frame_url: endFrame,
      description: job.description || "",
      duration: job.duration || "5",
      callback_url: callbackUrl(),
      callback_secret: callbackSecret,
    });
  }

  // ── routes ───────────────────────────────────────────────────────────

  router.post("/create", uploadAuth, async (req, res) => {
    if (!requireN8n(res)) return;
    const body = req.body || {};

    if (!isOwnUpload(body.before_url)) {
      return res.status(400).json({ error: "valid before_url (an uploaded image) required" });
    }
    // Empty/whitespace after_url means "no after image — generate one", same as omitting it.
    const afterUrl = (typeof body.after_url === "string" && body.after_url.trim()) ? body.after_url : null;
    if (afterUrl !== null && !isOwnUpload(afterUrl)) {
      return res.status(400).json({ error: "after_url must be an uploaded image" });
    }
    const start = body.start === "after" ? "after" : "before";
    const duration = body.duration === "10" ? "10" : "5";
    const description = String(body.description || "").slice(0, 1500);

    const jobId = crypto.randomUUID();
    const now = new Date();
    const job = {
      job_id: jobId,
      business_phone: (req.user && req.user.userId) || null,
      source: "x-demo-key" in req.headers ? "demo" : "dashboard",
      before_url: body.before_url,
      after_url: afterUrl,
      after_generated: afterUrl === null,
      description, start, duration,
      status: afterUrl === null ? "generating_after" : "generating_video",
      after_image_url: null, video_url: null, error: null,
      regen_count: 0,
      created_at: now, updated_at: now,
    };
    await db.saveBaJob(job);

    // No after image → generate one and pause for approval. Both supplied → straight to video.
    if (afterUrl === null) fireAfterStage(job);
    else fireVideoStage(job);
    res.status(202).json({ job_id: jobId, status: job.status });
  });

  router.post("/approve", uploadAuth, async (req, res) => {
    if (!requireN8n(res)) return;
    const body = req.body || {};
    const jobId = String(body.job_id || "");
    const action = body.action === "regenerate" ? "regenerate" : "approve";
    const job = await db.getBaJob(jobId);
    if (!job) return res.status(404).json({ error: "job not found" });
    if (job.status !== "after_ready") {
      return res.status(409).json({ error: `job is ${job.status}, not awaiting approval` });
    }

    if (action === "approve") {
      const updated = await db.updateBaJob(jobId, { status: "generating_video" });
      fireVideoStage(updated);
      return res.status(202).json({ job_id: jobId, status: "generating_video" });
    }

    // regenerate: optionally update the description, re-run the after stage.
    if ((job.regen_count || 0) >= MAX_REGEN) {
      return res.status(429).json({ error: "regeneration limit reached" });
    }
    const patch = { status: "generating_after", regen_count: (job.regen_count || 0) + 1, after_image_url: null };
    if (typeof body.description === "string") patch.description = body.description.slice(0, 1500);
    const updated = await db.updateBaJob(jobId, patch);
    fireAfterStage(updated);
    res.status(202).json({ job_id: jobId, status: "generating_after" });
  });

  // Called by the n8n workflow when a stage finishes. Verified by a shared secret.
  router.post("/callback", async (req, res) => {
    const body = req.body || {};
    if (!callbackSecret || body.secret !== callbackSecret) {
      return res.status(401).json({ error: "bad secret" });
    }
    const jobId = String(body.job_id || "");
    const job = await db.getBaJob(jobId);
    if (!job) return res.status(404).json({ error: "job not found" });

    if (body.error) {
      await failJob(jobId, body.error);
      return res.json({ ok: true });
    }
    const mediaUrl = body.media_url;
    if (typeof mediaUrl !== "string" || !/^https?:\/\//.test(mediaUrl)) {
      return res.status(400).json({ error: "media_url required" });
    }

    try {
      if (body.stage === "after") {
        const hosted = await rehost(mediaUrl, `ba/${jobId}/after.png`, uploadDir, baseUrl);
        // Stop here — the agent approves (or regenerates) before we spend video credits.
        await db.updateBaJob(jobId, { status: "after_ready", after_image_url: hosted });
      } else if (body.stage === "video") {
        const prev = await db.getBaJob(jobId);
        if (prev && prev.status === "done") return res.json({ ok: true }); // idempotent
        const hosted = await rehost(mediaUrl, `ba/${jobId}/video.mp4`, uploadDir, baseUrl);
        await db.updateBaJob(jobId, { status: "done", video_url: hosted });
        if (job.business_phone && sendWhatsAppFile) {
          sendWhatsAppFile(job.business_phone, hosted, "before-after.mp4",
            "הסרטון \"לפני / אחרי\" שלך מוכן! 🎬\nYour before/after video is ready.")
            .catch((e) => console.error(`BA whatsapp (${jobId}) failed:`, e.message));
        }
      } else {
        return res.status(400).json({ error: "unknown stage" });
      }
    } catch (err) {
      await failJob(jobId, err.message);
      return res.status(500).json({ error: "rehost failed" });
    }
    res.json({ ok: true });
  });

  router.get("/status", async (req, res) => {
    const id = typeof req.query.id === "string" ? req.query.id : "";
    if (!id) return res.status(400).json({ error: "missing id" });
    let job = await db.getBaJob(id);
    if (!job) return res.status(404).json({ error: "not found" });

    // No live poller here — if n8n never calls back, fail the job on age so the UI stops.
    const inFlight = job.status === "generating_after" || job.status === "generating_video" || job.status === "queued";
    if (inFlight && Date.now() - asMillis(job.updated_at) > JOB_TIMEOUT_MS) {
      job = await failJob(id, "generation timed out");
    }
    res.json({
      job_id: id,
      status: job.status,
      after_generated: !!job.after_generated,
      before_url: job.before_url,
      after_image_url: job.after_url || job.after_image_url || null,
      video_url: job.video_url || null,
      error: job.error || null,
    });
  });

  return router;
};
