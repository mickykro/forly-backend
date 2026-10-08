// server/routes/admin-campaigns.js
/*
 * routes/admin-campaigns.js — /api/admin/campaigns: the admin's "קמפיינים"
 * tab. Create, edit, stop and start an agent's campaign. Every change needs
 * the admin guard and a fresh step-up, and writes an audit row (no phone, no
 * text) BEFORE the change: no audit row, no change (503 audit_unavailable).
 * That row records the request (outcome "requested"); a change refused
 * after it (stale version, busy, nowhere to post) adds a second row for
 * the refusal (outcome "refused", the reason), so the log never shows a
 * change that did not happen as made — and never a change without a row. A campaign the admin creates carries the consent the admin recorded
 * (who agreed, how, a note). Agents are addressed by posting-manual.refOf.
 * Staging shares production's Firestore: no change outside prod (or a local
 * box with POSTING_SWEEPER=1), as routes/posting.js.
 * POSTING_MANUAL=1: an admin publishes groups by hand (posting-manual), one
 * pass, no Page — so the Page target and repeat are refused there
 * (manual_unsupported), and a restart drops them.
 */
const express = require("express");
const A = require("../posting-account");
const S_ = require("./posting-shared");
const PC = require("./posting-create");
const M = require("../posting-manual");
const { postingEnvAllowed } = require("../posting-guard");
const { redact } = require("../driver-browser");

const METHODS = new Set(["phone", "in_person", "whatsapp"]);
const LIVE = new Set(["running", "paused"]);
const STATUSES = ["running", "paused", "stopped", "completed"];
const ERR_STATUS = { not_found: 404, stale_version: 409, busy: 409, not_live: 409, no_destination: 400, audit_unavailable: 503 };
const DAY = 86400000;

function consentOf(b) {
  const c = b && b.consent;
  const note = c && typeof c.note === "string" ? c.note.trim() : "";
  if (!c || !METHODS.has(c.method) || !note || note.length > 300) return null;
  return { method: c.method, note };
}

module.exports = function createAdminCampaignsRouter({
  requireAdmin, requireStepUp, deps = {}, env = process.env, catalog,
  campaigns = require("../posting-campaign"), admin = require("../posting-campaign-admin"),
}) {
  if (typeof requireAdmin !== "function" || typeof requireStepUp !== "function") throw new Error("admin-campaigns: requireAdmin and requireStepUp required");
  const x = A.ctxOf(deps);
  const { db, store } = x;
  const catalogFn = catalog || ((want) => require("./distribution").mergedCatalog(db, want));
  const guard = [requireAdmin, requireStepUp];
  const router = express.Router();
  // store-facing tails (audit rows, consent, permission) are digits only; A.tail's "…" prefix is display-only.
  const dtail = (p) => String(p || "").replace(/\D/g, "").slice(-4);
  const opTail = (req) => dtail(req.user && req.user.userId);
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    if (e && ERR_STATUS[e.code]) return res.status(ERR_STATUS[e.code]).json({ error: e.code });
    console.error(redact(`admin campaigns ${req.method} ${req.route && req.route.path}: ${(e && e.code) || "error"}`));
    if (!res.headersSent) res.status(500).json({ error: "internal" });
  });
  router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use((req, res, next) => (req.method === "GET" || postingEnvAllowed(env) ? next() : res.status(503).json({ error: "posting_unavailable_in_env" })));

  // Written before the change it records; throws audit_unavailable (503) when it cannot be.
  async function audit(req, action, phone, detail) {
    try { await store.addAuditEvent({ operator_tail: opTail(req), action, target_phone_tail: dtail(phone), reason: null, detail: { ...detail, outcome: "requested" } }, x.clock()); }
    catch (e) {
      console.error(redact(`admin campaigns audit ${action} failed: ${(e && e.code) || "error"}`));
      throw Object.assign(new Error("audit_unavailable"), { code: "audit_unavailable" });
    }
  }
  // The change the row above requested was refused: a second row says so (best effort — the refusal stands either way).
  const refusalRow = (req, action, phone, detail, code) => store.addAuditEvent({ operator_tail: opTail(req), action, target_phone_tail: dtail(phone), reason: null, detail: { ...detail, outcome: "refused", refused: code } }, x.clock())
    .catch((e2) => console.error(redact(`admin campaigns audit ${action} refusal failed: ${(e2 && e2.code) || "error"}`)));
  async function refused(req, action, phone, detail, fn) {
    try { return await fn(); }
    catch (e) {
      if (e && ERR_STATUS[e.code] && e.code !== "audit_unavailable") await refusalRow(req, action, phone, detail, e.code);
      throw e;
    }
  }
  const manual = () => require("../posting-manual").enabled(env);
  // What the manual flow cannot do: a Page post, a second pass.
  const manualRefuses = (targets, repeatDays) => manual() && ((Array.isArray(targets) && targets.includes("page")) || Number(repeatDays) > 0);
  async function phones() { return (await store.listConnectedPhones("facebook").catch(() => [])).map(String); }
  async function phoneOf(ref) { return (await phones()).find((p) => M.refOf(p) === String(ref)) || null; }
  const names = new Map();
  async function nameOf(phone) {
    if (!names.has(phone)) { const b = (await db.getBusiness(phone).catch(() => null)) || {}; names.set(phone, b.full_name || b.business_name || ""); }
    return names.get(phone);
  }
  async function rowOf(c) {
    const page = (await db.getPage(c.page_id).catch(() => null)) || {};
    const pass = M.groupsOf(c); // this pass only: a restart keeps older posts as history
    const n = (st) => pass.filter((g) => g.status === st).length;
    return {
      id: c.id, ref: M.refOf(c.phone), phone_tail: A.tail(c.phone), agent_name: await nameOf(c.phone),
      page_id: c.page_id, page_title: ((page.property || {}).title) || "", status: c.status, pause_reason: c.pause_reason || null,
      mode: c.mode, repeat: !!c.repeat, repeat_days: c.repeat_days || null, targets: c.targets || [], expires_at: c.expires_at, run_days: previousDays(c),
      groups: (c.groups || []).map((g) => ({ group_id: g.group_id, name: g.name || "", copy: g.copy })),
      counts: { owed: n("owed"), posted: n("posted"), skipped: n("skipped") },
      created_by: c.created_by || "agent", consent_by: c.consent_by || { by: "agent" }, version: c.updated_at,
      // Manual posting cannot do what an older (or the agent's) campaign asks: shown, not hidden.
      manual_unsupported: manual() ? [(c.targets || []).includes("page") ? "page" : null, c.repeat ? "repeat" : null].filter(Boolean) : [],
    };
  }
  // The same gates as the agent's create: connected, the page is the agent's, a confirmed Page when targeted.
  async function gates(phone, pageId, targets) {
    const conn = (await db.getConnection(phone)) || {};
    if (!conn.facebook_browser_connected_at) return { status: 409, error: "facebook_not_connected" };
    const page = await db.getPage(pageId);
    if (!page || page.business_phone !== phone) return { status: 404, error: "not_found" };
    const wanted = targets || S_.DEFAULT_TARGETS;
    if (wanted.includes("page") && !S_.pageConfirmed(conn)) return { status: 409, error: "page_not_confirmed" };
    if (targets && targets.includes("page") && !A.pageTarget(conn)) return { status: 409, error: "page_target_unavailable" };
    return { conn, page };
  }
  async function grantPermission(phone, consent) {
    await store.mutateConnection(phone, (cur) => (PC.permActive(cur.posting_permission) ? null : { posting_permission: PC.campaignPermission(cur.posting_permission, x.clock(), consent) }));
  }
  // campaigns.resume plus the manual-mode strip (no Page, no repeat) in one campaign transaction.
  async function resumeStripped(id, conn) {
    if (campaigns._test.accountBlocked(conn)) return store.getPostingCampaign(id);
    return A.mutate(x, id, (cur) => (cur.status !== "paused" ? null : {
      status: "running", pause_reason: null, consecutive_failures: 0, tick_errors: 0, selector_failures: 0,
      targets: (cur.targets || []).filter((t2) => t2 !== "page"), repeat: false, repeat_days: null,
    }));
  }
  // A restart runs as long as the run it repeats (1–30 days), unless the admin says otherwise.
  function previousDays(c) {
    const from = new Date(c.restarted_at || c.created_at).getTime(), to = new Date(c.expires_at).getTime();
    const d = Math.round((to - from) / DAY);
    return Number.isFinite(d) ? Math.min(Math.max(d, 1), 30) : 30;
  }
  const consentRecord = (req, consent) => ({ at: A.iso(x.clock()), version: S_.CONSENT_VERSION, by: "admin", admin_tail: opTail(req), method: consent.method, note: consent.note });
  const notifyDeps = Object.assign({}, deps, { messages: deps.messages });

  // ── reads ──
  router.get("/campaigns", requireAdmin, wrap(async (req, res) => {
    const want = STATUSES.includes(req.query.status) ? [req.query.status] : STATUSES;
    let all = [];
    for (const s of want) all = all.concat(await store.listPostingCampaignsByStatus(s, 200));
    if (req.query.agent) all = all.filter((c) => M.refOf(c.phone) === String(req.query.agent));
    all.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    res.json({ campaigns: await Promise.all(all.map(rowOf)), manual: manual() });
  }));
  router.get("/agents", requireAdmin, wrap(async (req, res) => {
    const out = [];
    for (const p of await phones()) out.push({ ref: M.refOf(p), phone_tail: A.tail(p), name: await nameOf(p) });
    out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json({ agents: out });
  }));
  router.get("/agents/:ref/properties", requireAdmin, wrap(async (req, res) => {
    const phone = await phoneOf(req.params.ref);
    if (!phone) return res.status(404).json({ error: "not_found" });
    const pages = await db.listPagesByPhone(phone);
    res.json({ properties: pages.filter((p) => p.status !== "deleted").map((p) => ({ page_id: p.page_id, title: ((p.property || {}).title) || p.page_id })) });
  }));
  router.get("/agents/:ref/groups", requireAdmin, wrap(async (req, res) => {
    const phone = await phoneOf(req.params.ref);
    if (!phone) return res.status(404).json({ error: "not_found" });
    const conn = (await db.getConnection(phone)) || {};
    const members = S_.memberList(conn).filter((m) => m.membership_state === "member");
    res.json({ groups: members.map((m) => ({ group_id: String(m.group_id), name: m.name || "", url: S_.memberUrl(m) })) });
  }));

  // How long a set of posts takes at the account's limits today (an estimate).
  router.post("/estimate", requireAdmin, wrap(async (req, res) => {
    const b = req.body || {};
    const phone = await phoneOf(b.agent);
    const ids = S_.parseGroupIds(b.group_ids, { required: false });
    if (!phone || ids.error) return res.status(400).json({ error: "invalid_input" });
    const now = x.clock();
    const conn = (await db.getConnection(phone)) || {};
    const live = (await store.listPostingCampaignsByPhone(phone)).filter((c) => LIVE.has(c.status) && c.page_id !== b.page_id);
    const days = Number.isFinite(b.days) ? Math.min(Math.max(b.days, 1), 30) : 30;
    // What the agent's other live campaigns still take within these days: this
    // pass's owed groups, every later repeat pass, and a Page post not yet made.
    const owed = live.reduce((n, c) => {
      const pass = M.groupsOf(c);
      const left = Math.min(days, Math.max(0, (new Date(c.expires_at).getTime() - now.getTime()) / DAY));
      const later = !manual() && c.repeat_days > 0 ? Math.max(0, Math.ceil(left / c.repeat_days) - 1) * pass.length : 0;
      const page = !manual() && (c.targets || []).includes("page") && !A.currentPosts(c).some((p) => p.target === "page" && p.status !== "skipped") ? 1 : 0;
      return n + pass.filter((g) => g.status === "owed").length + later + page;
    }, 0);
    // A repeating campaign comes back to each group every repeat_days within its days;
    // the Page takes one post per 30 days. Manual posting has neither.
    const repeat = !manual() && Number.isInteger(b.repeat_days) && b.repeat_days >= 3 && b.repeat_days <= 30 ? b.repeat_days : 0;
    const passes = repeat ? Math.ceil(days / repeat) : 1;
    const page = !manual() && Array.isArray(b.targets) && b.targets.includes("page") && A.pageTarget(conn) ? 1 : 0;
    const config = await A.configOf(deps, x);
    const account = await A.accountView(phone, conn, deps, now);
    res.json(require("../posting-limits").estimate({ posts: owed + (ids.ids || []).length * passes + page, account, now, config, daysLeft: days }));
  }));

  // ── create ──
  router.post("/campaigns", ...guard, wrap(async (req, res) => {
    const b = req.body || {};
    const consent = consentOf(b);
    if (!consent) return res.status(400).json({ error: "consent_note_required" });
    const v = PC.validCreate(b);
    if (!v) return res.status(400).json({ error: "invalid_input" });
    if (manualRefuses(v.targets, b.repeat_days)) return res.status(400).json({ error: "manual_unsupported" });
    const phone = await phoneOf(b.agent);
    if (!phone) return res.status(404).json({ error: "not_found" });
    const g = await gates(phone, b.page_id, v.targets);
    if (g.error) return res.status(g.status).json({ error: g.error });
    if (campaigns._test.accountBlocked(g.conn)) return res.status(409).json({ error: "account_halted" });
    if (!v.ids.length && !((v.targets || S_.DEFAULT_TARGETS).includes("page") && A.pageTarget(g.conn))) return res.status(400).json({ error: "invalid_input" });
    const vet = await PC.vetGroups(catalogFn, g.conn, g.page, v.ids, b.include_unknown === true);
    if (vet.error) return res.status(422).json(vet);
    const before = await store.getPostingCampaign(store.campaignId(phone, g.page.page_id));
    if (before && LIVE.has(before.status)) return res.json({ campaign: await rowOf(before), existing: true });
    await audit(req, "create_campaign", phone, { campaign_tail: store.campaignId(phone, g.page.page_id).slice(-6), groups: vet.groups.length, method: consent.method });
    const record = consentRecord(req, consent);
    await grantPermission(phone, record);
    const c = await campaigns.create({
      phone, page: g.page, groups: vet.groups, mode: b.mode, days: b.days, repeat: !!b.repeat_days, repeatDays: b.repeat_days || null,
      targets: v.targets || undefined, consent: record, copies: b.copies || null,
    }, deps);
    await A.say(notifyDeps, phone, "admin_created", "📣 הצוות של פורלי פתח לכם קמפיין פרסום.", c);
    res.status(201).json({ campaign: await rowOf(c) });
  }));

  // ── edit ──
  router.patch("/campaigns/:id", ...guard, wrap(async (req, res) => {
    const b = req.body || {};
    const c = S_.ID_RE.test(String(req.params.id)) ? await store.getPostingCampaign(String(req.params.id)) : null;
    if (!c) return res.status(404).json({ error: "not_found" });
    const add = b.add_group_ids === undefined ? { ids: [] } : S_.parseGroupIds(b.add_group_ids, { required: true });
    const remove = b.remove_group_ids === undefined ? { ids: [] } : S_.parseGroupIds(b.remove_group_ids, { required: true });
    const t = b.targets === undefined ? { targets: undefined } : S_.parseTargets(b.targets);
    const probe = PC.validCreate({ page_id: c.page_id, mode: b.mode || "standing", group_ids: ["1"], days: b.days, copies: b.copies,
      repeat_days: b.repeat_days === 0 ? undefined : b.repeat_days });
    if (add.error || remove.error || t.error || !probe || typeof b.version !== "string" || !b.version) return res.status(400).json({ error: "invalid_input" });
    if (b.repeat_days !== undefined && b.repeat_days !== 0 && !(b.repeat_days >= 3 && b.repeat_days <= 30)) return res.status(400).json({ error: "invalid_input" });
    if (manualRefuses(t.targets, b.repeat_days)) return res.status(400).json({ error: "manual_unsupported" });
    const edit = {};
    if (add.ids.length) {
      const g = await gates(c.phone, c.page_id, t.targets || null);
      if (g.error) return res.status(g.status).json({ error: g.error });
      const vet = await PC.vetGroups(catalogFn, g.conn, g.page, add.ids, b.include_unknown === true);
      if (vet.error) return res.status(422).json(vet);
      edit.add_groups = vet.groups;
    } else if (t.targets) {
      const g = await gates(c.phone, c.page_id, t.targets);
      if (g.error) return res.status(g.status).json({ error: g.error });
    }
    if (remove.ids.length) edit.remove_group_ids = remove.ids;
    for (const k of ["copies", "days", "repeat_days", "mode"]) if (b[k] !== undefined) edit[k] = b[k];
    if (t.targets) edit.targets = t.targets;
    const detail = { campaign_tail: c.id.slice(-6), fields: Object.keys(edit).join(",") };
    await audit(req, "edit_campaign", c.phone, detail);
    const out = await refused(req, "edit_campaign", c.phone, detail, () => admin.update(c.id, edit, deps, { version: b.version, by: "admin" }));
    res.json({ campaign: await rowOf(out) });
  }));

  // ── stop / start ──
  router.post("/campaigns/:id/stop", ...guard, wrap(async (req, res) => {
    const c = S_.ID_RE.test(String(req.params.id)) ? await store.getPostingCampaign(String(req.params.id)) : null;
    if (!c) return res.status(404).json({ error: "not_found" });
    const was = c.status;
    await audit(req, "stop_campaign", c.phone, { campaign_tail: c.id.slice(-6) });
    const out = await campaigns.stop(c.id, deps, "admin");
    if (LIVE.has(was)) await A.say(notifyDeps, c.phone, "admin_stopped", "✋ הצוות עצר את הקמפיין. מה שכבר פורסם נשאר.", out);
    res.json({ campaign: await rowOf(out) });
  }));
  router.post("/campaigns/:id/start", ...guard, wrap(async (req, res) => {
    const c = S_.ID_RE.test(String(req.params.id)) ? await store.getPostingCampaign(String(req.params.id)) : null;
    if (!c) return res.status(404).json({ error: "not_found" });
    if (c.status === "running") return res.json({ campaign: await rowOf(c) });
    const conn = (await db.getConnection(c.phone)) || {};
    if (campaigns._test.accountBlocked(conn)) return res.status(409).json({ error: "account_halted" });
    let out;
    const detail = { campaign_tail: c.id.slice(-6), from: c.status };
    if (c.status === "paused") {
      // Manual posting: a campaign resumed here goes on as the manual flow runs it — groups once, no Page.
      const strip = manual() && ((c.targets || []).includes("page") || c.repeat);
      if (strip && !(c.groups || []).length) return res.status(400).json({ error: "no_destination" });
      if (strip) detail.fields = ["targets", "repeat"].filter((f) => (f === "targets" ? (c.targets || []).includes("page") : c.repeat)).join(",");
      await audit(req, "start_campaign", c.phone, detail);
      // The resume and the strip are one transaction: a refused resume changes nothing, and nothing runs unstripped.
      out = strip ? await resumeStripped(c.id, conn) : await campaigns.resume(c.id, deps);
    } else {
      const consent = consentOf(req.body);
      if (!consent) return res.status(400).json({ error: "consent_note_required" });
      const b = req.body || {};
      if (b.days !== undefined && !(Number.isFinite(b.days) && b.days >= 1 && b.days <= 30)) return res.status(400).json({ error: "invalid_input" });
      // Manual posting: one pass, groups only (what the manual flow can publish).
      const targets = manual() ? (c.targets || []).filter((t2) => t2 !== "page") : c.targets;
      const repeatDays = manual() ? null : c.repeat_days || null;
      const g = await gates(c.phone, c.page_id, targets && targets.includes("page") ? targets : null);
      if (g.error) return res.status(g.status).json({ error: g.error });
      if (!(c.groups || []).length && !((targets || []).includes("page") && A.pageTarget(g.conn))) return res.status(400).json({ error: "no_destination" });
      const days = b.days !== undefined ? b.days : previousDays(c);
      detail.days = days;
      await audit(req, "start_campaign", c.phone, detail);
      const record = consentRecord(req, consent);
      await grantPermission(c.phone, record);
      out = await campaigns.create({
        phone: c.phone, page: g.page, groups: c.groups, mode: c.mode, days, repeat: !!repeatDays, repeatDays,
        targets, consent: record, copies: Object.fromEntries((c.groups || []).filter((x2) => x2.copy).map((x2) => [x2.group_id, x2.copy])),
      }, deps);
    }
    if (!out || out.status !== "running") {
      // Halted, or changed under us (stopped by the agent, already running elsewhere): the row says which.
      const why = !out || out.status === c.status ? "account_halted" : "not_live";
      await refusalRow(req, "start_campaign", c.phone, detail, why);
      return res.status(409).json({ error: why });
    }
    res.json({ campaign: await rowOf(out) });
  }));

  return router;
};
