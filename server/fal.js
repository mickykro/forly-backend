/*
 * fal.js — minimal fal.ai queue client (no SDK dependency).
 *
 * fal's queue API: submit a job, then poll the returned status_url until it
 * reports COMPLETED, then GET the response_url for the model output. We use the
 * status_url / response_url returned by submit VERBATIM — for nested endpoint
 * ids (e.g. fal-ai/kling-video/v1.6/pro/image-to-video) fal's status/response
 * URLs live under the base app id (…/fal-ai/kling-video/requests/{id}/…), so
 * reconstructing them by string-concat would break.
 *
 * Docs: https://docs.fal.ai/model-endpoints/queue
 */

const QUEUE_BASE = "https://queue.fal.run";

function authHeaders(falKey) {
  return { Authorization: `Key ${falKey}`, "Content-Type": "application/json" };
}

// Submit a job to the queue. Returns { request_id, status_url, response_url }.
async function submit(model, input, falKey) {
  const resp = await fetch(`${QUEUE_BASE}/${model}`, {
    method: "POST",
    headers: authHeaders(falKey),
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`fal submit ${model} → ${resp.status}: ${errText(data)}`);
  }
  if (!data.status_url || !data.response_url) {
    throw new Error(`fal submit ${model}: missing status/response url`);
  }
  return data;
}

// One non-blocking status check. Returns { status, done, result?, error? }.
// `result` is populated (via response_url) only when status === COMPLETED.
async function checkOnce(statusUrl, responseUrl, falKey) {
  const resp = await fetch(statusUrl, {
    method: "GET",
    headers: authHeaders(falKey),
    signal: AbortSignal.timeout(20000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`fal status → ${resp.status}: ${errText(data)}`);
  const status = data.status || "UNKNOWN";
  if (status === "COMPLETED") {
    const rr = await fetch(responseUrl, {
      method: "GET",
      headers: authHeaders(falKey),
      signal: AbortSignal.timeout(30000),
    });
    const result = await rr.json().catch(() => ({}));
    if (!rr.ok) throw new Error(`fal response → ${rr.status}: ${errText(result)}`);
    return { status, done: true, result };
  }
  // fal uses IN_QUEUE / IN_PROGRESS for pending; anything else non-terminal is
  // treated as still-running until the timeout budget runs out.
  return { status, done: false };
}

// Poll status_url until COMPLETED (or timeout). Returns the model output JSON.
async function pollUntilDone(statusUrl, responseUrl, falKey, opts) {
  opts = opts || {};
  const intervalMs = opts.intervalMs || 4000;
  const timeoutMs = opts.timeoutMs || 10 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await checkOnce(statusUrl, responseUrl, falKey);
    if (r.done) return r.result;
    if (Date.now() > deadline) throw new Error(`fal poll timeout after ${Math.round(timeoutMs / 1000)}s (last status ${r.status})`);
    await sleep(intervalMs);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// fal errors arrive in a few shapes: {detail:"..."} , {detail:[{msg}]}, {error}.
function errText(data) {
  if (!data) return "unknown";
  if (typeof data.detail === "string") return data.detail;
  if (Array.isArray(data.detail)) return data.detail.map((d) => d.msg || JSON.stringify(d)).join("; ");
  if (data.error) return String(data.error);
  return JSON.stringify(data).slice(0, 200);
}

module.exports = { submit, checkOnce, pollUntilDone };
