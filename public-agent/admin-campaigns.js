/*
 * admin-campaigns.js — the admin's "קמפיינים" tab: every campaign, and
 * create / edit / stop / start for an agent (routes/admin-campaigns.js).
 * Every change needs a fresh step-up; a 401 stepup_required shows the
 * banner. A new campaign carries the consent the admin recorded.
 */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var esc = FLY.esc;
  var API = "/api/admin/campaigns";
  var rows = [], agents = [], editing = null; // editing: the row being edited, or null for a new campaign
  var manual = false; // POSTING_MANUAL=1 on the server: an admin publishes by hand; the approval mode has no meaning there
  var STATUS = { running: "פעיל", paused: "מושהה", stopped: "נעצר", completed: "הסתיים" };
  var ERR = {
    consent_note_required: "חובה לבחור איך הסוכן הסכים ולכתוב הערה.",
    stale_version: "הקמפיין השתנה בינתיים — טוענים מחדש.",
    busy: "פוסט לקבוצה הזו כבר בדרך. נסו שוב בעוד כמה דקות.",
    not_live: "הקמפיין כבר לא פעיל.",
    account_halted: "החשבון של הסוכן מושבת. קודם צריך להפעיל אותו מחדש בלשונית הפרסום האוטומטי.",
    facebook_not_connected: "הסוכן עוד לא חיבר את פייסבוק.",
    page_not_confirmed: "הסוכן עוד לא אישר את הדף העסקי.",
    page_target_unavailable: "הדף העסקי של הסוכן עוד לא זוהה.",
    not_member: "הסוכן לא חבר בחלק מהקבוצות.",
    unknown_group: "יש קבוצות שלא בקטלוג.",
    group_disallowed: "יש קבוצות שאסור לפרסם בהן.",
    listing_type_not_allowed: "יש קבוצות שלא מתאימות לסוג הנכס.",
    not_found: "לא נמצא.",
    invalid_input: "הנתונים לא תקינים.",
    no_destination: "צריך לפחות קבוצה אחת (או הדף העסקי).",
    audit_unavailable: "לא ניתן לרשום את הפעולה ביומן — לא בוצע שינוי. נסו שוב.",
  };
  var fmt = function (v) { var d = new Date(v); return isNaN(d) ? "—" : d.toLocaleDateString("he-IL"); };

  function req(method, path, body) {
    return FLY.req(API + path, { method: method, body: body, noRedirect: true }).then(function (d) { $("#campStepUp").classList.add("hidden"); return d; });
  }
  function fail(e) {
    if (e && e.status === 401 && e.code === "stepup_required") { $("#campStepUp").classList.remove("hidden"); FLY.toast("נדרש אימות מחדש — התחברו שוב"); return; }
    FLY.toast((e && ERR[e.code]) || "הפעולה נכשלה");
    if (e && e.code === "stale_version") load();
  }

  // Uploaded posts per day ({ "2026-10-14": 5 }), newest day first: "14.10: 5 · 13.10: 3".
  function byDay(days) {
    return Object.keys(days || {}).sort().reverse().map(function (d) {
      var p = d.split("-");
      return '<span class="cf-day"><b>' + esc(Number(p[2]) + "." + Number(p[1])) + "</b> " + esc(days[d]) + "</span>";
    }).join("");
  }
  function render() {
    var total = {};
    rows.forEach(function (r) { Object.keys(r.posted_by_day || {}).forEach(function (d) { total[d] = (total[d] || 0) + r.posted_by_day[d]; }); });
    var head = Object.keys(total).length ? '<div class="cf-days-sum"><span class="manual-muted">פוסטים שעלו לפי יום (כל הקמפיינים ברשימה):</span> ' + byDay(total) + "</div>" : "";
    $("#campList").innerHTML = !rows.length ? '<p class="cf-empty">אין קמפיינים להצגה. לחצו "קמפיין חדש" כדי להתחיל.</p>' : head + rows.map(function (r) {
      var live = r.status === "running" || r.status === "paused";
      return '<div class="cf-card" data-camp="' + esc(r.id) + '"><div class="cf-main-info">' +
        "<h3>" + esc(r.agent_name || r.phone_tail) + " · " + esc(r.page_title) + ' <span class="cf-st ' + esc(r.status) + '">' + esc(STATUS[r.status] || r.status) + "</span></h3>" +
        '<div class="manual-muted">' + r.groups.length + " קבוצות · פורסם " + r.counts.posted + " · עד " + fmt(r.expires_at) +
        (r.repeat ? " · חזרה כל " + esc(r.repeat_days) + " ימים" : "") + " · נוצר על ידי " + (r.created_by === "admin" ? "הצוות" : "הסוכן") + "</div>" +
        (Object.keys(r.posted_by_day || {}).length ? '<div class="cf-days-row"><span class="manual-muted">עלו לפי יום:</span> ' + byDay(r.posted_by_day) + "</div>" : "") + "</div>" +
        '<div class="row-actions">' +
        (live ? '<button type="button" class="btn btn-ghost btn-sm" data-act="edit">עריכה</button>' : "") +
        (live ? '<button type="button" class="btn btn-ghost btn-sm" data-act="all" title="אותן קבוצות כברירת מחדל ולכל שאר הנכסים של הסוכן">לכל הנכסים</button>' : "") +
        (live ? '<button type="button" class="btn btn-ghost btn-sm" data-act="stop">עצירה</button>' : "") +
        (r.status !== "running" ? '<button type="button" class="btn btn-gold btn-sm" data-act="start">הפעלה</button>' : "") +
        "</div></div>";
    }).join("");
  }
  function load() {
    var q = [];
    if ($("#campStatus").value) q.push("status=" + encodeURIComponent($("#campStatus").value));
    if ($("#campAgent").value) q.push("agent=" + encodeURIComponent($("#campAgent").value));
    return req("GET", "/campaigns" + (q.length ? "?" + q.join("&") : "")).then(function (d) { rows = d.campaigns || []; manual = d.manual === true; render(); }).catch(fail);
  }
  function loadAgents() {
    return req("GET", "/agents").then(function (d) {
      agents = d.agents || [];
      var opts = agents.map(function (a) { return '<option value="' + esc(a.ref) + '">' + esc(a.name || a.phone_tail) + " (" + esc(a.phone_tail) + ")</option>"; }).join("");
      $("#campAgent").innerHTML = '<option value="">כל הסוכנים</option>' + opts;
      $("#campFormAgent").innerHTML = '<option value="">בחרו סוכן…</option>' + opts;
    }).catch(fail);
  }
  var seq = 0;           // bumps whenever the form is (re)opened or its agent changes; stale async fills compare against it
  var restarting = null; // the stopped/completed row being restarted, or null
  var applying = null;   // the row whose groups go to all the agent's properties, or null
  var initial = null;    // prefilled values of the row being edited
  function emptyGroups(text) { $("#campFormDefaultsHint").textContent = ""; $("#campFormUseDefaults").hidden = true; emptyGroupsBox(text); }
  function emptyGroupsBox(text) { $("#campFormGroups").innerHTML = '<p class="cf-empty">' + esc(text) + "</p>"; $("#campFormGroupBar").hidden = true; }
  function loadAgentChoices(ref, checked) {
    var my = ++seq;
    $("#campFormEstimate").textContent = "";
    $("#campFormSync").hidden = !ref; $("#campFormSynced").textContent = "";
    if (!ref) { $("#campFormGroupsHidden").textContent = ""; $("#campFormProperty").innerHTML = '<option value="">קודם בחרו סוכן</option>'; emptyGroups("בחרו סוכן כדי לראות את הקבוצות שהוא חבר בהן."); return Promise.resolve(false); }
    $("#campFormProperty").innerHTML = '<option value="">טוען…</option>'; emptyGroups("טוען קבוצות…"); $("#campFormGroupsHidden").textContent = "";
    return Promise.all([req("GET", "/agents/" + encodeURIComponent(ref) + "/properties"), req("GET", "/agents/" + encodeURIComponent(ref) + "/groups")]).then(function (r) {
      if (my !== seq) return false;
      var props = r[0].properties || [];
      // one property is chosen for you; with several, the admin picks on purpose
      $("#campFormProperty").innerHTML = (!props.length ? '<option value="">לסוכן אין נכסים פעילים</option>' : props.length > 1 ? '<option value="">בחרו נכס…</option>' : "") +
        props.map(function (p) { return '<option value="' + esc(p.page_id) + '">' + esc(p.title) + "</option>"; }).join("");
      showGroups(r[1], checked);
      checkFit();
      groupsChanged();
      return true;
    }).catch(function (e) { if (my === seq) { emptyGroups("טעינת הקבוצות נכשלה."); fail(e); } return false; });
  }
  var groupInfo = {}; // group_id → the row the server sent (in_catalog)
  // A group outside the catalog needs include_unknown (the server's gate), as in the agent's own flow.
  function outsideCatalog(ids) { return ids.some(function (id) { return groupInfo[id] && !groupInfo[id].in_catalog; }); }
  var defaults = []; // the agent's default group ids (GET /agents/:ref/groups)
  function showGroups(d, checked) {
    var groups = d.groups || [];
    defaults = (d.default_group_ids || []).map(String);
    // A new campaign starts from the agent's default groups (an edit keeps its own).
    var fromDefaults = !checked && defaults.length > 0;
    if (fromDefaults) checked = defaults;
    $("#campFormSynced").textContent = d.synced_at ? "הקבוצות נקראו מפייסבוק ב-" + new Date(d.synced_at).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" }) : "הקבוצות עוד לא נקראו מפייסבוק.";
    // The agent's own rule: real-estate groups only (in the catalog, or a
    // real-estate name) — plus any the campaign being edited already has.
    var shown = groups.filter(function (g) { return g.in_catalog || g.real_estate || defaults.indexOf(g.group_id) >= 0 || (checked && checked.indexOf(g.group_id) >= 0); });
    var hidden = groups.length - shown.length;
    groupInfo = {}; shown.forEach(function (g) { groupInfo[g.group_id] = g; });
    $("#campFormGroupsHidden").textContent = hidden ? "עוד " + hidden + " קבוצות של הסוכן לא מוצגות — לפי השם הן לא קבוצות נדל״ן." : "";
    var isDef = function (g) { return defaults.indexOf(g.group_id) >= 0 ? 1 : 0; };
    shown.sort(function (a, b) { return isDef(b) - isDef(a) || (b.in_catalog ? 1 : 0) - (a.in_catalog ? 1 : 0) || (b.name ? 1 : 0) - (a.name ? 1 : 0) || String(a.name).localeCompare(String(b.name), "he"); });
    if (!shown.length) { emptyGroups("הסוכן לא חבר באף קבוצה מהקטלוג — אפשר לפרסם רק בדף העסקי."); return; }
    $("#campFormGroups").innerHTML = shown.map(function (g) {
      var on = checked && checked.indexOf(g.group_id) >= 0;
      return '<label class="camp-g' + (on ? " on" : "") + '"><input type="checkbox" value="' + esc(g.group_id) + '"' + (on ? " checked" : "") + '> <span class="camp-gn">' + esc(g.name || "קבוצה ללא שם · " + g.group_id) + "</span>" + (isDef(g) ? '<span class="cf-tag cf-def">ברירת מחדל</span>' : "") + (g.in_catalog ? "" : '<span class="cf-tag">לא בקטלוג</span>') + "</label>";
    }).join("");
    $("#campFormGroupBar").hidden = false;
    $("#campFormUseDefaults").hidden = !defaults.length;
    $("#campFormUseDefaults").textContent = "קבוצות ברירת המחדל (" + defaults.length + ")";
    $("#campFormDefaultsHint").textContent = fromDefaults ? "סומנו " + defaults.length + " קבוצות ברירת המחדל של הסוכן — אפשר לשנות." : "";
    $("#campFormGroupSearch").value = "";
    $("#campFormGroupSearch").hidden = shown.length < 8;
  }
  // Re-reads the agent's groups from Facebook (routes/admin-campaigns.js, the
  // same guarded sync as the agent's own resync), keeping what is ticked.
  var REFRESH_ERR = {
    posting_disabled: "אי אפשר לרענן כרגע — הפרסום האוטומטי כבוי בשרת הזה.",
    profile_busy: "הדפדפן של הסוכן פתוח כרגע (פרסום ידני או התחברות). סגרו אותו ונסו שוב.",
    facebook_not_connected: "הסוכן עוד לא חיבר את פייסבוק.",
    too_soon: "רענון רץ לפני רגע — נסו שוב בעוד דקה.",
    sync_failed: "הקריאה מפייסבוק נכשלה. נסו שוב מאוחר יותר.",
  };
  function refreshGroups() {
    var ref = $("#campFormAgent").value, btn = $("#campFormRefresh"), my = seq;
    if (!ref || btn.disabled) return;
    btn.disabled = true; btn.textContent = "קורא מפייסבוק… (יכול לקחת כמה דקות)";
    var keep = chosenGroups();
    return req("POST", "/agents/" + encodeURIComponent(ref) + "/groups/refresh", {}).then(function (d) {
      if (my !== seq) return;
      showGroups(d, keep); groupsChanged(); checkFit(); FLY.toast("הקבוצות עודכנו");
    }).catch(function (e) {
      if (e && e.status === 401) return fail(e);
      FLY.toast((e && REFRESH_ERR[e.code]) || "הרענון נכשל");
    }).then(function () { btn.disabled = false; btn.textContent = "רענון הקבוצות מפייסבוק"; });
  }
  function groupsChanged() {
    var all = document.querySelectorAll("#campFormGroups input");
    Array.prototype.forEach.call(all, function (i) { i.closest(".camp-g").classList.toggle("on", i.checked); });
    $("#campFormGroupCount").textContent = "נבחרו " + chosenGroups().length + " מתוך " + all.length;
    clearError();
    showEstimate();
  }
  function filterGroups() {
    var q = $("#campFormGroupSearch").value.trim().toLowerCase();
    Array.prototype.forEach.call(document.querySelectorAll("#campFormGroups .camp-g"), function (l) { l.hidden = !!q && l.textContent.toLowerCase().indexOf(q) < 0; });
  }
  // Groups the chosen property can't take, marked with why (GET /agents/:ref/groups/fit);
  // a blocked one is unticked and locked, a warning is only shown.
  var DEAL = { sale: "מכירה", rent: "השכרה" };
  function fitReason(r, lt) {
    if (r.block === "listing_type") return "הקבוצה רק ל" + (r.listing_types || []).map(function (t) { return DEAL[t] || t; }).join("/") + " — והנכס ל" + (DEAL[lt] || lt || "סוג אחר");
    if (r.block === "no_agents_name") return "שם הקבוצה אומר שאין כניסה למתווכים";
    if (r.block === "no_agents_policy") return "בקטלוג: הקבוצה לא מאפשרת פרסום של מתווכים";
    if (r.warn === "deal_name") return "לפי השם הקבוצה ל" + (lt === "sale" ? "השכרה" : "מכירה") + " — כדאי לבדוק";
    return "";
  }
  var REJECTED = { listing_type_not_allowed: "לא מתאימה לסוג הנכס", group_disallowed: "אסור לפרסם בה", not_member: "הסוכן כבר לא חבר בה", unknown_group: "לא מוכרת" };
  function markGroup(id, cls, why, block) {
    var input = document.querySelector('#campFormGroups input[value="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (!input) return false;
    var card = input.closest(".camp-g");
    card.classList.add(cls);
    var w = document.createElement("small"); w.className = "cf-why"; w.textContent = why; card.appendChild(w);
    if (block) { input.checked = false; input.disabled = true; }
    return true;
  }
  function clearFit() {
    Array.prototype.forEach.call(document.querySelectorAll("#campFormGroups .camp-g"), function (c) {
      c.classList.remove("cf-bad-g", "cf-warn-g");
      Array.prototype.forEach.call(c.querySelectorAll(".cf-why"), function (w) { w.remove(); });
      c.querySelector("input").disabled = false;
    });
    $("#campFormFit").textContent = "";
  }
  function checkFit() {
    var ref = $("#campFormAgent").value, pageId = $("#campFormProperty").value, my = seq;
    clearFit();
    if (!ref || !pageId || restarting || applying) return Promise.resolve();
    return req("GET", "/agents/" + encodeURIComponent(ref) + "/groups/fit?page_id=" + encodeURIComponent(pageId)).then(function (d) {
      if (my !== seq || $("#campFormProperty").value !== pageId) return;
      var blocked = 0, warned = 0;
      Object.keys(d.fit || {}).forEach(function (id) {
        var r = d.fit[id];
        if (markGroup(id, r.block ? "cf-bad-g" : "cf-warn-g", fitReason(r, d.listing_type), !!r.block)) { if (r.block) blocked++; else warned++; }
      });
      $("#campFormFit").textContent = (blocked ? blocked + " קבוצות לא מתאימות לנכס הזה (באדום) ולא ייבחרו. " : "") + (warned ? warned + " קבוצות כדאי לבדוק (בכתום)." : "");
      groupsChanged();
    }).catch(function () { /* the save still checks */ });
  }
  // A refused save: mark the groups the server named.
  function markRejected(e) {
    var ids = (e && e.data && e.data.group_ids) || [];
    var n = ids.filter(function (id) { return markGroup(String(id), "cf-bad-g", REJECTED[e.code] || "נדחתה", true); }).length;
    if (n) { groupsChanged(); showError("סומנו באדום " + n + " קבוצות שנדחו — הן הוסרו מהבחירה, אפשר לשמור שוב.", null); }
  }
  function useDefaults() {
    Array.prototype.forEach.call(document.querySelectorAll("#campFormGroups input:not(:disabled)"), function (i) { i.checked = defaults.indexOf(i.value) >= 0; });
    groupsChanged();
  }
  function setAllGroups(on) { // only the groups the search shows
    Array.prototype.forEach.call(document.querySelectorAll("#campFormGroups .camp-g:not([hidden]) input:not(:disabled)"), function (i) { i.checked = on; });
    groupsChanged();
  }
  function repeatVal() { // "0" or 3..30, as the server accepts
    if (!$("#campFormRepeatOn").checked) return "0";
    return String(Math.min(30, Math.max(3, Math.round(Number($("#campFormRepeat").value)) || 7)));
  }
  function syncTiming() {
    $("#campFormRepeatWrap").hidden = !$("#campFormRepeatOn").checked;
    var d = $("#campFormDays").value;
    Array.prototype.forEach.call(document.querySelectorAll(".cf-days [data-days]"), function (b) { b.classList.toggle("on", b.getAttribute("data-days") === d); });
  }
  function clearError() { $("#campFormError").textContent = ""; Array.prototype.forEach.call(document.querySelectorAll("#campForm .cf-bad"), function (e) { e.classList.remove("cf-bad"); }); }
  function showError(msg, el) {
    $("#campFormError").textContent = msg; FLY.toast(msg);
    if (el) { el.classList.add("cf-bad"); el.focus(); }
    return null;
  }
  function chosenGroups() { return Array.prototype.map.call(document.querySelectorAll("#campFormGroups input:checked"), function (i) { return i.value; }); }
  // How long the chosen groups take at the agent's limits today (an estimate); a stale answer is dropped.
  function showEstimate() {
    var el = $("#campFormEstimate"), my = seq, agent = $("#campFormAgent").value;
    el.classList.remove("warn");
    if (applying) return; // the box explains what the batch does
    if (!agent || !$("#campFormProperty").value || restarting) { el.textContent = ""; return; }
    var repeat = Number(repeatVal());
    req("POST", "/estimate", { agent: agent, page_id: $("#campFormProperty").value, group_ids: chosenGroups(), days: Number($("#campFormDays").value) || 30,
      repeat_days: repeat >= 3 ? repeat : undefined, targets: $("#campFormPage").checked ? ["groups", "page"] : ["groups"] }).then(function (e) {
      if (my !== seq) return;
      if (e.days === null || e.days === undefined) { el.textContent = "הערכה: אי אפשר להעריך כרגע — החשבון מושהה או מוגבל."; return; }
      el.classList.toggle("warn", !e.fits);
      el.textContent = "הערכה: " + e.posts + " פוסטים לסוכן, כ-" + e.per_week + " בשבוע לפי המגבלות היום ← כ-" + e.days + " ימים" +
        (e.fits ? "." : ". ⚠️ יותר מ-" + e.days_left + " ימים — חלק מהפוסטים לא יספיקו לצאת.") + (e.warmup ? " החשבון עדיין בחימום, הקצב יעלה בהמשך." : "");
    }).catch(function () { if (my === seq) el.textContent = ""; });
  }
  function setMain(show) { // the campaign fields vs. the restart form (consent and days)
    Array.prototype.forEach.call(document.querySelectorAll("#campForm .cf-main"), function (el) { el.hidden = !show; });
    if (manual) $("#campFormMode").closest(".cf-field").hidden = true; // by hand there is no approval step
  }
  function closeForm() { seq++; editing = null; restarting = null; applying = null; $("#campFormDefaultsRow").hidden = true; initial = null; $("#campForm").hidden = true; $("#campFormSave").disabled = false; $("#campFormEstimate").textContent = ""; clearError(); }
  function validNote() {
    var el = $("#campFormConsentNote"), n = el.value.trim();
    if (!n || n.length > 300) return showError("חובה לכתוב הערת הסכמה של 1 עד 300 תווים: איך ומתי הסוכן אישר.", el);
    return n;
  }
  function validNew() { // what the server would refuse anyway, said next to the field
    if (!$("#campFormAgent").value) return showError("בחרו סוכן.", $("#campFormAgent"));
    if (!$("#campFormProperty").value) return showError("בחרו נכס לפרסום.", $("#campFormProperty"));
    if (!chosenGroups().length && !$("#campFormPage").checked) return showError("בחרו לפחות קבוצה אחת, או סמנו פרסום בדף העסקי.", null);
    return validDays();
  }
  function validDays() {
    var el = $("#campFormDays"), d = Number(el.value);
    if (!(d >= 1 && d <= 30) || d !== Math.round(d)) return showError("משך הקמפיין: בין 1 ל-30 ימים.", el);
    return true;
  }
  function showForm() {
    $("#campForm").hidden = false;
    syncTiming();
    $("#campForm").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function openForm(row) {
    var my = ++seq;
    editing = row || null; restarting = null; applying = null; $("#campFormDefaultsRow").hidden = true;
    setMain(true);
    $("#campFormTitle").textContent = row ? "עריכת קמפיין" : "קמפיין חדש";
    $("#campFormAgent").disabled = !!row; $("#campFormProperty").disabled = !!row;
    $("#campFormConsent").hidden = !!row;
    $("#campFormAgent").value = ""; $("#campFormProperty").innerHTML = ""; emptyGroups("");
    $("#campFormConsentMethod").value = "phone"; $("#campFormConsentNote").value = "";
    $("#campFormSave").disabled = false; $("#campFormEstimate").textContent = ""; clearError();
    $("#campFormSave").textContent = row ? "שמירת שינויים" : "יצירת קמפיין";
    $("#campFormSetDefaultsRow").hidden = false; $("#campFormSetDefaults").checked = false;
    if (row) {
      var left = Math.min(30, Math.max(1, Math.ceil((Date.parse(row.expires_at) - Date.now()) / 86400000)) || 1);
      initial = { days: String(left), repeat: row.repeat ? String(row.repeat_days) : "0", mode: row.mode, page: row.targets.indexOf("page") >= 0 };
      $("#campFormDays").value = initial.days;
      $("#campFormRepeatOn").checked = initial.repeat !== "0"; $("#campFormRepeat").value = initial.repeat !== "0" ? initial.repeat : "7";
      $("#campFormMode").value = initial.mode; $("#campFormPage").checked = initial.page;
    } else {
      initial = null;
      $("#campFormDays").value = "14"; $("#campFormRepeatOn").checked = false; $("#campFormRepeat").value = "7"; $("#campFormMode").value = "standing"; $("#campFormPage").checked = false;
    }
    showForm();
    if (row) {
      $("#campFormAgent").value = row.ref;
      loadAgentChoices(row.ref, row.groups.map(function (g) { return g.group_id; })).then(function (ok) { if (ok && my + 1 === seq) { $("#campFormProperty").value = row.page_id; showEstimate(); checkFit(); } });
    } else {
      // start from the agent the list is filtered to
      $("#campFormAgent").value = $("#campAgent").value;
      loadAgentChoices($("#campFormAgent").value, null);
    }
  }
  function openRestart(row) {
    seq++;
    editing = null; restarting = row; applying = null; $("#campFormDefaultsRow").hidden = true;
    setMain(false);
    $("#campFormTitle").textContent = "הפעלה מחדש — הסכמת הסוכן";
    $("#campFormConsent").hidden = false;
    $("#campFormConsentMethod").value = "phone"; $("#campFormConsentNote").value = "";
    $("#campFormDays").value = String(row.run_days || 30); // as long as the run it repeats
    $("#campFormSave").disabled = false; $("#campFormEstimate").textContent = ""; clearError();
    $("#campFormSave").textContent = "הפעלה מחדש";
    showForm();
  }
  // The agent's ask: this campaign's groups as her defaults, and a campaign
  // with them for every other property (routes/admin-campaigns.js apply-to-all).
  function openApply(row) {
    seq++;
    editing = null; restarting = null; applying = row;
    setMain(false);
    $("#campFormTitle").textContent = "הקבוצות של הקמפיין לכל הנכסים של " + (row.agent_name || row.phone_tail);
    $("#campFormDefaultsRow").hidden = false; $("#campFormDefaults").checked = true;
    $("#campFormConsent").hidden = false;
    $("#campFormConsentMethod").value = "phone"; $("#campFormConsentNote").value = "";
    $("#campFormDays").value = String(row.run_days || 14);
    $("#campFormSave").disabled = false; $("#campFormEstimate").textContent = ""; clearError();
    // The groups themselves, so the consent asked for names what it covers.
    $("#campFormEstimate").innerHTML = esc(row.groups.length + " קבוצות. לכל נכס אחר של הסוכן בלי קמפיין פעיל ייפתח קמפיין עם אותן קבוצות ואותן הגדרות; קבוצה שלא מתאימה לנכס (סוג עסקה, מדיניות) תדלג.") +
      '<ul class="cf-applylist">' + row.groups.map(function (g) { return "<li>" + esc(g.name || g.group_id) + "</li>"; }).join("") + "</ul>";
    $("#campFormSave").textContent = "פתיחת קמפיינים לכל הנכסים";
    showForm();
  }
  var SKIP = { has_campaign: "כבר יש קמפיין", facebook_not_connected: "פייסבוק לא מחובר", page_not_confirmed: "הדף העסקי לא אושר", page_target_unavailable: "הדף העסקי לא זוהה", no_destination: "אין קבוצה שמתאימה", listing_type_not_allowed: "סוג העסקה לא מתאים", group_disallowed: "אסור לפרסם בקבוצות", unknown_group: "קבוצות לא מוכרות", not_member: "הסוכן לא חבר" };
  function settle(p) { // one request in flight per save click
    $("#campFormSave").disabled = true;
    return p.then(function () { $("#campFormSave").disabled = false; }, function () { $("#campFormSave").disabled = false; });
  }
  function save() {
    if ($("#campFormSave").disabled) return;
    clearError();
    if (applying) {
      if (!validDays()) return;
      var an = validNote(); if (!an) return;
      return settle(req("POST", "/campaigns/" + encodeURIComponent(applying.id) + "/apply-to-all", {
        consent: { method: $("#campFormConsentMethod").value, note: an }, days: Number($("#campFormDays").value), set_defaults: $("#campFormDefaults").checked,
      }).then(function (d) {
        closeForm(); load();
        var why = {};
        (d.skipped || []).forEach(function (k) { var w = SKIP[k.reason] || k.reason; why[w] = (why[w] || 0) + 1; });
        var skip = Object.keys(why).map(function (w) { return why[w] + " " + w; }).join(", ");
        FLY.toast((d.defaults_set ? "הקבוצות נשמרו כברירת מחדל. " : "") + "נפתחו " + d.created.length + " קמפיינים" + (skip ? " · דולגו: " + skip : "") + ".");
      }).catch(failClose));
    }
    if (restarting) {
      if (!validDays()) return;
      var rn = validNote(); if (!rn) return;
      var rid = restarting.id;
      return settle(req("POST", "/campaigns/" + encodeURIComponent(rid) + "/start", { consent: { method: $("#campFormConsentMethod").value, note: rn }, days: Number($("#campFormDays").value) || 30 })
        .then(function () { closeForm(); FLY.toast("הקמפיין פעיל"); load(); }).catch(failClose));
    }
    var targets = $("#campFormPage").checked ? ["groups", "page"] : ["groups"];
    var repeat = Number(repeatVal());
    if (!editing) {
      if (!validNew()) return;
      var note = validNote(); if (!note) return;
      return settle(req("POST", "/campaigns", {
        agent: $("#campFormAgent").value, page_id: $("#campFormProperty").value, group_ids: chosenGroups(),
        days: Number($("#campFormDays").value) || 14, repeat_days: repeat || undefined, mode: $("#campFormMode").value, targets: targets,
        include_unknown: outsideCatalog(chosenGroups()) || undefined, set_defaults: $("#campFormSetDefaults").checked || undefined,
        consent: { method: $("#campFormConsentMethod").value, note: note },
      }).then(function (d) { closeForm(); FLY.toast(d.existing ? "לנכס הזה כבר יש קמפיין — פתחו אותו לעריכה" : "הקמפיין נפתח" + (d.default_group_ids ? " · הקבוצות נשמרו כברירת מחדל" : "")); load(); }).catch(failSave));
    }
    var before = editing.groups.map(function (g) { return g.group_id; }), now = chosenGroups();
    var add = now.filter(function (g) { return before.indexOf(g) < 0; }), rem = before.filter(function (g) { return now.indexOf(g) < 0; });
    if (!now.length && !$("#campFormPage").checked) return showError("בחרו לפחות קבוצה אחת, או סמנו פרסום בדף העסקי.", null);
    if (!validDays()) return;
    var body = { version: editing.version };
    if ($("#campFormDays").value !== initial.days) body.days = Number($("#campFormDays").value) || 14;
    if (repeatVal() !== initial.repeat) body.repeat_days = repeat;
    if ($("#campFormMode").value !== initial.mode) body.mode = $("#campFormMode").value;
    if ($("#campFormPage").checked !== initial.page) body.targets = targets;
    if (add.length) { body.add_group_ids = add; if (outsideCatalog(add)) body.include_unknown = true; }
    if (rem.length) body.remove_group_ids = rem;
    if ($("#campFormSetDefaults").checked) body.set_defaults = true;
    if (Object.keys(body).length === 1) { closeForm(); FLY.toast("לא היו שינויים"); return; }
    return settle(req("PATCH", "/campaigns/" + encodeURIComponent(editing.id), body)
      .then(function (d) { closeForm(); FLY.toast("נשמר" + (d && d.default_group_ids ? " · הקבוצות נשמרו כברירת מחדל" : "")); load(); }).catch(failSave));
  }
  function failSave(e) { markRejected(e); failClose(e); }
  function failClose(e) { // a stale version closes the form: the reload brings the fresh row to edit
    if (e && e.code === "stale_version") closeForm();
    fail(e);
  }
  function act(id, what) {
    var row = rows.filter(function (r) { return r.id === id; })[0];
    if (!row) return;
    if (what === "edit") return openForm(row);
    if (what === "all") return openApply(row);
    if (what === "stop") {
      if (!window.confirm("לעצור את הקמפיין? הסוכן יקבל הודעה.")) return;
      return req("POST", "/campaigns/" + encodeURIComponent(id) + "/stop", {}).then(function () { FLY.toast("הקמפיין נעצר"); load(); }).catch(fail);
    }
    if (what === "start") {
      if (row.status === "stopped" || row.status === "completed") return openRestart(row);
      return req("POST", "/campaigns/" + encodeURIComponent(id) + "/start", {}).then(function () { FLY.toast("הקמפיין פעיל"); load(); }).catch(fail);
    }
  }

  $("#campStatus").addEventListener("change", load);
  $("#campAgent").addEventListener("change", load);
  $("#campNew").addEventListener("click", function () { openForm(null); });
  $("#campFormAgent").addEventListener("change", function () { loadAgentChoices($("#campFormAgent").value, null); });
  $("#campFormGroups").addEventListener("change", groupsChanged);
  $("#campFormGroupSearch").addEventListener("input", filterGroups);
  $("#campFormRefresh").addEventListener("click", refreshGroups);
  $("#campFormAll").addEventListener("click", function () { setAllGroups(true); });
  $("#campFormUseDefaults").addEventListener("click", useDefaults);
  $("#campFormNone").addEventListener("click", function () { setAllGroups(false); });
  $("#campFormDays").addEventListener("input", syncTiming);
  $("#campFormRepeatOn").addEventListener("change", function () { syncTiming(); showEstimate(); });
  $("#campFormProperty").addEventListener("change", checkFit);
  ["#campFormDays", "#campFormProperty", "#campFormRepeat", "#campFormPage"].forEach(function (id) { $(id).addEventListener("change", function () { clearError(); showEstimate(); }); });
  $("#campFormConsentNote").addEventListener("input", clearError);
  document.querySelectorAll("#campForm [data-days]").forEach(function (b) {
    b.addEventListener("click", function () { $("#campFormDays").value = b.getAttribute("data-days"); syncTiming(); clearError(); showEstimate(); });
  });
  $("#campFormSave").addEventListener("click", save);
  $("#campFormCancel").addEventListener("click", closeForm);
  $("#campFormClose").addEventListener("click", closeForm);
  $("#campList").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-act]"); if (!b) return;
    if (b.disabled) return;
    b.disabled = true; // until the request settles: no double stop/start
    var done = function () { b.disabled = false; };
    Promise.resolve(act(b.closest("[data-camp]").getAttribute("data-camp"), b.getAttribute("data-act"))).then(done, done);
  });

  // ── tab wiring (like admin-posting.js) ──
  var tab = $("#tabCampaigns"), pane = $("#paneCampaigns");
  if (!tab || !pane) return;
  tab.addEventListener("click", function () {
    document.querySelectorAll(".tabs button").forEach(function (b) { b.classList.toggle("on", b === tab); });
    document.querySelectorAll("#viewAdmin [id^='pane']").forEach(function (p) { p.classList.toggle("hidden", p !== pane); });
    (agents.length ? Promise.resolve() : loadAgents()).then(load);
  });
  document.querySelectorAll(".tabs button").forEach(function (b) {
    if (b !== tab) b.addEventListener("click", function () { tab.classList.remove("on"); pane.classList.add("hidden"); });
  });
})();
