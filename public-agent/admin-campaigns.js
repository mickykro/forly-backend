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
    posting_unavailable_in_env: "בשרת הזה אי אפשר לשנות קמפיינים.",
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
    $("#campList").innerHTML = !rows.length ? '<p class="manual-muted">אין קמפיינים.</p>' : rows.map(function (r) {
      var live = r.status === "running" || r.status === "paused";
      return '<div class="manual-agent" data-camp="' + esc(r.id) + '">' +
        "<h3>" + esc(r.agent_name || r.phone_tail) + " · " + esc(r.page_title) + " <small>" + esc(STATUS[r.status] || r.status) + "</small></h3>" +
        '<div class="manual-muted">' + r.groups.length + " קבוצות · פורסם " + r.counts.posted + " · עד " + fmt(r.expires_at) +
        (r.repeat ? " · חזרה כל " + esc(r.repeat_days) + " ימים" : "") + " · נוצר על ידי " + (r.created_by === "admin" ? "הצוות" : "הסוכן") + "</div>" +
        (live ? '<button type="button" class="btn btn-ghost btn-sm" data-act="edit">עריכה</button>' : "") +
        (live ? '<button type="button" class="btn btn-ghost btn-sm" data-act="stop">עצירה</button>' : "") +
        (r.status !== "running" ? '<button type="button" class="btn btn-ghost btn-sm" data-act="start">הפעלה</button>' : "") +
        "</div>";
    }).join("");
  }
  function load() {
    var q = [];
    if ($("#campStatus").value) q.push("status=" + encodeURIComponent($("#campStatus").value));
    if ($("#campAgent").value) q.push("agent=" + encodeURIComponent($("#campAgent").value));
    return req("GET", "/campaigns" + (q.length ? "?" + q.join("&") : "")).then(function (d) { rows = d.campaigns || []; render(); }).catch(fail);
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
  function loadAgentChoices(ref, checked) {
    var my = ++seq;
    if (!ref) { $("#campFormProperty").innerHTML = ""; $("#campFormGroups").innerHTML = ""; return Promise.resolve(false); }
    return Promise.all([req("GET", "/agents/" + encodeURIComponent(ref) + "/properties"), req("GET", "/agents/" + encodeURIComponent(ref) + "/groups")]).then(function (r) {
      if (my !== seq) return false;
      $("#campFormProperty").innerHTML = (r[0].properties || []).map(function (p) { return '<option value="' + esc(p.page_id) + '">' + esc(p.title) + "</option>"; }).join("");
      $("#campFormGroups").innerHTML = (r[1].groups || []).map(function (g) {
        var on = checked && checked.indexOf(g.group_id) >= 0 ? " checked" : "";
        return '<label><input type="checkbox" value="' + esc(g.group_id) + '"' + on + "> " + esc(g.name || g.group_id) + "</label>";
      }).join("");
      return true;
    }).catch(function (e) { if (my === seq) fail(e); return false; });
  }
  function chosenGroups() { return Array.prototype.map.call(document.querySelectorAll("#campFormGroups input:checked"), function (i) { return i.value; }); }
  function setMain(show) { // the campaign fields vs. the consent-only restart form
    Array.prototype.forEach.call(document.querySelectorAll("#campForm > label, #campForm > fieldset:not(#campFormConsent)"), function (el) { el.hidden = !show; });
  }
  function closeForm() { seq++; editing = null; restarting = null; initial = null; $("#campForm").hidden = true; $("#campFormSave").disabled = false; }
  function validNote() {
    var n = $("#campFormConsentNote").value.trim();
    if (!n || n.length > 300) { FLY.toast("חובה לכתוב הערת הסכמה של 1 עד 300 תווים."); return null; }
    return n;
  }

  function openForm(row) {
    var my = ++seq;
    editing = row || null; restarting = null;
    setMain(true);
    $("#campFormTitle").textContent = row ? "עריכת קמפיין" : "קמפיין חדש";
    $("#campFormAgent").disabled = !!row; $("#campFormProperty").disabled = !!row;
    $("#campFormConsent").hidden = !!row;
    $("#campFormAgent").value = ""; $("#campFormProperty").innerHTML = ""; $("#campFormGroups").innerHTML = "";
    $("#campFormConsentMethod").value = "phone"; $("#campFormConsentNote").value = "";
    $("#campFormSave").disabled = false;
    if (row) {
      var left = Math.min(30, Math.max(1, Math.ceil((Date.parse(row.expires_at) - Date.now()) / 86400000)) || 1);
      initial = { days: String(left), repeat: row.repeat ? String(row.repeat_days) : "0", mode: row.mode, page: row.targets.indexOf("page") >= 0 };
      $("#campFormDays").value = initial.days; $("#campFormRepeat").value = initial.repeat;
      $("#campFormMode").value = initial.mode; $("#campFormPage").checked = initial.page;
    } else {
      initial = null;
      $("#campFormDays").value = "14"; $("#campFormRepeat").value = "0"; $("#campFormMode").value = "standing"; $("#campFormPage").checked = false;
    }
    $("#campForm").hidden = false;
    if (row) {
      $("#campFormAgent").value = row.ref;
      loadAgentChoices(row.ref, row.groups.map(function (g) { return g.group_id; })).then(function (ok) { if (ok && my + 1 === seq) $("#campFormProperty").value = row.page_id; });
    }
  }
  function openRestart(row) {
    seq++;
    editing = null; restarting = row;
    setMain(false);
    $("#campFormTitle").textContent = "הפעלה מחדש — הסכמת הסוכן";
    $("#campFormConsent").hidden = false;
    $("#campFormConsentMethod").value = "phone"; $("#campFormConsentNote").value = "";
    $("#campFormSave").disabled = false;
    $("#campForm").hidden = false;
  }
  function settle(p) { // one request in flight per save click
    $("#campFormSave").disabled = true;
    return p.then(function () { $("#campFormSave").disabled = false; }, function () { $("#campFormSave").disabled = false; });
  }
  function save() {
    if ($("#campFormSave").disabled) return;
    if (restarting) {
      var rn = validNote(); if (!rn) return;
      var rid = restarting.id;
      return settle(req("POST", "/campaigns/" + encodeURIComponent(rid) + "/start", { consent: { method: $("#campFormConsentMethod").value, note: rn } })
        .then(function () { closeForm(); FLY.toast("הקמפיין פעיל"); load(); }).catch(failClose));
    }
    var targets = $("#campFormPage").checked ? ["groups", "page"] : ["groups"];
    var repeat = Number($("#campFormRepeat").value) || 0;
    if (!editing) {
      var note = validNote(); if (!note) return;
      return settle(req("POST", "/campaigns", {
        agent: $("#campFormAgent").value, page_id: $("#campFormProperty").value, group_ids: chosenGroups(),
        days: Number($("#campFormDays").value) || 14, repeat_days: repeat || undefined, mode: $("#campFormMode").value, targets: targets,
        consent: { method: $("#campFormConsentMethod").value, note: note },
      }).then(function (d) { closeForm(); FLY.toast(d.existing ? "לנכס הזה כבר יש קמפיין — פתחו אותו לעריכה" : "הקמפיין נפתח והסוכן קיבל הודעה"); load(); }).catch(failClose));
    }
    var before = editing.groups.map(function (g) { return g.group_id; }), now = chosenGroups();
    var add = now.filter(function (g) { return before.indexOf(g) < 0; }), rem = before.filter(function (g) { return now.indexOf(g) < 0; });
    var body = { version: editing.version };
    if ($("#campFormDays").value !== initial.days) body.days = Number($("#campFormDays").value) || 14;
    if ($("#campFormRepeat").value !== initial.repeat) body.repeat_days = repeat;
    if ($("#campFormMode").value !== initial.mode) body.mode = $("#campFormMode").value;
    if ($("#campFormPage").checked !== initial.page) body.targets = targets;
    if (add.length) body.add_group_ids = add;
    if (rem.length) body.remove_group_ids = rem;
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
  $("#campFormSave").addEventListener("click", save);
  $("#campFormCancel").addEventListener("click", closeForm);
  $("#campList").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-act]"); if (!b) return;
    act(b.closest("[data-camp]").getAttribute("data-camp"), b.getAttribute("data-act"));
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
