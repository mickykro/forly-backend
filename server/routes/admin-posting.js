/*
 * routes/admin-posting.js — the operator's levers over automated posting
 * (Task 21), mounted at /api/admin/posting behind requireAdmin:
 *
 *   GET  /overview                         the fleet: switches, counts, halts by class, health
 *                                          (a failing section → `warnings`, still 200)
 *   POST /switch           { enabled, reason, version }            global kill switch (R2)
 *   POST /switch/platform  { platform, enabled, reason, version }  settings/posting.platforms.<p>
 *   POST /switch/visible   { enabled, reason, version }            visible_interactions_enabled
 *   POST /accounts/:account/reenable       { reason, agent_confirmed }  per halt class (R5)
 *   POST /accounts/:account/revoke-profile { reason }                   suspected compromise
 *
 * Every POST needs a fresh step-up (an OTP login in the last 10 minutes) and
 * writes an audit_events row. Switches are compare-and-set on
 * settings/posting.version (409 version_conflict). Phones leave this file only
 * as last-4 tails; an account is addressed by the opaque `ref` the overview
 * hands out (or its phone, for scripts).
 *
 * Deferred: operator live-viewer grants for customer sessions — the live
 * session map runs in production only after the product owner approves it.
 */
const express = require("express");
const { normalizeAuthPhone } = require("../utils");
const { hmacHex } = require("../posting-tx");
const { redact } = require("../driver-browser");

const MS_DAY = 86400000;
const PLATFORMS = ["facebook", "yad2", "madlan"];
const STATUSES = ["running", "paused", "stopped", "completed"];
const AGENT_CONFIRMED = new Set(["captcha", "checkpoint"]);
const tail = (p) => String(p || "").replace(/\D/g, "").slice(-4);
const iso = (d) => new Date(d).toISOString();
const ms = (v) => (v && typeof v.toDate === "function" ? v.toDate().getTime() : v ? new Date(v).getTime() : NaN);
const refOf = (phone) => `acct_${hmacHex(`${phone}|operator-ref`, 24)}`;

// A typed reason: required, one line, 200 chars, no phone in it.
function cleanReason(v) {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\d{7,}/g, (m) => `…${m.slice(-4)}`).trim().slice(0, 200);
  return s || null;
}

// What an operator may do with an account, from the connection alone (R5):
//   suspected_compromise            revoke the profile; the OWNER re-enables,
//                                   only once the agent reconnected a new profile
//   restricted / owner review /
//   an unknown disabling class      the owner re-enables (POSTING_OWNER_PHONES)
//   captcha / checkpoint            re-enable once the agent confirmed integrity
// The class field alone is not trusted (fix round 1): every halt recorded
// since the last re-enable counts too, and the strictest one wins. Any
// captcha/checkpoint among them needs the agent's confirmation, the owner
// path included.
function liveClasses(conn) {
  const since = ms(conn.posting_reenabled_at);
  const live = (conn.posting_halts || []).filter((h) => h && h.code && !(ms(h.at) <= since)).map((h) => h.code);
  return new Set(live.concat(conn.posting_disabled_class ? [conn.posting_disabled_class] : []));
}
function reenableRule(conn) {
  const disabled = conn.posting_disabled_until_admin === true;
  const review = conn.posting_owner_review_required === true;
  if (!disabled && !review) return "not_disabled";
  const classes = liveClasses(conn);
  const cls = conn.posting_disabled_class || null;
  if (classes.has("suspected_compromise")) return "compromise";
  if (review || classes.has("restricted") || !AGENT_CONFIRMED.has(cls)) return "owner";
  return "agent_confirmed";
}
const needsAgentConfirmation = (conn) => [...liveClasses(conn)].some((c) => AGENT_CONFIRMED.has(c));
const ACTIONS = { not_disabled: [], compromise: ["revoke_profile", "reenable_after_reconnect"], owner: ["owner_reenable"], agent_confirmed: ["reenable"] };

// Did the agent reconnect a NEW profile after the suspected compromise? The
// profile generation must have moved past the one the halt recorded, and the
// connect must be later than the halt. A halt recorded before the generation
// was stored cannot prove it: refused (fail closed).
function reconnectedAfterHalt(conn) {
  const haltGen = conn.posting_disabled_profile_gen;
  if (!Number.isInteger(haltGen)) return false;
  return (conn.facebook_profile_gen || 0) > haltGen && ms(conn.facebook_browser_connected_at) > ms(conn.posting_disabled_at);
}

function accountRow(phone, conn, now) {
  const halts = (conn.posting_halts || []).filter((h) => h && now - ms(h.at) < MS_DAY);
  const last = halts[halts.length - 1] || null;
  const rule = reenableRule(conn);
  const disabled = conn.posting_disabled_until_admin === true;
  const review = conn.posting_owner_review_required === true;
  return {
    ref: refOf(phone), phone_tail: tail(phone),
    class: disabled || review ? conn.posting_disabled_class || "unknown" : (last && last.code) || conn.posting_last_halt_code || "unknown",
    disabled, owner_review: review,
    disabled_at: conn.posting_disabled_at || null,
    last_halt_at: conn.posting_last_halt_at || null,
    penalty_until: ms(conn.posting_penalty_until) > now ? conn.posting_penalty_until : null,
    needs_reconnect: conn.facebook_needs_reconnect === true,
    reconnected_since_disable: disabled && ms(conn.facebook_browser_connected_at) > ms(conn.posting_disabled_at),
    profile_state: conn.facebook_profile_state || null,
    reenabled_at: conn.posting_reenabled_at || null,
    allowed_actions: ACTIONS[rule],
    reconnected_after_halt: rule === "compromise" && reconnectedAfterHalt(conn),
    needs_agent_confirmation: rule !== "not_disabled" && needsAgentConfirmation(conn),
    halts_24h: halts.map((h) => ({ code: h.code, at: h.at })),
  };
}

function switchView(s, env) {
  const platforms = {};
  for (const p of PLATFORMS) platforms[p] = !(s.platforms && s.platforms[p] === false);
  const lc = s.last_change || null;
  return {
    enabled: s.enabled !== false, disabled_reason: s.enabled === false ? s.disabled_reason || null : null,
    version: s.version || 0, enabled_at: s.enabled_at || null, env_forced_off: env.POSTING_ENABLED === "0",
    platforms, visible_interactions_enabled: s.visible_interactions_enabled !== false,
    changed_by_tail: s.changed_by || null, changed_at: s.changed_at || null, reason: s.reason || null,
    last_change: lc && { what: lc.what, enabled: lc.enabled, by_tail: lc.by_tail, reason: lc.reason, at: lc.at },
  };
}

module.exports = function createAdminPostingRouter({
  requireAdmin, requireStepUp, db = require("../db"), store = require("../posting-store"),
  halts = require("../posting-halts"), lifecycle = require("../profile-lifecycle"),
  deps = {}, env = process.env, clock = () => new Date(),
}) {
  if (typeof requireAdmin !== "function" || typeof requireStepUp !== "function") throw new Error("admin-posting: requireAdmin and requireStepUp required");
  const router = express.Router();
  const guard = [requireAdmin, requireStepUp];
  const opTail = (req) => tail(req.user && req.user.userId);
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error(redact(`posting admin ${req.method} ${req.route && req.route.path}: ${(e && e.code) || "error"}`));
    if (!res.headersSent) res.status(500).json({ error: "internal" });
  });
  router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

  async function audit(req, action, { phone, reason, detail } = {}) {
    try {
      await store.addAuditEvent({ operator_tail: opTail(req), action, target_phone_tail: phone ? tail(phone) : null, reason, detail }, clock());
      return true;
    } catch (e) {
      console.error(redact(`posting admin audit ${action} failed: ${(e && e.code) || "error"}`));
      return false;
    }
  }

  // The halted/disabled phones an operator can see (a halt is kept a year).
  // Either query alone is enough to find a ref (a disabled account was
  // halted), so one missing index does not block a re-enable.
  async function knownPhones(now) {
    const got = await Promise.allSettled([store.listDisabledPhones(), store.listPhonesHaltedSince(iso(now.getTime() - 365 * MS_DAY))]);
    const ok = got.filter((g) => g.status === "fulfilled");
    if (!ok.length) throw got[0].reason;
    return [...new Set(ok.flatMap((g) => g.value))];
  }
  async function resolveAccount(param, now) {
    const p = String(param || "");
    if (/^\d{9,15}$/.test(p)) return p;
    if (!/^acct_[0-9a-f]{24}$/.test(p)) return null;
    return (await knownPhones(now)).find((ph) => refOf(ph) === p) || null;
  }

  // The overview degrades: a section whose query fails (a missing index above
  // all — Firestore FAILED_PRECONDITION, code 9) is left out and named in
  // `warnings`; the rest still loads, with status 200.
  const indexMissing = (e) => !!e && (e.code === 9 || /^failed[-_]precondition$/i.test(String(e.code)) || /FAILED_PRECONDITION|requires an index/i.test(String(e.message)));
  router.get("/overview", requireAdmin, wrap(async (req, res) => {
    const now = clock();
    const warnings = [];
    const section = async (name, fn, fallback) => {
      try { return await fn(); } catch (e) {
        const w = `${indexMissing(e) ? "index_missing" : "query_failed"}:${name}`;
        if (!warnings.includes(w)) warnings.push(w);
        console.error(redact(`posting admin overview ${w} (${(e && e.code) || "error"})`));
        return fallback;
      }
    };
    const setting = await section("switch", async () => (await db.getSetting("posting")) || {}, null);
    const health = await section("health", async () => (await db.getSetting("posting_health")) || {}, null);
    const campaigns = await section("campaigns", async () => {
      const out = {};
      for (const st of STATUSES) out[st] = await store.countPostingCampaignsByStatus(st);
      return out;
    }, null);
    const disabled = await section("accounts_disabled", () => store.listDisabledPhones(), null);
    const recent = await section("halts_recent", () => store.listPhonesHaltedSince(iso(now.getTime() - MS_DAY)), []);
    const accounts = [];
    let accountsFailed = false;
    for (const phone of [...new Set([...(disabled || []), ...recent])]) {
      const conn = await section("accounts", () => db.getConnection(phone), undefined);
      if (conn === undefined) accountsFailed = true;
      else if (conn) accounts.push(accountRow(phone, conn, now.getTime()));
    }
    const halts_by_class = {};
    for (const a of accounts) (halts_by_class[a.class] = halts_by_class[a.class] || []).push(a);
    const halts_24h = accounts.flatMap((a) => a.halts_24h.map((h) => ({ phone_tail: a.phone_tail, ref: a.ref, code: h.code, at: h.at })))
      .sort((x, y) => (x.at < y.at ? 1 : -1));
    const audit = await section("audit", () => store.listAuditEvents({ sinceMs: now.getTime() - 30 * MS_DAY, limit: 20 }), []);
    // Without the switch doc nothing about the switches is known: null, never a default "on".
    const sw = setting ? switchView(setting, env) : Object.fromEntries(Object.keys(switchView({}, env)).map((k) => [k, k === "env_forced_off" ? env.POSTING_ENABLED === "0" : null]));
    res.json(Object.assign(sw, {
      campaigns, halts_24h, halts_by_class,
      // Counted over the disabled list; unknown (never a partial count) when
      // that query or any account read failed.
      accounts_disabled: disabled && !accountsFailed ? accounts.filter((a) => a.disabled).length : null,
      owner_review: disabled && !accountsFailed ? accounts.filter((a) => a.owner_review).length : null,
      owner_configured: ownerSet().size > 0,
      // The owner gate's own check, so the tab offers owner-only buttons to owners only.
      is_owner: ownerSet().has(normalizeAuthPhone(req.user && req.user.userId) || ""),
      posting_health: health && {
        last_sweep_at: health.last_sweep_at || null,
        reap_failures: (health.reap_failures || []).slice(0, 20).map((f) => ({ key_tail: f.key_tail, error_code: f.error_code, first_seen_at: f.first_seen_at })),
        reap_failures_count: (health.reap_failures || []).length,
        cancel_failures_count: health.cancel_failures_count || 0,
      },
      recent_audit: audit.map((e) => ({ at: e.at, action: e.action, operator_tail: e.operator_tail, target_phone_tail: e.target_phone_tail, reason: e.reason, detail: e.detail })),
      warnings,
    }));
  }));

  // ── the switches: compare-and-set on settings/posting.version ──
  function switchRoute(path, what, build) {
    router.post(path, ...guard, wrap(async (req, res) => {
      const b = req.body || {};
      if (typeof b.enabled !== "boolean") return res.status(400).json({ error: "invalid_input", field: "enabled" });
      if (!Number.isInteger(b.version) || b.version < 0) return res.status(400).json({ error: "invalid_input", field: "version" });
      const reason = cleanReason(b.reason);
      if (!reason) return res.status(400).json({ error: "reason_required" });
      const sw = what(b);
      if (!sw) return res.status(400).json({ error: "invalid_input", field: "platform" });
      const cur = (await db.getSetting("posting")) || {};
      if ((cur.version || 0) !== b.version) return res.status(409).json({ error: "version_conflict", version: cur.version || 0 });
      const at = iso(clock());
      const by = opTail(req);
      const patch = Object.assign(build(cur, b.enabled, { at, by, reason, platform: b.platform }), {
        last_change: { what: sw, enabled: b.enabled, by_tail: by, reason, at },
      });
      let next;
      try { next = await db.setSetting("posting", patch, { expectVersion: b.version }); }
      catch (e) {
        if (!e || e.code !== "version_conflict") throw e;
        const fresh = (await db.getSetting("posting")) || {};
        return res.status(409).json({ error: "version_conflict", version: fresh.version || 0 });
      }
      const action = `switch_${sw.split(":")[0]}`;
      const audited = await audit(req, action, { reason, detail: { switch: sw, enabled: b.enabled, version: next.version } });
      console.log(`posting admin: ${sw} ${b.enabled ? "on" : "off"} by …${by} (v${next.version})`);
      res.json(Object.assign({ ok: true, audited }, switchView(next, env)));
    }));
  }
  // Turning the fleet on stamps enabled_at: the fleet breaker counts halts only after it.
  switchRoute("/switch", () => "global", (cur, on, m) => Object.assign(
    { enabled: on, disabled_reason: on ? null : m.reason, reason: m.reason, changed_by: m.by, changed_at: m.at },
    on && cur.enabled === false ? { enabled_at: m.at } : {},
    on ? {} : { disabled_at: m.at },
  ));
  switchRoute("/switch/platform", (b) => (PLATFORMS.includes(b.platform) ? `platform:${b.platform}` : null),
    (cur, on, m) => ({ platforms: Object.assign({}, cur.platforms || {}, { [m.platform]: on }) }));
  switchRoute("/switch/visible", () => "visible", (cur, on) => ({ visible_interactions_enabled: on }));

  // POSTING_OWNER_PHONES, read per request; unset → nobody is an owner (fail closed).
  function ownerSet() {
    return new Set(String(env.POSTING_OWNER_PHONES || "").split(",").map((p) => normalizeAuthPhone(p.trim())).filter(Boolean));
  }

  // ── re-enable: per class, in one connection transaction (R5) ──
  router.post("/accounts/:account/reenable", ...guard, wrap(async (req, res) => {
    const b = req.body || {};
    const reason = cleanReason(b.reason);
    if (!reason) return res.status(400).json({ error: "reason_required" });
    if (b.agent_confirmed !== undefined && typeof b.agent_confirmed !== "boolean") return res.status(400).json({ error: "invalid_input", field: "agent_confirmed" });
    const now = clock();
    const phone = await resolveAccount(req.params.account, now);
    if (!phone || !(await db.getConnection(phone))) return res.status(404).json({ error: "not_found" });
    const owners = ownerSet();
    const isOwner = owners.has(normalizeAuthPhone(req.user.userId) || "");
    const at = iso(now);
    const by = opTail(req);
    // Pure (Firestore may re-run it): the verdict of the committed run is kept.
    let verdict = null;
    const decide = (conn) => {
      const rule = reenableRule(conn);
      const cls = conn.posting_disabled_class || null;
      const ownerOnly = rule === "owner" || rule === "compromise";
      if (rule === "not_disabled") verdict = { status: 409, error: "not_disabled" };
      else if (ownerOnly && !owners.size) verdict = { status: 403, error: "owner_not_configured" };
      else if (ownerOnly && !isOwner) verdict = { status: 403, error: "owner_required" };
      else if (rule === "compromise" && !reconnectedAfterHalt(conn)) verdict = { status: 409, error: "reconnect_required" };
      else if ((rule === "agent_confirmed" || needsAgentConfirmation(conn)) && b.agent_confirmed !== true) verdict = { status: 400, error: "agent_confirmation_required" };
      else verdict = { ok: true, rule, cls };
      if (!verdict.ok) return null;
      // posting_reenabled_at in the SAME patch as the cleared flags: a later
      // halt of the same class is a new halt, never a 24 h duplicate.
      return Object.assign({
        posting_disabled_until_admin: false, posting_owner_review_required: false,
        posting_reenabled_at: at, posting_reenabled_by: by, posting_reenable_reason: reason,
        posting_reenabled_as: ownerOnly ? "owner" : "operator",
        facebook_browser_first_connected_at: at, // warm-up restarts
      }, b.agent_confirmed === true && needsAgentConfirmation(conn) ? { posting_agent_confirmed_at: at } : {});
    };
    await store.mutateConnection(phone, decide);
    if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });
    const as = verdict.rule === "agent_confirmed" ? "operator" : "owner";
    const audited = await audit(req, "reenable", { phone, reason, detail: { class: verdict.cls || "unknown", as } });
    console.log(`posting admin: account …${tail(phone)} re-enabled (${verdict.cls || "unknown"}, ${as}) by …${by}`);
    res.json({ ok: true, audited, phone_tail: tail(phone), class: verdict.cls, as });
  }));

  // ── suspected compromise: revoke and delete the profile (R5) ──
  // The operator's judgement is itself the detection: an account not already
  // halted as suspected_compromise is halted as one (disabled, profile
  // revoked, campaigns paused); one that is gets the revoke run again.
  router.post("/accounts/:account/revoke-profile", ...guard, wrap(async (req, res) => {
    const reason = cleanReason((req.body || {}).reason);
    if (!reason) return res.status(400).json({ error: "reason_required" });
    const phone = await resolveAccount(req.params.account, clock());
    const conn = phone ? await db.getConnection(phone) : null;
    if (!conn) return res.status(404).json({ error: "not_found" });
    const already = conn.posting_disabled_until_admin === true && conn.posting_disabled_class === "suspected_compromise";
    if (already) await lifecycle.revoke({ phone, platform: "facebook", reason: "suspected_compromise" }, { db, driver: deps.driver || require("../driver-browser") });
    else await halts.haltAccount(phone, "suspected_compromise", Object.assign({}, deps, { db, store, lifecycle }));
    const audited = await audit(req, "revoke_profile", { phone, reason, detail: { class: "suspected_compromise", halted: !already } });
    console.log(`posting admin: account …${tail(phone)} profile revoked (suspected_compromise) by …${opTail(req)}`);
    res.json({ ok: true, audited, phone_tail: tail(phone) });
  }));

  return router;
};

module.exports._test = { reenableRule, needsAgentConfirmation, cleanReason, refOf };
