/*
 * publish-campaign.js — the campaign card on publish.html (Task 23): Forly
 * posts this property in the agent's own Facebook groups, slowly, under a
 * consent given on this card. routes/posting*.js governs every shape here.
 *
 * Never rendered: a wss:// or viewer URL, a profile name, a phone, a raw
 * error message (only Hebrew per error code). Every group name is escaped —
 * names come from Facebook. The only links out are https facebook.com URLs.
 *
 * The pure helpers are CampaignUI; under node it is module.exports
 * (publish-campaign.test.js). In the browser publish.js calls
 * window.ForlyCampaign.mount({ pageId, toast }) once the share session loads.
 */
(function (root) {
  "use strict";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const when = (iso, opts) => {
    const d = iso ? new Date(iso) : null;
    return d && !isNaN(d) ? d.toLocaleString("he-IL", Object.assign({ timeZone: "Asia/Jerusalem", weekday: "short", day: "numeric", month: "numeric" }, opts)) : "";
  };
  const fmt = (iso) => when(iso, { hour: "2-digit", minute: "2-digit" });
  // Only an https facebook.com URL may become a link: never a viewer, a wss:// or anything else.
  const fbUrl = (u) => (typeof u === "string" && /^https:\/\/(?:www\.|m\.|web\.)?facebook\.com\/[^\s"'<>\\]*$/i.test(u) && !/wss?:|viewer/i.test(u) ? u : null);
  const DISALLOWED = new Set(["forbidden", "disallowed", "not_allowed", "no_agents"]);
  // The Pages the card may offer (I4): none until the server says a Page
  // target is available (its numeric id was read at connect), and only those.
  const cardPages = (settings) => (settings && settings.page_target_available === true && Array.isArray(settings.pages)
    ? settings.pages.filter((p) => p && p.available === true) : []);

  const OFF_FOR_ALL = "הפרסום האוטומטי כבוי כרגע אצלנו, לכל החשבונות. נחזור בקרוב — לא צריך לעשות כלום. אפשר תמיד לעצור.";
  const DISABLED = {
    env_off: OFF_FOR_ALL, global_off: OFF_FOR_ALL,
    platform_off: "הפרסום האוטומטי בפייסבוק כבוי כרגע אצלנו. נחזור בקרוב — לא צריך לעשות כלום. אפשר תמיד לעצור.",
    account_disabled: "הפרסום מהחשבון שלכם מושהה עד שהצוות שלנו יבדוק אותו — נחזור אליכם.",
    account_penalty: "פייסבוק ביקשה להאט, אז היום פורלי לא מפרסמת. ממשיכים בקצב איטי יותר.",
    profile_revoked: "החיבור לחשבון הפייסבוק האישי שלכם נותק. חברו אותו מחדש מעמוד ההפצה כדי להמשיך.",
    no_permission: "ההרשאה לפורלי לפרסם בשמכם לא בתוקף. צריך לאשר מחדש כדי להמשיך.",
    permission_scope: "ההרשאה לפורלי לפרסם בשמכם לא בתוקף. צריך לאשר מחדש כדי להמשיך.",
  };
  const disabledText = (reason) => DISABLED[reason] || "הפרסום האוטומטי כבוי כרגע. אפשר תמיד לעצור.";

  const ERRORS = {
    not_member: "אתם כבר לא חברים באחת הקבוצות שסימנתם — הורדנו אותה מהבחירה. רעננו את הרשימה ונסו שוב.",
    unknown_group: "באחת הקבוצות לא ברור אם מתווכים מורשים לפרסם. הציצו בכללים שלה ונסו שוב.",
    group_disallowed: "אחת הקבוצות לא מאפשרת פרסום מתווכים — הורדנו אותה מהבחירה.",
    listing_type_not_allowed: "אחת הקבוצות לא מתאימה לסוג העסקה של הנכס — הורדנו אותה מהבחירה.",
    needs_reconnect: "צריך לחבר מחדש את חשבון הפייסבוק האישי לפני שממשיכים.",
    page_not_confirmed: "יש לכם כמה דפים עסקיים — בחרו באיזה מהם לפרסם.",
    unknown_page: "הדף העסקי שבחרתם כבר לא מחובר — בחרו דף אחר.",
    profile_busy: "פורלי עסוקה בחשבון שלכם כרגע — נסו שוב בעוד כמה דקות.",
    driver_busy: "הדפדפן שלנו עמוס כרגע — נסו שוב בעוד דקה.",
    sync_failed: "לא הצלחנו לקרוא את הקבוצות שלכם — נסו שוב מאוחר יותר.",
    consent_required: "סמנו את האישור שמעל הכפתור.",
    consent_outdated: "נוסח האישור התעדכן — קראו אותו וסמנו שוב.",
    facebook_not_connected: "קודם חברו את החשבון האישי שלכם בפייסבוק.",
    too_many_campaigns: "כבר יש שלושה נכסים בפרסום אוטומטי — עצרו אחד מהם קודם.",
    not_paused: "הפרסום כבר לא מושהה.",
    not_resumable: "אי אפשר להמשיך כרגע — החשבון עדיין ממתין לבדיקה.",
    needs_developer: "הצוות שלנו מתקן תקלה אצלנו ויחזיר את הפרסום בעצמו — לא צריך לעשות כלום.",
    page_target_unavailable: "עוד אי אפשר לפרסם אוטומטית בדף העסקי — חברו מחדש את החשבון כדי שנזהה את הדף.",
    not_found: "לא מצאנו את זה — רעננו את העמוד.", post_not_found: "הפוסט הזה כבר לא קיים — רעננו את העמוד.",
    invalid_input: "משהו בבחירה לא תקין — בדקו ונסו שוב.",
  };
  function errorText(e) {
    const code = e && e.code, body = (e && e.body) || {};
    if (code === "posting_disabled") return disabledText(body.reason);
    if (code === "too_soon") {
      const min = Math.max(1, Math.ceil((Number(body.retry_after_s) || 600) / 60));
      return `רעננו לפני רגע. אפשר לרענן שוב בעוד ${min} דק׳.`;
    }
    return ERRORS[code] || "משהו השתבש — נסו שוב.";
  }

  // Why nothing is scheduled right now: the planner's reason, in words.
  const WAIT = {
    browse_only: "בימים הראשונים פורלי רק גוללת וקוראת בפייסבוק מהחשבון שלכם — הפוסט הראשון יעלה אחר כך.",
    day_skipped: "היום פורלי נחה — ממשיכים מחר.", daily_cap: "היום כבר עלו מספיק פוסטים — ממשיכים מחר.",
    weekly_cap: "השבוע כבר עלו מספיק פוסטים — ממשיכים בשבוע הבא.", penalty: "פייסבוק ביקשה להאט — פורלי מחכה ומפרסמת לאט יותר.",
    disabled: "הפרסום מהחשבון מושהה — ההסבר למעלה.",
    no_eligible_group: "אין כרגע קבוצה פנויה — כל הקבוצות שבחרתם קיבלו פוסט לאחרונה או לא זמינות.",
    duplicate: "הנכס כבר פורסם לאחרונה בקבוצות האלה — ממתינים לפני שמפרסמים שוב.",
    no_slot_in_horizon: "אין חלון פרסום פנוי בימים הקרובים (שבת או חג) — ממשיכים אחריו.",
    inactive_time: "מחוץ לשעות הפרסום — ממשיכים בשעות היום.", min_gap: "פורלי מחכה קצת בין פוסט לפוסט.",
    infrastructure: "תקלה זמנית אצלנו — פורלי תנסה שוב בקרוב. לא צריך לעשות כלום.",
    group_cap: "הקבוצה קיבלה היום מספיק פוסטים — ננסה מחר.",
  };
  function waitText(reason) {
    if (typeof reason !== "string" || !reason) return "אין פוסט מתוכנן כרגע — פורלי תתזמן את הבא בחלון הקרוב.";
    if (reason.startsWith("posting_disabled:")) return disabledText(reason.slice(17));
    return WAIT[reason] || "אין פוסט מתוכנן כרגע — פורלי תתזמן את הבא בחלון הקרוב.";
  }

  // An estimate, worded as one — never a promise.
  function estimateText(iso, reason) {
    if (iso && when(iso)) return `הערכה: הפוסט הראשון יעלה בערך ב${fmt(iso)}, אם החיבור והקבוצות יהיו זמינים. זו הערכה, לא התחייבות.`;
    if (reason === "browse_only") return "הערכה: בימים הראשונים אחרי החיבור פורלי רק גוללת וקוראת, ולכן עוד אין מועד משוער לפוסט הראשון.";
    return WAIT[reason] && reason !== "browse_only" ? `כרגע: ${WAIT[reason]}` : "";
  }
  const FIRST_WEEK = "השבוע הראשון הוא חימום: בימים 1–3 פורלי רק גוללת וקוראת בפייסבוק מהחשבון שלכם, בלי לפרסם. מהיום הרביעי — פוסט אחד ביום לכל היותר, ורק אחרי השבוע הראשון קצת יותר.";

  // Halt boxes, one per class, worded like posting-messages.js's WhatsApp texts.
  const HALT = {
    owner: "⚠️ פייסבוק הגבילה את החשבון. הפרסום מושהה עד שהצוות שלנו יבדוק את זה יחד איתכם — נחזור אליכם. בינתיים לא צריך לעשות כלום.",
    checkpoint: "⚠️ פייסבוק ביקשה לוודא שזה אתם. הפרסום מושהה עד שתשלימו את האימות בפורלי, ואז הצוות שלנו יפעיל אותו מחדש.",
    restricted: "⚠️ פייסבוק הגבילה את החשבון. הפרסום מושהה — הצוות שלנו כבר בודק ויחזור אליכם. לא צריך לעשות כלום.",
    suspected_compromise: "⚠️ פייסבוק זיהתה פעילות חריגה בחשבון. חברו את החשבון מחדש, ואז הצוות שלנו יבדוק את זה יחד איתכם לפני שהפרסום יחזור.",
    team: "⚠️ פייסבוק עצרה את הפרסום מהחשבון. הפרסום מושהה עד שהצוות שלנו יבדוק — נחזור אליכם.",
    reconnect: "🔑 החיבור לחשבון הפייסבוק פג. כדי שהפרסום ימשיך, צריך לחבר אותו מחדש מעמוד ההפצה, ואז ללחוץ \"להמשיך\".",
    consecutive_failures: "⏸ שני פוסטים ברצף לא עלו, אז פורלי עצרה לבדוק. בדקו שאתם עדיין חברים בקבוצות, ואז אפשר להמשיך.",
    internal: "⏸ משהו אצלנו לא עבד כמו שצריך, אז פורלי עצרה את הפרסום של הנכס הזה. הצוות שלנו כבר מתקן את זה ויחזיר את הפרסום — לא צריך לעשות כלום.",
    permission: "⏸ הפרסום מושהה כי ההרשאה לפורלי לפרסם בשמכם בוטלה. כדי להמשיך צריך לאשר מחדש.",
    agent: "⏸ הפרסום מושהה. לחצו \"להמשיך\" כשתרצו.",
    account: "החשבון חזר לפעולה. לחצו \"להמשיך\" כדי שפורלי תחזור לפרסם.",
  };
  // halt_state.disabled_class (routes/posting-settings.js) → the box. An
  // action is offered only where the agent's reconnect is the next step.
  const DISABLED_BOX = {
    captcha: { cls: "checkpoint", verify: true }, checkpoint: { cls: "checkpoint", verify: true },
    restricted: { cls: "restricted" }, suspected_compromise: { cls: "suspected_compromise", reconnect: true },
  };
  const PENALTY_LEAD = {
    rate_limited: "🐢 פייסבוק ביקשה להאט.", feature_blocked: "🐢 פייסבוק חסמה זמנית את הפרסום.",
    confirmed_removed: "🐢 מנהלי קבוצות הסירו כמה פוסטים לאחרונה.",
  };
  const penaltyText = (until, cls) => `${PENALTY_LEAD[cls] || PENALTY_LEAD.rate_limited} פורלי כבר האטה את קצב הפרסום אוטומטית — נחזור לקצב הרגיל בערך ב${when(until) || "עוד שבועיים"}. לא צריך לעשות כלום.`;
  // → { cls, text, reconnect?, verify?, resume?, reconsent? } or null. The account's halt state first, then this campaign's pause.
  function haltInfo(h, c) {
    h = h || {};
    if (h.owner_review_required) return { cls: "owner", text: HALT.owner };
    if (h.disabled_until_admin) {
      const box = DISABLED_BOX[h.disabled_class] || { cls: "team" };
      return Object.assign({ text: HALT[box.cls] }, box);
    }
    if (h.needs_reconnect) return { cls: "reconnect", text: HALT.reconnect, reconnect: true };
    if (h.posting_off) return { cls: "off", text: disabledText(h.posting_off) };
    if (c && c.status === "paused") {
      const r = c.pause_reason;
      if (r === "permission") return { cls: "paused", text: HALT.permission, reconsent: true };
      if (r === "internal") return { cls: "paused", text: HALT.internal }; // R5: the team resumes it, not the agent
      return { cls: "paused", text: HALT[r] || HALT.agent, resume: true };
    }
    if (c && c.status === "running" && /^posting_disabled:/.test(c.wait_reason || "")) return { cls: "off", text: waitText(c.wait_reason) };
    if (h.penalty_until) return { cls: "penalty", text: penaltyText(h.penalty_until, h.penalty_class) };
    return null;
  }
  // Approving is pointless while nothing may post: a disabled account, day one
  // of a penalty, a pending reconnect, or posting switched off. Skip and STOP stay.
  function approveBlocked(h, c) {
    h = h || {};
    return !!(h.disabled_until_admin || h.owner_review_required || h.needs_reconnect || h.penalty_blocks_posts || h.posting_off
      || (c && /^posting_disabled:/.test(c.wait_reason || "")));
  }

  const SKIPPED = {
    stopped: "בוטל בעצירה", agent: "דילגתם", not_member: "אינכם חברים בקבוצה", group_blocked: "הקבוצה לא מאפשרת פרסום",
    ineligible: "הקבוצה לא זמינה לפרסום", duplicate: "כבר פורסם שם לאחרונה", expired: "תקופת הפרסום הסתיימה",
  };
  const STATUS = {
    scheduled: "מתוכנן", pending_approval: "ממתין לאישור שלכם", posting: "מפרסמים עכשיו…", posted: "פורסם",
    pending_group_approval: "ממתין לאישור מנהלי הקבוצה", failed: "לא עלה", unknown: "בבדיקה",
  };
  const statusText = (p) => (p.status === "skipped" ? SKIPPED[p.error_code] || "דולג" : STATUS[p.status] || "בבדיקה");
  const VISIBILITY = { confirmed_removed: "הוסר ע״י מנהלי הקבוצה", pending_approval: "ממתין לאישור מנהלי הקבוצה", access_denied: "אין גישה לקבוצה" };
  const num = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  function metricsText(m) {
    if (!m || typeof m !== "object") return "";
    const parts = [`${num(m.visits) || 0} כניסות`, `${num(m.leads) || 0} לידים`];
    if (num(m.reactions) !== null) parts.push(`${m.reactions} לייקים`);
    if (num(m.comments) !== null) parts.push(`${m.comments} תגובות`);
    if (VISIBILITY[m.visibility]) parts.push(VISIBILITY[m.visibility]);
    return parts.join(" · ");
  }
  const REACH_NOTE = "חשיפה (reach) לא זמינה בקבוצות — פייסבוק לא מוסרת אותה. סופרים כניסות ולידים מהקישור שבפוסט, ולייקים ותגובות שבודקים כיממה אחרי הפרסום.";

  const usable = (g) => !!g && g.membership_state === "member" && !DISALLOWED.has(g.agent_policy);
  function groupNote(g) {
    if (g.membership_state !== "member") return "לא חברים כרגע";
    if (DISALLOWED.has(g.agent_policy)) return "הקבוצה לא מאפשרת פרסום מתווכים";
    if (g.agent_policy === "explicitly_allowed") return "מתווכים מורשים";
    return "בדקו את כללי הקבוצה";
  }
  // Up to five ticked: the saved default groups, else catalog-approved groups first (the API gives no member counts).
  function defaultPicks(members) {
    const ok = (Array.isArray(members) ? members : []).filter(usable);
    const defs = ok.filter((g) => g.is_default);
    const rank = (g) => (g.agent_policy === "explicitly_allowed" ? 0 : g.in_catalog ? 1 : 2);
    return (defs.length ? defs : ok.slice().sort((a, b) => rank(a) - rank(b))).slice(0, 5).map((g) => String(g.group_id));
  }
  function planText(mode, n, withPage) {
    const where = `${n} ${n === 1 ? "קבוצה" : "קבוצות"}${withPage ? " ובדף העסקי" : ""}`;
    return mode === "standing"
      ? `פורלי תפרסם פעם אחת ב-${where}, בקצב שלה במשך השבועיים הקרובים, ואז תעצור לבד.`
      : `לפני כל פוסט (${where}) תקבלו וואטסאפ עם הטקסט לאישור. בלי אישור לא מפרסמים.`;
  }
  const chipText = (c) => (!c ? "" : c.status === "running" ? "פעיל" : c.status === "paused" ? "מושהה" : c.status === "stopped" ? "נעצר"
    : c.status === "completed" ? `הושלם — ${(c.posts || []).filter((p) => p.status === "posted").length} פוסטים עלו` : "");
  // A restarted campaign keeps its earlier posts as history (posting-campaign.create).
  function splitPasses(c) {
    const posts = (c && Array.isArray(c.posts) ? c.posts : []).filter(Boolean);
    const t0 = c && c.restarted_at ? new Date(c.restarted_at).getTime() : NaN;
    if (!Number.isFinite(t0)) return { current: posts, earlier: [] };
    const old = (p) => (p.status === "skipped" && p.error_code === "stopped") || new Date(p.posted_at || p.scheduled_at || 0).getTime() < t0;
    return { current: posts.filter((p) => !old(p)), earlier: posts.filter(old) };
  }

  const CampaignUI = {
    esc, fmt, fbUrl, cardPages, errorText, disabledText, waitText, estimateText, haltInfo, approveBlocked, statusText, metricsText, usable, groupNote,
    defaultPicks, planText, chipText, splitPasses, FIRST_WEEK, REACH_NOTE, HALT, ERRORS,
  };
  if (typeof module === "object" && module.exports) { module.exports = CampaignUI; return; }
  root.ForlyCampaign = { mount: (opts) => mount(CampaignUI, opts || {}) };

  // ── the browser half ──
  function mount(U, { pageId, toast }) {
    const $ = (id) => document.getElementById(id);
    if (!$("campaignCard") || !pageId) return;
    const say = typeof toast === "function" ? toast : () => {};
    const api = (path, opts) => fetch(path, Object.assign({ credentials: "include", headers: { "content-type": "application/json" } }, opts))
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw Object.assign(new Error("request failed"), { code: j.error || `http_${r.status}`, status: r.status, body: j });
        return j;
      });
    const put = (path, body) => api(path, { method: "PUT", body: JSON.stringify(body) });
    const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });
    let settings = null, campaign = null, picked = new Set(), consentGiven = false, timer = null;
    const members = () => (settings && settings.member_groups) || [];
    const pages = () => U.cardPages(settings);
    const mode = () => (document.querySelector('input[name="campMode"]:checked') || {}).value || "per_post";
    const live = (c) => !!c && (c.status === "running" || c.status === "paused");
    // The Page is opt-in (never a default): the Graph "פרסום בדף הפייסבוק" above is outside the campaign's duplicate checks.
    const pageOn = () => pages().length > 0 && !!($("campPageOn") || {}).checked;
    const withPage = () => pageOn() && (pages().length === 1 || !!($("campPageSelect") || {}).value);

    async function loadSettings() {
      settings = await api(`/api/posting/settings?page_id=${encodeURIComponent(pageId)}`);
      const perm = settings.permission || {};
      consentGiven = perm.enabled === true && perm.consent_current === true;
      picked = new Set(U.defaultPicks(settings.member_groups));
      $("campAutoEnroll").checked = perm.enabled === true && (perm.default_group_ids || []).length > 0;
      $("campVisible").checked = perm.allows_visible_interactions === true;
      renderPages(perm.page_id);
    }

    function renderPages(chosen) {
      const ps = pages(), box = $("campPageTarget");
      box.innerHTML = !ps.length ? "" : `<label class="camp-consent"><input type="checkbox" id="campPageOn"> <span><strong>גם בדף העסקי</strong>` +
        (ps.length === 1 ? `<small>${U.esc(ps[0].name)} · אם כבר פרסמתם בדף מלמעלה, אל תסמנו — שלא יעלה פעמיים.</small>`
          : `<small>אם כבר פרסמתם בדף מלמעלה, אל תסמנו — שלא יעלה פעמיים.</small>`) + `</span></label>` +
        (ps.length > 1 ? `<label class="camp-page-pick" hidden>באיזה דף: <select id="campPageSelect"><option value="">בחרו דף…</option>` +
          ps.map((p) => `<option value="${U.esc(p.id)}"${p.id === chosen ? " selected" : ""}>${U.esc(p.name)}</option>`).join("") + `</select></label>` : "");
      if (!ps.length) return;
      $("campPageOn").addEventListener("change", () => { const l = box.querySelector(".camp-page-pick"); if (l) l.hidden = !$("campPageOn").checked; renderSetup(); });
      if ($("campPageSelect")) $("campPageSelect").addEventListener("change", renderSetup);
    }

    function renderSetup() {
      if (!settings) return;
      const ms = members();
      $("campMemberGroups").innerHTML = ms.map((g) => {
        const id = U.esc(g.group_id), ok = U.usable(g), on = ok && picked.has(String(g.group_id));
        return `<div class="camp-g${on ? " on" : ""}${ok ? "" : " off"}"><label><input type="checkbox" data-id="${id}"${on ? " checked" : ""}${ok ? "" : " disabled"}>` +
          ` <span class="camp-gn">${U.esc(g.name)}</span> <small>${U.esc(U.groupNote(g))}</small></label>` +
          `<button type="button" class="camp-x" data-rm="${id}" title="הסרה מהרשימה" aria-label="הסרת הקבוצה מהרשימה">×</button></div>`;
      }).join("") || '<p class="camp-muted">לא מצאנו קבוצות בחשבון. הצטרפו לכמה מהקבוצות למטה ולחצו "רענון".</p>';
      const hidden = settings.hidden_group_ids || [];
      $("campUnhide").hidden = !hidden.length;
      $("campUnhide").textContent = `החזרת ${hidden.length === 1 ? "קבוצה אחת" : `${hidden.length} קבוצות`} שהסרתם`;
      const sug = (settings.suggested_groups || []).filter((g) => U.fbUrl(g.url));
      $("campSuggestedGroups").innerHTML = sug.map((g) => `<div class="camp-s"><span>${U.esc(g.name || "קבוצה")}` +
        `${g.city ? ` · ${U.esc(g.city)}` : ""}${g.members ? ` · ~${Math.max(1, Math.round(g.members / 1000))}K` : ""}</span>` +
        ` <a href="${U.esc(U.fbUrl(g.url))}" target="_blank" rel="noopener noreferrer">הצטרפות ↗</a></div>`).join("") ||
        '<p class="camp-muted">אין כרגע הצעות לאזור שלכם.</p>';
      const gs = ms.filter((g) => picked.has(String(g.group_id)));
      $("campUnknownWarn").hidden = !gs.some((g) => g.agent_policy === "unknown");
      $("campFirstPost").textContent = U.estimateText(settings.first_post_estimate, settings.first_post_wait_reason);
      $("campPlan").textContent = gs.length ? U.planText(mode(), gs.length, withPage()) : "סמנו לפחות קבוצה אחת.";
      const perm = settings.permission || {};
      $("campConsentRow").hidden = consentGiven; $("campConsentDone").hidden = !consentGiven;
      $("campConsentOld").hidden = consentGiven || !perm.consent_version;
      $("campConsentVer").textContent = settings.consent_version || "";
    }

    function row(p, c) {
      const li = document.createElement("li");
      const link = p.status === "posted" && U.fbUrl(p.post_url);
      const m = c.metrics && c.metrics[p.id];
      const stats = U.metricsText(m);
      li.innerHTML = `<div class="l1"><span class="camp-gn">${U.esc(p.group_name)}</span><span class="st st-${U.esc(p.status)}">${U.esc(U.statusText(p))}</span></div>` +
        `<div class="l2">${U.esc(U.fmt(p.posted_at || p.scheduled_at))}${link ? ` · <a href="${U.esc(link)}" target="_blank" rel="noopener noreferrer">לפוסט ↗</a>` : ""}` +
        `${stats ? ` · ${U.esc(stats)}` : ""}</div>`;
      if (p.status === "pending_approval") {
        if (typeof p.copy === "string") {
          const d = document.createElement("details"); d.open = true;
          d.innerHTML = "<summary>מה יפורסם</summary><pre></pre>"; d.querySelector("pre").textContent = p.copy; li.appendChild(d);
        }
        const bar = document.createElement("div"); bar.className = "camp-row-actions";
        const b = (label, cls, path) => {
          const el = document.createElement("button"); el.type = "button"; el.className = `btn btn-sm ${cls}`; el.textContent = label;
          el.addEventListener("click", () => act(`posts/${encodeURIComponent(p.id)}/${path}`, el)); return el;
        };
        // No approve while nothing may post (halted, penalty day one, reconnect, switched off); skip always.
        if (U.approveBlocked(settings && settings.halt_state, c)) {
          const note = document.createElement("span"); note.className = "camp-muted camp-small"; note.textContent = "האישור יתאפשר כשהפרסום יחזור.";
          bar.append(b("דילוג", "btn-ghost", "skip"), note);
        } else bar.append(b("אישור ופרסום", "btn-gold", "approve"), b("דילוג", "btn-ghost", "skip"));
        li.appendChild(bar);
      }
      return li;
    }
    function fill(ol, posts, c) {
      ol.textContent = "";
      const pending = posts.filter((p) => p.status === "pending_approval");
      pending.concat(posts.filter((p) => p.status !== "pending_approval").reverse()).forEach((p) => ol.appendChild(row(p, c)));
    }

    function renderHalt() {
      const h = U.haltInfo(settings && settings.halt_state, live(campaign) ? campaign : null);
      $("campHalt").hidden = !h;
      if (!h) return;
      $("campHalt").className = `camp-halt camp-halt-${h.cls}`;
      $("campHaltMsg").textContent = h.text;
      $("campHaltBrowserBtn").hidden = !(h.reconnect || h.verify);
      $("campHaltBrowserBtn").textContent = h.verify ? "השלמת האימות" : "חיבור החשבון מחדש";
      $("campResumeBtn").hidden = !(h.resume || h.reconsent);
      $("campResumeBtn").textContent = h.reconsent ? "אישור מחדש והמשך" : "להמשיך";
      $("campResumeBtn").dataset.reconsent = h.reconsent ? "1" : "";
    }

    function show(c) {
      campaign = c || null;
      const on = live(campaign), connected = !!(settings && settings.connected);
      $("campNeedConnect").hidden = connected || on;
      $("campSetup").hidden = on || !connected;
      $("campLive").hidden = !on;
      $("campStatusChip").textContent = U.chipText(campaign);
      $("campStatusChip").hidden = !campaign;
      renderHalt();
      const { current, earlier } = U.splitPasses(campaign);
      const past = on ? earlier : current.concat(earlier);
      $("campLast").hidden = !past.length;
      $("campLastSummary").textContent = on ? "סבבים קודמים" : "הקמפיין האחרון";
      if (past.length) fill($("campLastTimeline"), past, campaign);
      if (!on) { stopPolling(); renderSetup(); return; }
      const pending = current.filter((p) => p.status === "pending_approval");
      const next = pending[0] || current.filter((p) => p.status === "scheduled")
        .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))[0];
      const off = /^posting_disabled:/.test(campaign.wait_reason || "");
      $("campNext").textContent = campaign.status === "paused" || off ? "הפרסום מושהה כרגע — ההסבר למעלה."
        : pending.length ? `ממתין לאישור שלכם: ${pending[0].group_name}`
          : next ? `הפוסט הבא מתוכנן ל${U.fmt(next.scheduled_at)} · ${next.group_name}` : U.waitText(campaign.wait_reason);
      $("campPauseLink").hidden = campaign.status !== "running";
      const posted = current.filter((p) => p.status === "posted").length;
      const planned = current.filter((p) => ["scheduled", "pending_approval"].includes(p.status)).length;
      $("campSummary").textContent = `${posted} פורסמו · ${planned} מתוכננים · ${campaign.mode === "per_post" ? "כל פוסט באישור שלכם" : "פורלי מפרסמת לבד עד שתעצרו"}`;
      const perm = (settings && settings.permission) || {};
      $("campAutoLine").hidden = !(perm.enabled && (perm.default_group_ids || []).length);
      fill($("campTimeline"), current, campaign);
      startPolling();
    }

    async function refresh() {
      try {
        const [s, j] = await Promise.all([api(`/api/posting/settings?page_id=${encodeURIComponent(pageId)}`),
          campaign ? api(`/api/posting/campaigns/${encodeURIComponent(campaign.id)}`) : null]);
        settings = s; show(j ? j.campaign : campaign);
      } catch (e) { /* the next poll tries again; STOP never waits on this */ }
    }
    function startPolling() { if (!timer) timer = setInterval(refresh, 30000); }
    function stopPolling() { clearInterval(timer); timer = null; }

    async function act(path, btn) {
      if (!campaign) return;
      if (btn) btn.disabled = true;
      try { show((await post(`/api/posting/campaigns/${encodeURIComponent(campaign.id)}/${path}`)).campaign); return true; }
      catch (e) { say(U.errorText(e)); if (e && e.code === "needs_reconnect") refresh(); return false; }
      finally { if (btn) btn.disabled = false; }
    }

    // Records the account-level choices (auto-enroll, likes & stories, Page)
    // under the consent just given; auto-enroll off keeps the permission but
    // with no default groups and groups-only targets, so no new listing enrolls.
    function settingsBody(ids, auto, targets) {
      const sel = pageOn() && $("campPageSelect"), b = {
        enabled: true, consent: true, consent_version: settings.consent_version, auto_mode: mode(),
        default_group_ids: auto ? ids : [], targets: auto ? targets : ["groups"], allows_visible_interactions: $("campVisible").checked,
      };
      if (sel && sel.value) b.page_id = sel.value;
      else if (pageOn() && pages().length === 1) b.page_id = pages()[0].id; // ticking the one named Page is the choice
      return b;
    }

    async function start(btn) {
      const ids = members().filter((g) => U.usable(g) && picked.has(String(g.group_id))).map((g) => String(g.group_id));
      if (!ids.length) return say("בחרו לפחות קבוצה אחת");
      if (pageOn() && !withPage()) return say("בחרו באיזה דף עסקי לפרסם, או בטלו את \"גם בדף העסקי\"");
      if (!consentGiven && !$("campConsent").checked) return say("סמנו את האישור שמעל הכפתור");
      const targets = withPage() ? ["page", "groups"] : ["groups"];
      const unknown = members().some((g) => ids.includes(String(g.group_id)) && g.agent_policy === "unknown");
      btn.disabled = true; btn.textContent = "מתחילים…"; $("campSetupNote").hidden = true;
      try {
        await put("/api/posting/settings", settingsBody(ids, $("campAutoEnroll").checked, targets));
        const j = await post("/api/posting/campaigns", {
          page_id: pageId, group_ids: ids, mode: mode(), days: 14, repeat: false, targets, consent: true,
          consent_version: settings.consent_version, include_unknown: unknown,
          account_aged: $("campAged").checked, posted_manually: $("campManual").checked,
        });
        consentGiven = true;
        settings = await api(`/api/posting/settings?page_id=${encodeURIComponent(pageId)}`).catch(() => settings);
        show(j.campaign); say("התחלנו ✓ אפשר לעצור בכל רגע");
      } catch (e) {
        const bad = (e && e.body && e.body.group_ids) || [];
        bad.forEach((id) => picked.delete(String(id)));
        if (e && e.code === "consent_outdated") { await loadSettings().catch(() => null); consentGiven = false; $("campConsent").checked = false; }
        if (e && e.code === "posting_disabled") { $("campSetupNote").textContent = U.errorText(e); $("campSetupNote").hidden = false; }
        renderSetup(); say(U.errorText(e));
      } finally { btn.disabled = false; btn.textContent = "התחלת פרסום"; }
    }

    // ── wiring ──
    document.querySelectorAll('input[name="campMode"]').forEach((r) => r.addEventListener("change", renderSetup));
    $("campMemberGroups").addEventListener("change", (ev) => {
      const i = ev.target; if (!i || !i.dataset || !i.dataset.id) return;
      if (i.checked) picked.add(i.dataset.id); else picked.delete(i.dataset.id);
      renderSetup();
    });
    $("campMemberGroups").addEventListener("click", async (ev) => {
      const b = ev.target && ev.target.closest && ev.target.closest("button[data-rm]"); if (!b) return;
      if (!confirm("להסיר את הקבוצה מהרשימה? פורלי לא תפרסם בה, גם לא בנכסים הבאים. אפשר להחזיר אותה אחר כך.")) return;
      b.disabled = true;
      try {
        const j = await api(`/api/posting/groups/${encodeURIComponent(b.dataset.rm)}`, { method: "DELETE" });
        settings.member_groups = j.member_groups || []; settings.hidden_group_ids = j.hidden_group_ids || [];
        picked.delete(b.dataset.rm); renderSetup(); say("הקבוצה הוסרה מהרשימה");
      } catch (e) { b.disabled = false; say(U.errorText(e)); }
    });
    $("campUnhide").addEventListener("click", async function () {
      this.disabled = true;
      try {
        for (const id of settings.hidden_group_ids || []) settings.hidden_group_ids = (await post(`/api/posting/groups/${encodeURIComponent(id)}/unhide`)).hidden_group_ids || [];
        say("הקבוצות יחזרו לרשימה ברענון הבא");
      } catch (e) { say(U.errorText(e)); }
      finally { this.disabled = false; renderSetup(); }
    });
    $("campResync").addEventListener("click", async function () {
      this.disabled = true; this.textContent = "מרעננים…";
      try {
        const j = await post("/api/posting/groups/resync");
        settings.member_groups = j.member_groups || []; picked = new Set(U.defaultPicks(settings.member_groups));
        renderSetup(); say("רשימת הקבוצות עודכנה");
      } catch (e) { say(U.errorText(e)); }
      finally { this.disabled = false; this.textContent = "רענון"; }
    });
    $("campStartBtn").addEventListener("click", function () { start(this); });
    // STOP: no switch, halt or pending request keeps it from working (routes/posting.js).
    $("campStopBtn").addEventListener("click", async function () {
      if (!confirm("לעצור את הפרסום? מה שכבר עלה נשאר בקבוצות. אפשר להתחיל שוב מתי שתרצו.")) return;
      if (await act("stop", this)) say("הפרסום נעצר. מה שכבר פורסם נשאר.");
    });
    $("campPauseLink").addEventListener("click", (ev) => { ev.preventDefault(); act("pause"); });
    $("campResumeBtn").addEventListener("click", async function () {
      if (this.dataset.reconsent) {
        if (!confirm($("campConsentText").textContent.trim())) return;
        try { await put("/api/posting/settings", { enabled: true, consent: true, consent_version: settings.consent_version, default_group_ids: [], targets: ["groups"] }); }
        catch (e) { return say(U.errorText(e)); }
      }
      if (await act("resume", this)) say("ממשיכים ✓");
    });
    $("campAutoOff").addEventListener("click", async (ev) => {
      ev.preventDefault();
      try {
        await put("/api/posting/settings", { enabled: true, consent: true, consent_version: settings.consent_version, default_group_ids: [], targets: ["groups"] });
        settings.permission.default_group_ids = []; $("campAutoEnroll").checked = false; show(campaign); say("נכסים חדשים לא יתפרסמו אוטומטית");
      } catch (e) { say(U.errorText(e)); }
    });

    (async () => {
      try { await loadSettings(); }
      catch (e) { return; } // not signed in (a shared link) or the API is down: the card stays hidden
      $("campFirstWeek").textContent = U.FIRST_WEEK;
      $("campReach").textContent = U.REACH_NOTE;
      let c = null;
      try {
        const list = (await api(`/api/posting/campaigns?page_id=${encodeURIComponent(pageId)}`)).campaigns || [];
        c = list.find(live) || list.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))[0] || null;
        if (c) c = (await api(`/api/posting/campaigns/${encodeURIComponent(c.id)}`)).campaign || c;
      } catch (e) { /* no campaign shown; setup still works */ }
      show(c);
      $("campaignCard").hidden = false;
    })();
  }
})(typeof window !== "undefined" ? window : globalThis);
