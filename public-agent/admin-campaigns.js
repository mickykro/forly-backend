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

  function render() {
    $("#campList").innerHTML = !rows.length ? '<p class="cf-empty">אין קמפיינים להצגה. לחצו "קמפיין חדש" כדי להתחיל.</p>' : rows.map(function (r) {
      var live = r.status === "running" || r.status === "paused";
      return '<div class="cf-card" data-camp="' + esc(r.id) + '"><div class="cf-main-info">' +
        "<h3>" + esc(r.agent_name || r.phone_tail) + " · " + esc(r.page_title) + ' <span class="cf-st ' + esc(r.status) + '">' + esc(STATUS[r.status] || r.status) + "</span></h3>" +
        '<div class="manual-muted">' + r.groups.length + " קבוצות · פורסם " + r.counts.posted + " · עד " + fmt(r.expires_at) +
        (r.repeat ? " · חזרה כל " + esc(r.repeat_days) + " ימים" : "") + " · נוצר על ידי " + (r.created_by === "admin" ? "הצוות" : "הסוכן") + "</div></div>" +
        '<div class="row-actions">' +
        (live ? '<button type="button" class="btn btn-ghost btn-sm" data-act="edit">עריכה</button>' : "") +
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
  var initial = null;    // prefilled values of the row being edited
  function emptyGroups(text) { $("#campFormGroups").innerHTML = '<p class="cf-empty">' + esc(text) + "</p>"; $("#campFormGroupBar").hidden = true; }
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
      groupsChanged();
      return true;
    }).catch(function (e) { if (my === seq) { emptyGroups("טעינת הקבוצות נכשלה."); fail(e); } return false; });
  }
  function showGroups(d, checked) {
    var groups = d.groups || [];
    $("#campFormSynced").textContent = d.synced_at ? "הקבוצות נקראו מפייסבוק ב-" + new Date(d.synced_at).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" }) : "הקבוצות עוד לא נקראו מפייסבוק.";
    // Only catalog groups can be posted to (the server refuses the rest), so the
    // others are left out — kept only when the campaign being edited has them.
    var shown = groups.filter(function (g) { return g.in_catalog || (checked && checked.indexOf(g.group_id) >= 0); });
    var hidden = groups.length - shown.length;
    $("#campFormGroupsHidden").textContent = hidden ? "עוד " + hidden + " קבוצות של הסוכן לא מוצגות — הן לא בקטלוג, ולכן אי אפשר לפרסם בהן בקמפיין." : "";
    shown.sort(function (a, b) { return (b.name ? 1 : 0) - (a.name ? 1 : 0) || String(a.name).localeCompare(String(b.name), "he"); });
    if (!shown.length) { emptyGroups("הסוכן לא חבר באף קבוצה מהקטלוג — אפשר לפרסם רק בדף העסקי."); return; }
    $("#campFormGroups").innerHTML = shown.map(function (g) {
      var on = checked && checked.indexOf(g.group_id) >= 0;
      return '<label class="camp-g' + (on ? " on" : "") + '"><input type="checkbox" value="' + esc(g.group_id) + '"' + (on ? " checked" : "") + '> <span class="camp-gn">' + esc(g.name || "קבוצה ללא שם · " + g.group_id) + "</span></label>";
    }).join("");
    $("#campFormGroupBar").hidden = false;
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
      showGroups(d, keep); groupsChanged(); FLY.toast("הקבוצות עודכנו");
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
  function setAllGroups(on) { // only the groups the search shows
    Array.prototype.forEach.call(document.querySelectorAll("#campFormGroups .camp-g:not([hidden]) input"), function (i) { i.checked = on; });
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
  function closeForm() { seq++; editing = null; restarting = null; initial = null; $("#campForm").hidden = true; $("#campFormSave").disabled = false; $("#campFormEstimate").textContent = ""; clearError(); }
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
    editing = row || null; restarting = null;
    setMain(true);
    $("#campFormTitle").textContent = row ? "עריכת קמפיין" : "קמפיין חדש";
    $("#campFormAgent").disabled = !!row; $("#campFormProperty").disabled = !!row;
    $("#campFormConsent").hidden = !!row;
    $("#campFormAgent").value = ""; $("#campFormProperty").innerHTML = ""; emptyGroups("");
    $("#campFormConsentMethod").value = "phone"; $("#campFormConsentNote").value = "";
    $("#campFormSave").disabled = false; $("#campFormEstimate").textContent = ""; clearError();
    $("#campFormSave").textContent = row ? "שמירת שינויים" : "יצירת קמפיין";
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
      loadAgentChoices(row.ref, row.groups.map(function (g) { return g.group_id; })).then(function (ok) { if (ok && my + 1 === seq) { $("#campFormProperty").value = row.page_id; showEstimate(); } });
    } else {
      // start from the agent the list is filtered to
      $("#campFormAgent").value = $("#campAgent").value;
      loadAgentChoices($("#campFormAgent").value, null);
    }
  }
  function openRestart(row) {
    seq++;
    editing = null; restarting = row;
    setMain(false);
    $("#campFormTitle").textContent = "הפעלה מחדש — הסכמת הסוכן";
    $("#campFormConsent").hidden = false;
    $("#campFormConsentMethod").value = "phone"; $("#campFormConsentNote").value = "";
    $("#campFormDays").value = String(row.run_days || 30); // as long as the run it repeats
    $("#campFormSave").disabled = false; $("#campFormEstimate").textContent = ""; clearError();
    $("#campFormSave").textContent = "הפעלה מחדש";
    showForm();
  }
  function settle(p) { // one request in flight per save click
    $("#campFormSave").disabled = true;
    return p.then(function () { $("#campFormSave").disabled = false; }, function () { $("#campFormSave").disabled = false; });
  }
  function save() {
    if ($("#campFormSave").disabled) return;
    clearError();
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
        consent: { method: $("#campFormConsentMethod").value, note: note },
      }).then(function (d) { closeForm(); FLY.toast(d.existing ? "לנכס הזה כבר יש קמפיין — פתחו אותו לעריכה" : "הקמפיין נפתח והסוכן קיבל הודעה"); load(); }).catch(failClose));
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
    if (add.length) body.add_group_ids = add;
    if (rem.length) body.remove_group_ids = rem;
    if (Object.keys(body).length === 1) { closeForm(); FLY.toast("לא היו שינויים"); return; }
    return settle(req("PATCH", "/campaigns/" + encodeURIComponent(editing.id), body)
      .then(function () { closeForm(); FLY.toast("נשמר"); load(); }).catch(failClose));
  }
  function failClose(e) { // a stale version closes the form: the reload brings the fresh row to edit
    if (e && e.code === "stale_version") closeForm();
    fail(e);
  }
  function act(id, what) {
    var row = rows.filter(function (r) { return r.id === id; })[0];
    if (!row) return;
    if (what === "edit") return openForm(row);
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
  $("#campFormNone").addEventListener("click", function () { setAllGroups(false); });
  $("#campFormDays").addEventListener("input", syncTiming);
  $("#campFormRepeatOn").addEventListener("change", function () { syncTiming(); showEstimate(); });
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
