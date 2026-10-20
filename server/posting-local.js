/*
 * posting-local.js — one explicit, fail-closed mode for watched local posts.
 *
 * POSTING_LOCAL_TEST=1 is deliberately stronger than ordinary FORLY_ENV=local:
 * it skips calendar/idle warm-up, requires an on-screen Driver viewer and an
 * approval on every post. The approved posting session itself starts with one
 * passive Facebook readiness preflight in that same browser. It may never be
 * used in staging or production.
 */
const FLAG = "POSTING_LOCAL_TEST";
const PREFLIGHT_SECONDS = "POSTING_LOCAL_PREFLIGHT_SECONDS";
const DEFAULT_PREFLIGHT_SECONDS = 20;
const MAX_PREFLIGHT_SECONDS = 90;

const requested = (env = process.env) => !!env && env[FLAG] === "1";

function problem(env = process.env) {
  if (!requested(env)) return null;
  if (env.FORLY_ENV !== "local") return `${FLAG}=1 requires FORLY_ENV=local`;
  if (env.NODE_ENV === "production") return `${FLAG}=1 is forbidden with NODE_ENV=production`;
  if (env.POSTING_SWEEPER !== "1") return `${FLAG}=1 requires POSTING_SWEEPER=1`;
  if (env.POSTING_ENABLED !== "1") return `${FLAG}=1 requires POSTING_ENABLED=1`;
  if (env.DRIVER_DEV_VIEW === "0") return `${FLAG}=1 requires the live browser viewer (DRIVER_DEV_VIEW must not be 0)`;
  if (env[PREFLIGHT_SECONDS] !== undefined) {
    const n = Number(env[PREFLIGHT_SECONDS]);
    if (!Number.isInteger(n) || n < 0 || n > MAX_PREFLIGHT_SECONDS) {
      return `${PREFLIGHT_SECONDS} must be an integer from 0 to ${MAX_PREFLIGHT_SECONDS}`;
    }
  }
  return null;
}

const enabled = (env = process.env) => requested(env) && !problem(env);
const requireApproval = (env = process.env) => enabled(env);
// The multi-day account ramp and separate idle browsing remain disabled. This
// does not suppress the passive preflight inside an approved posting session.
const skipWarmup = (env = process.env) => enabled(env);
const sessionPreflightSeconds = (env = process.env) => enabled(env)
  ? (env[PREFLIGHT_SECONDS] === undefined ? DEFAULT_PREFLIGHT_SECONDS : Number(env[PREFLIGHT_SECONDS]))
  : 0;

module.exports = {
  FLAG, PREFLIGHT_SECONDS, DEFAULT_PREFLIGHT_SECONDS, MAX_PREFLIGHT_SECONDS,
  requested, problem, enabled, requireApproval, skipWarmup, sessionPreflightSeconds,
};
