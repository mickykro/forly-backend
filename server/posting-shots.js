/*
 * posting-shots.js — a screenshot of the Facebook page when a post attempt
 * fails, to see what went wrong. FORLY_ENV=local or staging only (never
 * prod: a screenshot of an agent's Facebook carries other people's names and
 * posts); POSTING_SHOTS=0 turns it off there too.
 *
 * Kept on this server's disk only (POSTING_SHOTS_DIR, default a temp dir):
 * the newest MAX_SHOTS, at most MAX_AGE_MS old. Each shot is <id>.jpg plus
 * <id>.json { id, at, kind, error_code, step, image, check, diag, facts, key_tail, campaign_id, phone_tail }
 * — no full phone, no URL, no profile name. Best-effort: a failed capture
 * never changes the attempt's outcome, and never throws.
 * Served to an admin by routes/driver-shots.js (/dev-driver.html shows them).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const MAX_SHOTS = 50;
const MAX_AGE_MS = 3 * 24 * 3600 * 1000;
const CAPTURE_TIMEOUT_MS = 10000;
const ID_RE = /^[0-9]{13}-[0-9a-f]{8}$/;

const enabled = (env = process.env) => ["local", "staging"].includes(env.FORLY_ENV) && env.POSTING_SHOTS !== "0";
const dirOf = (env = process.env) => env.POSTING_SHOTS_DIR || path.join(os.tmpdir(), "forly-driver-shots");
let last = 0;
// A diagnostic as plain JSON, every string clipped, at most ~8 KB — never a cycle or a Buffer.
function bounded(v) {
  if (v == null) return null;
  try {
    const s = JSON.stringify(v, (k, x) => (typeof x === "string" && x.length > 200 ? `${x.slice(0, 200)}…` : x));
    return s && s.length <= 8192 ? JSON.parse(s) : { truncated: true };
  } catch { return null; }
}
const tail = (s, n = 6) => (s ? `…${String(s).slice(-n)}` : null);

// → the entry's id, or null (off, or the write failed). No page (a failure
// before any browser opened, e.g. the video could not be fetched): the note
// alone, image: false — the list still says what went wrong.
async function capture(page, meta = {}, env = process.env) {
  if (!enabled(env)) return null;
  try {
    const dir = dirOf(env);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const now = last = Math.max(Date.now(), last + 1); // strictly increasing: the list's newest-first order holds
    const id = `${now}-${crypto.randomBytes(4).toString("hex")}`;
    let image = false;
    if (page && typeof page.screenshot === "function") {
      let timer;
      const shot = await Promise.race([
        page.screenshot({ type: "jpeg", quality: 60, fullPage: false }),
        new Promise((_, no) => { timer = setTimeout(() => no(new Error("timeout")), CAPTURE_TIMEOUT_MS); }),
      ]).finally(() => clearTimeout(timer)).catch((e) => { console.error(`posting shot: ${(e && (e.code || e.name)) || "error"}`); return null; });
      if (shot) { await fs.promises.writeFile(path.join(dir, `${id}.jpg`), shot, { mode: 0o600 }); image = true; }
    }
    const doc = {
      id, at: new Date(now).toISOString(), kind: meta.kind || null, error_code: meta.error_code || null, step: meta.step || null, image,
      check: meta.check || null, diag: bounded(meta.diag), facts: bounded(meta.facts), // posting-diag: what was expected, what the page had
      key_tail: tail(meta.attempt_key), campaign_id: meta.campaign_id || null, phone_tail: tail(meta.phone, 4),
    };
    await fs.promises.writeFile(path.join(dir, `${id}.json`), JSON.stringify(doc), { mode: 0o600 });
    await prune(env, now);
    return id;
  } catch (e) {
    console.error(`posting shot: ${(e && (e.code || e.name)) || "error"}`);
    return null;
  }
}

// The ids on disk, newest first.
async function ids(env) {
  const names = await fs.promises.readdir(dirOf(env)).catch(() => []);
  return [...new Set(names.map((n) => n.replace(/\.(jpg|json)$/, "")).filter((n) => ID_RE.test(n)))].sort().reverse();
}

async function prune(env = process.env, now = Date.now()) {
  const all = await ids(env);
  const drop = all.filter((id, i) => i >= MAX_SHOTS || now - Number(id.split("-")[0]) > MAX_AGE_MS);
  for (const id of drop) for (const ext of ["jpg", "json"]) await fs.promises.unlink(path.join(dirOf(env), `${id}.${ext}`)).catch(() => {});
}

// → [{ id, at, kind, error_code, step, … }], newest first; expired ones dropped.
async function list(env = process.env) {
  if (!enabled(env)) return [];
  await prune(env);
  const out = [];
  for (const id of await ids(env)) {
    try { out.push(JSON.parse(await fs.promises.readFile(path.join(dirOf(env), `${id}.json`), "utf8"))); } catch { /* half-written: skipped */ }
  }
  return out;
}

// → the JPEG's bytes, or null. The id is checked, so no path ever escapes the dir.
async function read(id, env = process.env) {
  if (!enabled(env) || typeof id !== "string" || !ID_RE.test(id)) return null;
  return fs.promises.readFile(path.join(dirOf(env), `${id}.jpg`)).catch(() => null);
}

module.exports = { enabled, capture, list, read, prune, MAX_SHOTS, MAX_AGE_MS };
