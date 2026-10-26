"use strict";
const crypto = require("crypto");
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function signature({ secret, purpose, body, timestamp, requestId }) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${purpose}\n${timestamp}\n${requestId}\n${canonical(body)}`)
    .digest("hex");
}
function signCallback(args) {
  return {
    "x-forly-timestamp": String(args.timestamp),
    "x-forly-request-id": args.requestId,
    "x-forly-signature": signature(args),
  };
}
function validateCallbackConfig(env = process.env) {
  if (
    env.CALLBACK_HMAC_SECRET &&
    [
      "NADLAN_JWT_SECRET",
      "FORLY_JWT_SECRET",
      "ADMIN_API_SECRET",
      "OUTREACH_HMAC_SECRET",
    ].some((key) => env[key] && env[key] === env.CALLBACK_HMAC_SECRET)
  )
    throw new Error("CALLBACK_HMAC_SECRET must be purpose-specific");
  if (
    (env.NODE_ENV === "production" || env.FORLY_ENV === "prod") &&
    (!env.CALLBACK_HMAC_SECRET || env.CALLBACK_HMAC_SECRET.length < 32)
  )
    throw new Error(
      "CALLBACK_HMAC_SECRET (at least 32 characters) required in production",
    );
}
function createCallbackGuard({
  secret = process.env.CALLBACK_HMAC_SECRET,
  now = Date.now,
  maxDaily = Number(process.env.CALLBACK_MAX_DAILY || 100),
  maxConcurrent = Number(process.env.CALLBACK_MAX_CONCURRENT || 2),
  reserve,
} = {}) {
  if (
    ![maxDaily, maxConcurrent].every(
      (value) => Number.isSafeInteger(value) && value >= 1 && value <= 100000,
    )
  )
    throw new Error("invalid_callback_budget");
  if (
    (process.env.NODE_ENV === "production" ||
      process.env.FORLY_ENV === "prod") &&
    (!reserve || reserve.durable !== true)
  )
    throw new Error("durable callback reservation required in production");
  const seen = new Map();
  let active = 0,
    day = "",
    count = 0;
  return (purpose) => async (req, res, next) => {
    // Explicit local-only migration escape hatch; never available in production.
    if (
      !secret &&
      process.env.NODE_ENV !== "production" &&
      process.env.FORLY_ENV !== "prod" &&
      process.env.CALLBACK_ALLOW_UNSIGNED_LOCAL === "1"
    )
      return next();
    if (!secret)
      return res.status(503).json({ error: "callback_not_configured" });
    const timestamp = String(req.get("x-forly-timestamp") || ""),
      requestId = String(req.get("x-forly-request-id") || ""),
      actual = String(req.get("x-forly-signature") || "");
    if (
      !/^\d{13}$/.test(timestamp) ||
      Math.abs(now() - Number(timestamp)) > 300000 ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(requestId) ||
      !/^[a-f0-9]{64}$/.test(actual)
    )
      return res.status(401).json({ error: "invalid_callback" });
    let serialized;
    try {
      serialized = canonical(req.body || {});
    } catch {
      return res.status(400).json({ error: "invalid_body" });
    }
    if (Buffer.byteLength(serialized) > 256 * 1024)
      return res.status(413).json({ error: "callback_too_large" });
    const expected = signature({
      secret,
      purpose,
      body: req.body || {},
      timestamp,
      requestId,
    });
    if (!crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected)))
      return res.status(401).json({ error: "invalid_callback" });
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      count = 0;
    }
    for (const [id, at] of seen) if (at < now() - 600000) seen.delete(id);
    const key = purpose + ":" + requestId;
    if (seen.has(key))
      return res.status(409).json({ error: "callback_already_received" });
    if (active >= maxConcurrent || count >= maxDaily)
      return res.status(429).json({ error: "callback_budget_exceeded" });
    // reserve must transactionally reject reused IDs across processes/restarts.
    seen.set(key, now());
    count++;
    active++;
    const undo = () => {
      seen.delete(key);
      count--;
      active--;
    };
    let reservation;
    if (reserve) {
      try {
        if (
          !(reservation = await reserve({
            id: key,
            purpose,
            day,
            maxDaily,
            maxConcurrent,
          }))
        ) {
          undo();
          return res
            .status(409)
            .json({ error: "callback_already_received_or_capped" });
        }
      } catch {
        undo();
        return res.status(503).json({ error: "callback_store_unavailable" });
      }
    }
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active--;
        if (reservation && reservation.release)
          Promise.resolve(reservation.release()).catch(() => {});
      }
    };
    req.callbackComplete = release;
    res.once("finish", release);
    res.once("close", () => {
      if (res.writableFinished) release();
    });
    next();
  };
}
module.exports = {
  canonical,
  signCallback,
  createCallbackGuard,
  validateCallbackConfig,
};
