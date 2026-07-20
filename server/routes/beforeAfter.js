/*
 * routes/beforeAfter.js — "Before & After" video generator.
 *
 * Flow: agent uploads a "before" image (e.g. a floor plan) and optionally an
 * "after" image (the finished room). If no after image is given we generate one
 * with fal.ai GPT-Image, PAUSE for the agent to approve/regenerate, then build a
 * start→end-frame video with fal.ai Kling. Outputs are re-hosted locally and
 * (for logged-in agents) delivered on WhatsApp.
 *
 * Endpoints (mounted at /api/before-after):
 *   POST /create   { before_url, after_url?, description?, start?, duration? } → 202 { job_id, status }
 *   POST /approve  { job_id, action: "approve"|"regenerate", description? }    → 202 { job_id, status }
 *   GET  /status?id=…                                                          → { job_id, status, after_image_url, video_url, error }
 *
 * Async model mirrors the listings pipeline: a job doc holds the state, an
 * in-process loop polls the fal queue, and the client polls GET /status. A
 * heartbeat on the job doc lets GET /status revive a job whose poller died
 * (e.g. process restart) without ever running two finalizers to real effect.
 */

const express = require("express");
const crypto = require("crypto");

const db = require("../db");
const fal = require("../fal");
const { rehost, asMillis } = require("../utils");

const IMAGE_TIMEOUT_MS = 3 * 60 * 1000;
const VIDEO_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 4000;
const HEARTBEAT_STALE_MS = 45 * 1000; // no heartbeat for this long ⇒ poller is dead
const MAX_REGEN = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Inputs must be files uploaded through our own /api/upload-urls flow: a UUID
// filename under /files/ with an image extension. Keeps the endpoint from being
// used as an open "generate a video from any URL" proxy.
function isOwnUpload(u) {
  return typeof u === "string" &&
    /^https?:\/\//.test(u) &&
    /\/files\/[0-9a-f-]{36}\.(png|jpe?g|webp)$/i.test(u);
}

function buildAfterPrompt(desc) {
  const base = "Transform this architectural floor plan or unfinished, empty room into a " +
    "photorealistic, fully furnished and beautifully designed interior. Keep the room geometry, " +
    "proportions, camera angle, and window and door positions consistent with the input image.";
  const d = String(desc || "").trim();
  return d ? `${base} Style and details: ${d}` : base;
}

function buildVideoPrompt(desc) {
  const base = "Smooth cinematic transition that gradually reveals the finished, furnished interior. " +
    "Gentle camera motion, photorealistic, natural lighting.";
  const d = String(desc || "").trim();
  return d ? `${base} ${d}` : base;
}

const WA_CAPTION = "הסרטון \"לפני / אחרי\" שלך מוכן! 🎬\nYour before/after video is ready.";

module.exports = function createBeforeAfterRouter(ctx) {
  const {
    requireAuth, authSecret, falKey, uploadDir, baseUrl,
    klingModel, klingTailField, gptImageModel, sendWhatsAppFile,
  } = ctx;

  const router = express.Router();

  // Same demo-or-session gate as intake: an x-demo-key header (value unchecked,
  // matching the rest of the demo surface) OR a valid session cookie.
  function uploadAuth(req, res, next) {
    if ("x-demo-key" in req.headers) return next();
    return requireAuth(authSecret)(req, res, next);
  }

  function requireFal(res) {
    if (!falKey) { res.status(503).json({ error: "fal not configured" }); return false; }
    return true;
  }

  // ── fal stage helpers ────────────────────────────────────────────────

  async function failJob(jobId, msg) {
    await db.updateBaJob(jobId, {
      status: "failed",
      error: String(msg || "error").slice(0, 300),
      fal_stage: null, fal_status_url: null, fal_response_url: null, fal_request_id: null,
    });
  }

  // Poll the fal queue for the job's current stage until it completes, then hand
  // the result to onDone. Heartbeats the job doc each tick so GET /status can
  // tell a live poller from a dead one. Terminal failures mark the job failed.
  async function pollStage(jobId, timeoutMs, onDone) {
    const job = await db.getBaJob(jobId);
    if (!job || !job.fal_status_url) return;
    const statusUrl = job.fal_status_url, responseUrl = job.fal_response_url;
    const deadline = Date.now() + timeoutMs;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let r;
      try {
        r = await fal.checkOnce(statusUrl, responseUrl, falKey);
      } catch (e) {
        if (Date.now() > deadline) return failJob(jobId, e.message);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (r.done) {
        try { await onDone(jobId, r.result); }
        catch (e) { await failJob(jobId, e.message); }
        return;
      }
      if (Date.now() > deadline) return failJob(jobId, `fal timeout after ${Math.round(timeoutMs / 1000)}s`);
      await db.updateBaJob(jobId, { heartbeat_at: new Date() });
      await sleep(POLL_INTERVAL_MS);
    }
  }

  // Kick off the AI "after" image: submit to GPT-Image, then poll → after_ready.
  async function startAfterStage(jobId) {
    const job = await db.getBaJob(jobId);
    if (!job) return;
    const input = {
      prompt: buildAfterPrompt(job.description),
      image_urls: [job.before_url],
      num_images: 1,
    };
    const sub = await fal.submit(gptImageModel, input, falKey);
    await db.updateBaJob(jobId, {
      status: "generating_after", fal_stage: "image",
      fal_request_id: sub.request_id, fal_status_url: sub.status_url, fal_response_url: sub.response_url,
      heartbeat_at: new Date(),
    });
    await pollStage(jobId, IMAGE_TIMEOUT_MS, finishAfterStage);
  }

  async function finishAfterStage(jobId, result) {
    const url = result && result.images && result.images[0] && result.images[0].url;
    if (!url) throw new Error("gpt-image returned no image");
    const hosted = await rehost(url, `ba/${jobId}/after.png`, uploadDir, baseUrl);
    // Stop here — the agent approves (or regenerates) before we spend video credits.
    await db.updateBaJob(jobId, {
      status: "after_ready", after_image_url: hosted,
      fal_stage: null, fal_status_url: null, fal_response_url: null, fal_request_id: null,
    });
  }

  // Kick off the video: submit start+end frames to Kling, then poll → done.
  async function startVideoStage(jobId) {
    const job = await db.getBaJob(jobId);
    if (!job) return;
    const afterUrl = job.after_url || job.after_image_url;
    if (!afterUrl) throw new Error("no after image available for video");
    const startFrame = job.start === "after" ? afterUrl : job.before_url;
    const endFrame = job.start === "after" ? job.before_url : afterUrl;
    const input = {
      prompt: buildVideoPrompt(job.description),
      image_url: startFrame,
      duration: job.duration || "5",
      negative_prompt: "blur, distort, warp, low quality, morphing artifacts",
      cfg_scale: 0.5,
    };
    // End-frame field name varies by Kling version (tail_image_url on v1.6,
    // end_image_url on newer) — configurable so ops can switch models freely.
    input[klingTailField] = endFrame;
    const sub = await fal.submit(klingModel, input, falKey);
    await db.updateBaJob(jobId, {
      status: "generating_video", fal_stage: "video",
      fal_request_id: sub.request_id, fal_status_url: sub.status_url, fal_response_url: sub.response_url,
      heartbeat_at: new Date(),
    });
    await pollStage(jobId, VIDEO_TIMEOUT_MS, finishVideoStage);
  }

  async function finishVideoStage(jobId, result) {
    const prev = await db.getBaJob(jobId);
    if (!prev || prev.status === "done") return; // already finalized (idempotent guard)
    const url = result && result.video && result.video.url;
    if (!url) throw new Error("kling returned no video");
    const hosted = await rehost(url, `ba/${jobId}/video.mp4`, uploadDir, baseUrl);
    await db.updateBaJob(jobId, {
      status: "done", video_url: hosted,
      fal_stage: null, fal_status_url: null, fal_response_url: null, fal_request_id: null,
    });
    // Deliver to the agent's WhatsApp (best-effort; phone-less demo sessions skip).
    if (prev.business_phone && sendWhatsAppFile) {
      sendWhatsAppFile(prev.business_phone, hosted, "before-after.mp4", WA_CAPTION)
        .catch((e) => console.error(`BA whatsapp (${jobId}) failed:`, e.message));
    }
  }

  // Fire-and-forget a stage runner; any throw marks the job failed.
  function launch(fn, jobId) {
    Promise.resolve().then(() => fn(jobId)).catch((e) => {
      console.error(`BA job ${jobId} error:`, e.message);
      failJob(jobId, e.message).catch(() => {});
    });
  }

  // GET /status backstop: if a non-terminal job hasn't heartbeat in a while its
  // poller is gone (process restarted) — re-attach one. The heartbeat write
  // before launching narrows the double-launch window; finishVideoStage's guard
  // makes a double-finish harmless.
  function maybeResume(job) {
    if (!job) return;
    const inFlight = job.status === "generating_after" || job.status === "generating_video";
    if (!inFlight || !job.fal_status_url) return;
    const last = asMillis(job.heartbeat_at || job.updated_at);
    if (last && Date.now() - last < HEARTBEAT_STALE_MS) return; // a live poller is on it
    const isImage = job.fal_stage === "image";
    db.updateBaJob(job.job_id, { heartbeat_at: new Date() })
      .then(() => launch((id) => pollStage(id, isImage ? IMAGE_TIMEOUT_MS : VIDEO_TIMEOUT_MS,
        isImage ? finishAfterStage : finishVideoStage), job.job_id))
      .catch(() => {});
  }

  // ── routes ───────────────────────────────────────────────────────────

  router.post("/create", uploadAuth, async (req, res) => {
    if (!requireFal(res)) return;
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
      status: "queued",
      fal_stage: null, fal_request_id: null, fal_status_url: null, fal_response_url: null,
      after_image_url: null, video_url: null, error: null,
      regen_count: 0,
      heartbeat_at: now, created_at: now, updated_at: now,
    };
    await db.saveBaJob(job);

    // No after image → generate one and pause for approval. Both supplied → straight to video.
    launch(afterUrl === null ? startAfterStage : startVideoStage, jobId);
    res.status(202).json({ job_id: jobId, status: "queued" });
  });

  router.post("/approve", uploadAuth, async (req, res) => {
    if (!requireFal(res)) return;
    const body = req.body || {};
    const jobId = String(body.job_id || "");
    const action = body.action === "regenerate" ? "regenerate" : "approve";
    const job = await db.getBaJob(jobId);
    if (!job) return res.status(404).json({ error: "job not found" });
    if (job.status !== "after_ready") {
      return res.status(409).json({ error: `job is ${job.status}, not awaiting approval` });
    }

    if (action === "approve") {
      await db.updateBaJob(jobId, { status: "queued" });
      launch(startVideoStage, jobId);
      return res.status(202).json({ job_id: jobId, status: "queued" });
    }

    // regenerate: optionally update the description, re-run the after stage.
    if ((job.regen_count || 0) >= MAX_REGEN) {
      return res.status(429).json({ error: "regeneration limit reached" });
    }
    const patch = { status: "queued", regen_count: (job.regen_count || 0) + 1, after_image_url: null };
    if (typeof body.description === "string") patch.description = body.description.slice(0, 1500);
    await db.updateBaJob(jobId, patch);
    launch(startAfterStage, jobId);
    res.status(202).json({ job_id: jobId, status: "queued" });
  });

  router.get("/status", async (req, res) => {
    const id = typeof req.query.id === "string" ? req.query.id : "";
    if (!id) return res.status(400).json({ error: "missing id" });
    const job = await db.getBaJob(id);
    if (!job) return res.status(404).json({ error: "not found" });
    try { maybeResume(job); } catch { /* best-effort revive; never break status */ }
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
