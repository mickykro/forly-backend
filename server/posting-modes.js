/*
 * posting-modes.js — how posting behaves, set in the admin panel
 * (settings/posting.modes) instead of env vars.
 *
 * Each mode is true, false, or absent (the env's own value, as before). The
 * admin's choice is laid over process.env, so every reader of these flags
 * (posting-safety, posting-manual, posting-tick, posting-shots) keeps working
 * unchanged. Their own limits still hold: burst, fast pacing, no warm-up and
 * no caps only ever apply with FORLY_ENV=local; screenshots never in prod.
 *
 * Whether posting runs at all is the admin's main switch (settings/posting.enabled).
 * Infrastructure and security stay env-only: POSTING_SWEEPER (which server posts), the owner/operator
 * phones, the browser type and proxy hops.
 */
const MODES = {
  manual: "POSTING_MANUAL", // an admin publishes every post by hand
  no_approval: "POSTING_NO_APPROVAL", // automatic posting asks the agent nothing: a per_post campaign posts as a standing one
  caps: "POSTING_CAPS", // local: keep the caps (outside local they always hold)
  pacing: "POSTING_PACING", // local: the normal pacing, not the 5-minute test gap
  warmup: "POSTING_WARMUP", // local: the new-account warm-up
  burst: "POSTING_BURST", // local: back-to-back test posting
  browse: "POSTING_BROWSE", // local: idle browsing between sessions
  shots: "POSTING_SHOTS", // local/staging: a screenshot of every failed post
};
const base = Object.fromEntries(Object.values(MODES).map((k) => [k, process.env[k]])); // the env as the server started

// → the admin's modes, cleaned: only known keys, only booleans.
function clean(raw) {
  const out = {};
  for (const m of Object.keys(MODES)) if (raw && typeof raw[m] === "boolean") out[m] = raw[m];
  return out;
}

// Only what an admin set is touched; a mode the admin cleared gets the env's own value back.
const overridden = new Set();
function apply(raw, env = process.env) {
  const modes = clean(raw);
  for (const [m, key] of Object.entries(MODES)) {
    if (m in modes) { env[key] = modes[m] ? "1" : "0"; overridden.add(key); }
    else if (overridden.has(key)) {
      overridden.delete(key);
      if (base[key] === undefined) delete env[key]; else env[key] = base[key];
    }
  }
  return modes;
}

// Re-read settings/posting.modes; a failed read keeps what is applied.
async function refresh(db = require("./db")) {
  try { return apply(((await db.getSetting("posting")) || {}).modes); } catch (e) { return null; }
}

// What the admin page shows: each mode's admin value (null = env) and the env's own value.
function view(raw) {
  const modes = clean(raw);
  return Object.fromEntries(Object.entries(MODES).map(([m, key]) => [m, { set: m in modes ? modes[m] : null, env: base[key] === undefined ? null : base[key] }]));
}

module.exports = { MODES, clean, apply, refresh, view };
