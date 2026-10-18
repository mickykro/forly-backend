/*
 * routes/admin-manual-lane.js — the semi-automatic run of one agent's open
 * browser in the "פרסום ידני" tab (posting-manual-prep).
 *
 * ▶ prepares the agent's next owed target; the tab chimes when it is ready;
 * the admin clicks Post in Facebook and presses "הבא": the browser is looked
 * at (posted / not posted / unsure), the target recorded, the next one
 * prepared. "הבא" with no post asks for a skip reason (posting-manual.skip).
 * A target the agent's group limit blocks now is passed over (it stays owed);
 * one the agent has not approved the text for is never prepared.
 *
 * The state lives on the open browser's entry (s.lane) — in memory, like the
 * browser itself; the work list is the checklist, so reopening resumes.
 * Every change is pushed down the viewer's event stream ({ t: "lane" }) as
 * well as answered on /state.
 */
const A = require("../posting-account");
const L = require("../posting-limits");
const M = require("../posting-manual");

const PREP_MS = 3 * 60000;

module.exports = function createLane({ deps, open, hubPage, videoFor, emit, prep = require("../posting-manual-prep") }) {
  const x = A.ctxOf(deps);

  function view(s) {
    const l = s && s.lane;
    if (!l) return null;
    const i = l.item;
    return { state: l.state, code: l.code || null, warn: l.warn || null, check: l.check || null, until: l.until || null, left: l.left || 0,
      item: i ? { campaign_id: i.campaign_id, group_id: i.group_id, group_name: i.group_name || "", group_url: i.group_url, kind: i.kind || "group", title: i.title || "", page_id: i.page_id } : null };
  }
  const set = (phone, s, patch) => { s.lane = Object.assign({}, s.lane, patch); emit(phone, { t: "lane", lane: view(s) }); };

  // The agent's next target: owed, its text approved, not blocked by a limit now.
  async function nextItem(phone) {
    const ref = M.refOf(phone);
    const mine = (await M.queue(deps)).filter((i) => i.ref === ref && !i.awaiting_agent);
    const free = mine.filter((i) => !(i.limit && i.limit.block));
    const untils = mine.filter((i) => i.limit && i.limit.block && i.limit.block.until).map((i) => i.limit.block.until).sort();
    return { item: free[0] || null, left: free.length, until: free.length ? null : untils[0] || null };
  }

  async function advance(phone, s) {
    const gen = (s.lane.gen || 0) + 1;
    s.lane.gen = gen;
    const { item, left, until } = await nextItem(phone);
    if (open.get(phone) !== s || s.lane.gen !== gen) return;
    if (!item) return set(phone, s, { state: until ? "blocked" : "empty", item: null, code: null, until, left: 0 });
    set(phone, s, { state: "preparing", item, code: null, warn: null, check: null, until: null, left });
    const alive = () => open.get(phone) === s && s.lane.gen === gen;
    const work = (async () => {
      const page = hubPage(phone);
      if (!page) return { ok: false, code: "no_viewer" };
      s.pageId = item.page_id;
      const doc = await x.db.getPage(String(item.page_id));
      let file = null;
      if (doc && require("../posting-campaign").videoOf(doc).video_url) {
        try { file = await videoFor(s, doc); } catch (e) { return { ok: false, code: (e && e.code) || "media_unavailable" }; }
      }
      if (!alive()) return { ok: false, code: "cancelled" };
      const conn = (await x.db.getConnection(phone)) || {};
      return prep.prepare(page, item, conn, { file, alive });
    })().catch(() => ({ ok: false, code: "prep_error" }));
    let timer;
    const late = new Promise((r) => { timer = setTimeout(() => r({ ok: false, code: "prep_timeout" }), PREP_MS); if (timer.unref) timer.unref(); });
    const r = await Promise.race([work, late]);
    clearTimeout(timer);
    if (!alive()) return;
    if (r.code === "prep_timeout") s.lane.gen++; // stops the late preparation at its next step
    set(phone, s, r.ok ? { state: "ready", pendingBefore: !!r.pendingBefore, warn: r.warn || null, check: r.check || null } : { state: "failed", code: r.code });
  }

  // ▶: starts (or restarts after an end) the run; a run under way is left alone.
  async function run(phone, s) {
    if (!s.lane) s.lane = { gen: 0 };
    if (!["preparing", "ready", "held", "loading"].includes(s.lane.state)) {
      set(phone, s, { state: "loading", item: null, code: null });
      advance(phone, s).catch(() => set(phone, s, { state: "failed", code: "prep_error" }));
    }
    return view(s);
  }

  // The post went up: recorded as posted even if a limit changed meanwhile —
  // it IS on Facebook — with an audit row when the limit would have blocked it.
  async function recordPosted(phone, item, user) {
    const cur = await x.store.getPostingCampaign(String(item.campaign_id));
    if (cur) {
      const now = x.clock();
      const agent = await L.agentPosts(cur.phone, deps, x, now);
      const lim = L.limitsFor(cur, agent.campaigns, now, await A.configOf(deps, x), agent)[String(item.group_id)];
      if (lim && lim.block) {
        const dtail = (p) => String(p || "").replace(/\D/g, "").slice(-4);
        await x.store.addAuditEvent({ operator_tail: dtail(user && user.userId), action: "manual_limit_after_post", target_phone_tail: dtail(cur.phone),
          detail: { why: lim.block.why, campaign_tail: String(cur.id).slice(-6) } }, x.clock()).catch(() => {});
      }
    }
    return M.markDone(String(item.campaign_id), String(item.group_id), "posted", deps);
  }

  /*
   * "הבא". body: {} (look and decide), { posted: true } (the admin confirms
   * an unsure look), or { reason, note } (a skip). → { lane, need?, recorded? }
   * need: "reason" (nothing went up: pick one) | "confirm" (could not tell).
   */
  async function next(phone, s, body = {}, user = null) {
    const l = s.lane;
    if (!l) return { error: "not_running" };
    const item = l.item;
    const reason = typeof body.reason === "string" ? body.reason : null;
    const note = typeof body.note === "string" ? body.note.trim() : null;
    if (reason && (!M.SKIP_REASONS.has(reason) || reason === "prep_failed")) return { error: "invalid_input" };
    if (reason === "other" && (!note || note.length < 3 || note.length > 200)) return { error: "invalid_input" };
    let recorded = null, c = null;
    if (item && body.posted === true && ["ready", "held", "failed"].includes(l.state)) { c = await recordPosted(phone, item, user); recorded = "posted"; }
    else if (item && reason) { c = await M.skip(item.campaign_id, item.group_id, reason, deps, { note: reason === "other" ? note : l.code || null, ref: M.refOf(phone) }); recorded = "skipped"; }
    else if (item && l.state === "preparing") { l.gen++; set(phone, s, { state: "held" }); return { lane: view(s), need: "reason" }; }
    else if (item && ["ready", "held", "failed"].includes(l.state)) {
      // After a failed preparation the admin may still have posted by hand: look, and ask when it cannot be seen.
      const page = hubPage(phone);
      const seen = page ? await prep.check(page, item, (await x.db.getConnection(phone)) || {}, { pendingBefore: l.pendingBefore }) : "unsure";
      if (seen === "not_posted" && l.state !== "failed") { set(phone, s, { state: "held" }); return { lane: view(s), need: "reason" }; }
      if (seen !== "posted" && l.state === "failed") { set(phone, s, { state: "held" }); return { lane: view(s), need: "confirm" }; }
      if (seen === "unsure") { set(phone, s, { state: "held" }); return { lane: view(s), need: "confirm" }; }
      c = await recordPosted(phone, item, user); recorded = "posted";
    }
    // Recorded, or nothing to record (the campaign ended, the target was ticked elsewhere): on to the next.
    set(phone, s, { state: "loading", item: null, code: null });
    advance(phone, s).catch(() => set(phone, s, { state: "failed", code: "prep_error" }));
    return { lane: view(s), recorded: c ? recorded : null, completed: !!(c && c.status === "completed") };
  }

  return { view, run, next, advance };
};
