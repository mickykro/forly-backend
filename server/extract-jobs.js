/*
 * extract-jobs.js — queued browser scrapes.
 *
 * A Firecrawl scrape answers inside one HTTP request; a browser scrape takes
 * 30–90s (session start, render, network idle) and would hold a Cloud Run
 * request open the whole time. So the route queues a job and the wizard polls.
 *
 * The state is in Firestore rather than in process because Cloud Run runs many
 * instances: the poll that follows a POST usually lands somewhere else.
 *
 * Lifecycle: queued → running → done | failed.
 *
 * Retry policy mirrors driver-browser.js: only what time or a different
 * browser type can fix gets another attempt. A login wall and an out-of-credits
 * account both need a PERSON, so they fail on the first try.
 */
const crypto = require("crypto");

const MAX_ATTEMPTS = 3;
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Every query costs at least one Firestore read even when empty: at 5s this loop
// alone used ~52k reads/day and exhausted the quota (28 Oct 2026). A new job
// kicks a sweep itself (create), so the interval is only the retry backstop.
const SWEEP_MS = 60 * 1000;
// Each rung looks less like automation than the last, and costs more. Start cheap.
const BROWSER_LADDER = ["hosted", "hosted_stealth", "hosted_privacy"];
// Terminal on the first attempt — retrying cannot change the answer.
const TERMINAL_CODES = new Set(["social_login_required", "invalid_input", "extract_unavailable"]);

const nowIso = () => new Date().toISOString();

// draftId: set only by listing-sweep.js (Phase 4). A drafted job's result is
// written to the draft on `done` instead of being polled by a wizard — see
// runJobLocked below.
// profileOwner: whose profile a /reel promo job opens (the scrape admin); the
// job itself stays the visitor's. Null → the job's own phone.
async function create({ phone, url, forceSource = null, profileName = null, profileOwner = null, draftId = null }, deps) {
  const created = new Date();
  const job = {
    id: crypto.randomUUID(),
    phone: String(phone),
    url: String(url),
    status: "queued",
    attempts: 0,
    force_source: forceSource,
    profile_name: profileName,
    profile_owner: profileOwner,
    draft_id: draftId,
    created_at: created.toISOString(),
    updated_at: created.toISOString(),
    result: null,
    error_code: null,
    // Retention (Task 21): Firestore's TTL policy on expire_at deletes the job
    // 7 days after it was created. A Date, so it is stored as a Timestamp.
    expire_at: new Date(created.getTime() + JOB_RETENTION_MS),
  };
  await deps.db.saveExtractJob(job);
  if (kick) kick();
  return job;
}

// Driver's own HTTP statuses reach us on the error; map them to the stable
// codes the route already knows, so no vendor text ever reaches an agent.
// DriverError carries the VENDOR body's `code` (e.g. "insufficient_credits"),
// so the status check must come first or that string leaks into error_code.
const OURS = new Set(["page_unreadable", "social_login_required", "invalid_input", "extract_unavailable"]);
function codeFor(err) {
  if (typeof err.status === "number") {
    if (err.status === 402 || err.status === 403 || err.status === 503 || err.status === 401) return "extract_unavailable";
    return "page_unreadable";
  }
  return OURS.has(err.code) ? err.code : "page_unreadable";
}

// Anything left "running" past its maximum lifetime died with the process.
// Without this, DRIVER_MAX_CONCURRENT such ghosts wedge the queue for good.
const STALE_MS = 5 * 60 * 1000;
// → the jobs still running, so the sweep need not query them again.
async function reapStale(deps, now = new Date()) {
  const running = await deps.db.listExtractJobsByStatus("running", 50);
  const live = [];
  for (const j of running) {
    if (now.getTime() - new Date(j.updated_at || 0).getTime() < STALE_MS) { live.push(j); continue; }
    const dead = (j.attempts || 0) >= MAX_ATTEMPTS;
    await deps.db.updateExtractJob(j.id, { status: dead ? "failed" : "queued", error_code: dead ? "page_unreadable" : j.error_code || null, updated_at: nowIso() });
  }
  return live;
}

async function runJob(job, deps) {
  // A persisted profile is one browser at a time, across extract, connect and
  // posting — the same lock every one of them takes (profile-lock.js). An
  // extract job only ever carries a profile for a Facebook group read.
  const locks = deps.locks || require("./profile-lock");
  const release = job.profile_name ? locks.tryAcquire(job.profile_owner || job.phone, "facebook") : () => {};
  if (job.profile_name && !release) return job; // someone else has the profile open; next sweep
  try {
    return await runJobLocked(job, deps);
  } finally { release(); }
}

async function runJobLocked(job, deps) {
  const attempt = (job.attempts || 0) + 1;
  const browserType = BROWSER_LADDER[Math.min(attempt, BROWSER_LADDER.length) - 1];
  await deps.db.updateExtractJob(job.id, { status: "running", attempts: attempt, updated_at: nowIso() });

  try {
    // A job with a profile opens the agent's CURRENT profile (I2): the name
    // is the stored name, or derived again from the connection's generation; the connection
    // goes to withPage, which refuses a revoked or quarantined profile.
    const owner = job.profile_owner || job.phone;
    let profileName = job.profile_name || null, conn = null;
    if (profileName) {
      conn = (await deps.db.getConnection(owner)) || {};
      const platform = String(profileName).split("-")[0];
      profileName = require("./profile-name").profileNameFor(platform, owner, conn);
    }
    const source = await deps.resolve(
      { url: job.url, userId: job.phone },
      {
        forceSource: job.force_source || "driver", browserType, profileName, jobId: job.id,
        // runJob already holds (phone, "facebook") when there is a profile.
        phone: owner, platform: "facebook", lockHeld: !!job.profile_name, conn,
      },
    );
    const parsed = await deps.parseListing(source.text);
    const patch = {
      status: "done",
      error_code: null,
      updated_at: nowIso(),
      result: {
        source: source.source,
        description: source.description || "",
        photos: source.photos || [],
        fields: parsed.fields,
        missing: parsed.missing,
      },
    };
    console.log(`[extract job ${job.id}] scan result:`, JSON.stringify(patch.result, null, 2));
    await deps.db.updateExtractJob(job.id, patch);
    if (job.draft_id) {
      await deps.db.updateListingDraft(job.draft_id, { status: "ready", extract: patch.result, updated_at: nowIso() })
        .catch((e) => console.warn(`draft ${job.draft_id} extract writeback failed: ${e.message}`));
    }
    return Object.assign({}, job, patch, { attempts: attempt });
  } catch (err) {
    const code = codeFor(err);
    const terminal = TERMINAL_CODES.has(code) || attempt >= MAX_ATTEMPTS;
    const patch = {
      status: terminal ? "failed" : "queued",
      error_code: code,
      updated_at: nowIso(),
    };
    await deps.db.updateExtractJob(job.id, patch);
    if (job.draft_id && terminal) {
      await deps.db.updateListingDraft(job.draft_id, { status: "extract_failed", error_code: code, updated_at: nowIso() })
        .catch((e) => console.warn(`draft ${job.draft_id} extract-failure writeback failed: ${e.message}`));
    }
    return Object.assign({}, job, patch, { attempts: attempt });
  }
}

/*
 * One pass: start as many queued jobs as the concurrency budget allows. The
 * budget is the Driver plan's concurrent_browsers minus what posting and the
 * login browser are using — one process, so profile-lock.js knows exactly.
 */
let sweeping = false; // in-process latch: one container, overlapping sweeps are the only race
async function sweep(deps) {
  if (sweeping) return 0;
  sweeping = true;
  try { return await sweepOnce(deps); } finally { sweeping = false; }
}
async function sweepOnce(deps) {
  const running = await reapStale(deps);
  const cap = deps.maxConcurrent || Number(process.env.DRIVER_MAX_CONCURRENT || 2);
  const budget = cap - running.length;
  if (budget <= 0) return 0;
  const queued = await deps.db.listExtractJobsByStatus("queued", budget);
  const run = deps.runJob || runJob;
  for (const job of queued) {
    // Deliberately not awaited: the sweep starts jobs, it does not wait on them.
    // Driver error text is vendor text: it goes through the same redaction.
    Promise.resolve(run(job, deps)).catch((e) => console.error(`extract job ${job.id} crashed: ${require("./driver-browser").redact(require("./driver-browser").describeError(e))}`));
  }
  return queued.length;
}

let kick = null; // set by startSweeper: a new job starts now, not at the next interval
function startSweeper(deps) {
  const every = deps.sweepMs || SWEEP_MS;
  const run = () => { sweep(deps).catch((e) => console.error(`extract sweep failed: ${e.message}`)); };
  kick = run;
  const t = setInterval(run, every);
  if (t.unref) t.unref();
  return () => { clearInterval(t); kick = null; };
}

function liveDeps() {
  return {
    db: require("./db"),
    resolve: require("./listing-sources").resolve,
    parseListing: require("./listing-extract").parseListing,
  };
}

module.exports = { create, runJob, reapStale, sweep, startSweeper, liveDeps, MAX_ATTEMPTS, SWEEP_MS, BROWSER_LADDER };
