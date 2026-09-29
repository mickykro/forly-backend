/*
 * posting-local.js — one explicit, fail-closed mode for watched local posts.
 *
 * POSTING_LOCAL_TEST=1 is deliberately stronger than ordinary FORLY_ENV=local:
 * it promises no warm-up/dwell, an on-screen Driver viewer, and an approval on
 * every post. It may never be used in staging or production.
 */
const FLAG = "POSTING_LOCAL_TEST";

const requested = (env = process.env) => !!env && env[FLAG] === "1";

function problem(env = process.env) {
  if (!requested(env)) return null;
  if (env.FORLY_ENV !== "local") return `${FLAG}=1 requires FORLY_ENV=local`;
  if (env.NODE_ENV === "production") return `${FLAG}=1 is forbidden with NODE_ENV=production`;
  if (env.POSTING_SWEEPER !== "1") return `${FLAG}=1 requires POSTING_SWEEPER=1`;
  if (env.POSTING_ENABLED !== "1") return `${FLAG}=1 requires POSTING_ENABLED=1`;
  if (env.DRIVER_DEV_VIEW === "0") return `${FLAG}=1 requires the live browser viewer (DRIVER_DEV_VIEW must not be 0)`;
  return null;
}

const enabled = (env = process.env) => requested(env) && !problem(env);
const requireApproval = (env = process.env) => enabled(env);
const skipWarmup = (env = process.env) => enabled(env);

module.exports = { FLAG, requested, problem, enabled, requireApproval, skipWarmup };
