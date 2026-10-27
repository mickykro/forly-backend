/*
 * routes/admin-agents.js — /api/admin/agents: one agent's automatic posting,
 * from the admin's campaigns tab.
 *
 *   GET  /:ref/activity  { paused, attempts (last 7 days), halts, shots }
 *   POST /:ref/pause     { paused: true|false, reason }  connections.posting_paused_by_admin
 *   POST /:ref/rules     { rules: { field: number|null } }  connections.posting_rules (posting-safety RULES)
 *
 * A paused agent's account is refused by posting-guard (paused_by_admin):
 * campaigns wait, a post not yet submitted is cancelled and retried after the
 * resume, nothing opens a browser. Agents are addressed by posting-manual.refOf;
 * phones leave this file only as last-4 tails. A change needs a fresh step-up
 * and writes an audit row first (no row, no change), and is refused outside
 * prod or a local box with POSTING_SWEEPER=1 (staging shares prod's Firestore).
 */
const express = require("express");
const A = require("../posting-account");
const M = require("../posting-manual");
const { redact } = require("../driver-browser");
const { postingEnvAllowed } = require("../posting-guard");
const safety = require("../posting-safety");

const DAY = 86400000;
const tail = (p) => (p ? String(p).slice(-4) : null);

module.exports = function createAdminAgentsRouter({ requireAdmin, requireStepUp, deps = {}, env = process.env }) {
  if (typeof requireAdmin !== "function" || typeof requireStepUp !== "function") throw new Error("admin-agents: requireAdmin and requireStepUp required");
  const x = A.ctxOf(deps);
  const store = x.store;
  const shots = deps.shots || require("../posting-shots");
  const router = express.Router();
  router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error(redact(`admin agents ${req.method} ${req.route && req.route.path}: ${(e && e.code) || "error"}`));
    if (!res.headersSent) res.status(e && e.code === "audit_unavailable" ? 503 : 500).json({ error: (e && e.code === "audit_unavailable") ? "audit_unavailable" : "internal" });
  });
  async function phoneOf(ref) {
    const phones = (await store.listConnectedPhones("facebook").catch(() => [])).map(String);
    return phones.find((p) => M.refOf(p) === String(ref)) || null;
  }

  router.get("/:ref/activity", requireAdmin, wrap(async (req, res) => {
    const phone = await phoneOf(req.params.ref);
    if (!phone) return res.status(404).json({ error: "not_found" });
    const conn = (await x.db.getConnection(phone)) || {};
    const now = x.clock().getTime();
    const camps = await store.listPostingCampaignsByPhone(phone).catch(() => []);
    const names = {};
    for (const c of camps) for (const g of c.groups || []) names[g.group_id] = g.name || null;
    const attempts = (await store.listAttemptsByPhone(phone, now - 7 * DAY))
      .sort((a, b) => (a.reserved_at < b.reserved_at ? 1 : -1)).slice(0, 50)
      .map((a) => ({ at: a.finished_at || a.reserved_at, state: a.state, error_code: a.error_code || null, group: names[a.target_id] || null, target: a.target_type, campaign: String(a.campaign_id || "").slice(0, 8) }));
    const halts = (conn.posting_halts || []).slice(-10).reverse().map((h) => ({ at: h.at, code: h.code }));
    // Failure screenshots exist on local/staging only (posting-shots); served by /api/dev/driver-shots/:id.jpg.
    const shotList = shots.enabled(env) ? (await shots.list(env)).filter((s) => s.phone_tail === `…${tail(phone)}`).slice(0, 10).map((s) => ({ id: s.id, at: s.at, error_code: s.error_code, image: s.image })) : [];
    // The agent's rules: their own (null = the global value), the global value, what applies to them.
    const setting = (await x.db.getSetting("posting")) || {};
    const rules = safety.rulesView(conn.posting_rules, safety.configFrom(setting, env, conn.posting_rules), env);
    const global = safety.rulesOf(safety.configFrom(setting, env));
    for (const f of Object.keys(rules)) rules[f].global = global[f];
    res.json({
      rules,
      paused: conn.posting_paused_by_admin || null,
      disabled: conn.posting_disabled_until_admin === true,
      running: camps.filter((c) => c.status === "running").length,
      attempts, halts, shots: shotList,
    });
  }));

  router.post("/:ref/pause", requireAdmin, requireStepUp, wrap(async (req, res) => {
    if (!postingEnvAllowed(env)) return res.status(503).json({ error: "posting_unavailable_in_env" });
    const b = req.body || {};
    if (typeof b.paused !== "boolean") return res.status(400).json({ error: "invalid_input", field: "paused" });
    const reason = typeof b.reason === "string" ? b.reason.replace(/\s+/g, " ").trim().replace(/\d{7,}/g, "…").slice(0, 200) : "";
    if (!reason) return res.status(400).json({ error: "reason_required" });
    const phone = await phoneOf(req.params.ref);
    if (!phone) return res.status(404).json({ error: "not_found" });
    const by = tail(req.user && req.user.userId);
    try { await store.addAuditEvent({ operator_tail: by, action: b.paused ? "agent_pause" : "agent_resume", target_phone_tail: tail(phone), reason, detail: {} }, x.clock()); }
    catch (e) { throw Object.assign(new Error("audit_unavailable"), { code: "audit_unavailable" }); }
    const paused = b.paused ? { at: x.clock().toISOString(), by_tail: by, reason } : null;
    await store.mutateConnection(phone, () => ({ posting_paused_by_admin: paused }));
    console.log(`posting admin: agent …${tail(phone)} ${b.paused ? "paused" : "resumed"} by …${by}`);
    res.json({ ok: true, paused });
  }));

  // The agent's own rules: each a whole number in its range, or null (the global value). Replaces the whole set.
  router.post("/:ref/rules", requireAdmin, requireStepUp, wrap(async (req, res) => {
    if (!postingEnvAllowed(env)) return res.status(503).json({ error: "posting_unavailable_in_env" });
    const raw = (req.body || {}).rules;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return res.status(400).json({ error: "invalid_input", field: "rules" });
    const rules = {};
    for (const [f, v] of Object.entries(raw)) {
      if (!safety.CAP_FIELDS.includes(f)) return res.status(400).json({ error: "invalid_input", field: f });
      if (v === null) continue;
      const [min, max] = safety.capRange(f, env);
      if (!Number.isInteger(v) || v < min || v > max) return res.status(400).json({ error: "out_of_range", field: f, min, max });
      rules[f] = v;
    }
    const phone = await phoneOf(req.params.ref);
    if (!phone) return res.status(404).json({ error: "not_found" });
    const by = tail(req.user && req.user.userId);
    try { await store.addAuditEvent({ operator_tail: by, action: "agent_rules", target_phone_tail: tail(phone), reason: "admin", detail: { changed: Object.keys(rules).join(" ") || "cleared" } }, x.clock()); }
    catch (e) { throw Object.assign(new Error("audit_unavailable"), { code: "audit_unavailable" }); }
    await store.mutateConnection(phone, () => ({ posting_rules: Object.keys(rules).length ? rules : null }));
    console.log(`posting admin: agent …${tail(phone)} rules ${JSON.stringify(rules)} by …${by}`);
    res.json({ ok: true, rules });
  }));

  return router;
};
