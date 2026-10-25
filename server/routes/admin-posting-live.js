/*
 * routes/admin-posting-live.js — the automatic posting sessions open right
 * now (posting-live), in the "פרסום אוטומטי" tab. Mounted at
 * /api/admin/posting/live behind requireAdmin:
 *
 *   GET  /sessions                    each open session: agent, campaign, group, step, state
 *   GET  /sessions/:ref/view          its live picture (connect-viewer, the driver's own connection)
 *   POST /sessions/:ref/view/input    mouse and keys — only once the admin has taken it over
 *   POST /sessions/:ref/hold          finish the post in hand, then end the session
 *   POST /sessions/:ref/skip          drop the post in hand (never after its click)
 *   POST /sessions/:ref/takeover      stop the automation, keep the browser for the admin
 *   POST /sessions/:ref/release       { outcome: posted|skipped } the admin's post, recorded;
 *                                     the browser closes
 *
 * Every POST but the input needs a fresh step-up and writes an audit row.
 * An account is addressed only by the ref the list hands out, and only while
 * its session is open; phones leave as last-4 tails, browser addresses never.
 */
const express = require("express");
const { hmacHex } = require("../posting-tx");
const { redact } = require("../driver-browser");
const { postingEnvAllowed } = require("../posting-guard");
const A = require("../posting-account");

const tail = (p) => String(p || "").replace(/\D/g, "").slice(-4);
const refOf = (phone) => `live_${hmacHex(`${phone}|posting-live`, 24)}`;

module.exports = function createAdminPostingLiveRouter({
  requireAdmin, requireStepUp, store = require("../posting-store"), deps = {}, env = process.env, clock = () => new Date(),
  live = require("../posting-live"), viewer = require("../connect-viewer"), reconcile = require("../posting-reconcile"),
  liveKey = require("../posting-driver").liveKey,
}) {
  if (typeof requireAdmin !== "function" || typeof requireStepUp !== "function") throw new Error("admin-posting-live: requireAdmin and requireStepUp required");
  const router = express.Router();
  const guard = [requireAdmin, requireStepUp];
  const opTail = (req) => tail(req.user && req.user.userId);
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error(redact(`posting live ${req.method} ${req.route && req.route.path}: ${(e && e.code) || "error"}`));
    if (!res.headersSent) res.status(500).json({ error: "internal" });
  });
  router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use((req, res, next) => (req.method === "GET" || postingEnvAllowed(env) ? next() : res.status(503).json({ error: "posting_unavailable_in_env" })));

  const phoneOf = (ref) => { const e = [...live._live.values()].find((s) => refOf(s.phone) === ref); return e ? e.phone : null; };
  const withSession = (fn) => wrap(async (req, res) => {
    const phone = phoneOf(String(req.params.ref || ""));
    if (!phone) return res.status(404).json({ error: "session_ended" });
    return fn(req, res, phone, live.get(phone));
  });
  const audit = (req, action, phone, detail) => store.addAuditEvent({ operator_tail: opTail(req), action, target_phone_tail: tail(phone), detail }, clock())
    .then(() => true, () => false);

  router.get("/sessions", requireAdmin, wrap(async (req, res) => res.json({ sessions: live.list(refOf) })));

  router.get("/sessions/:ref/view", requireAdmin, withSession(async (req, res, phone) => {
    const hub = viewer._hubs && viewer._hubs.get(liveKey(phone));
    if (!hub || hub.closed) return res.status(404).json({ error: "no_viewer" });
    viewer.pipe(req, res, hub);
  }));
  router.post("/sessions/:ref/view/input", requireAdmin, withSession(async (req, res, phone, e) => {
    if (!(e.takeover && e.takeover.stopped)) return res.status(409).json({ error: "not_taken_over" });
    try { res.json(await viewer.input(liveKey(phone), req.body)); }
    catch (err) { res.status(err && err.code === "invalid_input" ? 400 : 409).json({ error: (err && err.code) || "no_viewer" }); }
  }));

  const lever = (name, fn) => router.post(`/sessions/:ref/${name}`, ...guard, withSession(async (req, res, phone, e) => {
    if (!fn(phone)) return res.status(409).json({ error: "nothing_to_" + name });
    const audited = await audit(req, `live_${name}`, phone, { attempt_tail: e.attempt_key ? String(e.attempt_key).slice(-6) : null });
    console.log(`posting live: ${name} on …${tail(phone)} by …${opTail(req)}`);
    res.json({ ok: true, audited, session: live.view(e, refOf) });
  }));
  lever("hold", live.hold);
  lever("skip", live.skip);
  lever("takeover", live.takeover);

  // The admin finished by hand. A post the takeover stopped before its click
  // was cancelled (admin_takeover): "posted" records it on the campaign. One
  // stopped after submit_started is outcome_unknown: the verdict resolves it
  // (posting-reconcile). One the automation finished itself stays as it is.
  router.post("/sessions/:ref/release", ...guard, withSession(async (req, res, phone, e) => {
    const outcome = (req.body || {}).outcome;
    if (!["posted", "skipped"].includes(outcome)) return res.status(400).json({ error: "invalid_input", field: "outcome" });
    if (!(e.takeover && e.takeover.stopped)) return res.status(409).json({ error: "not_taken_over" });
    const key = e.attempt_key;
    const a = key ? await store.getAttempt(key) : null;
    let recorded = null;
    if (a && a.state === "outcome_unknown") {
      const r = await reconcile.resolveUnknown(key, outcome === "posted" ? "posted" : "not_posted", { by: opTail(req), reason: "admin takeover" }, deps);
      recorded = r && r.ok ? outcome : null;
    } else if (a && a.state === "cancelled" && a.error_code === "admin_takeover" && outcome === "posted" && a.campaign_id) {
      const x = A.ctxOf(deps), at = A.iso(clock());
      const c = await A.mutate(x, String(a.campaign_id), (cur) => {
        const posts = (cur.posts || []).map((p) => (p.attempt_key === key && p.status === "skipped" ? { ...p, status: "posted", posted_at: at, error_code: null, manual: true } : p));
        return posts.some((p, i) => p !== cur.posts[i]) ? { posts } : null;
      });
      recorded = c && (c.posts || []).some((p) => p.attempt_key === key && p.status === "posted") ? "posted" : null;
    } else if (a && a.state === "cancelled" && a.error_code === "admin_takeover") recorded = "skipped";
    live.release(phone, outcome);
    const audited = await audit(req, "live_release", phone, { outcome, recorded, attempt_tail: key ? String(key).slice(-6) : null });
    console.log(`posting live: release …${tail(phone)} ${outcome} (${recorded || "unchanged"}) by …${opTail(req)}`);
    res.json({ ok: true, audited, recorded });
  }));

  return router;
};
module.exports.refOf = refOf;
