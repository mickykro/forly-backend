/*
 * admin-agent-panel.js — under the campaigns tab's agent filter: one agent's
 * automatic posting. Pause/resume all of it (a reason, a fresh step-up, an
 * audit row: routes/admin-agents.js), and what happened lately — posts,
 * failures, Facebook's halts, and failure screenshots where they exist.
 */
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var esc = FLY.esc, API = "/api/admin/agents/";
  var box = $("#campAgentPanel"), pick = $("#campAgent");
  if (!box || !pick) return;
  var STATE = {
    verified_posted: "פורסם", verified_failed: "נכשל", outcome_unknown: "לא ידוע", cancelled: "בוטל",
    reserved: "בתור", session_started: "בדרך", composer_ready: "בדרך", submit_started: "נשלח", verification_pending: "נבדק",
  };
  var ERR = { posting_unavailable_in_env: "בסביבה הזו אין שינויים בפרסום", reason_required: "חובה לכתוב סיבה", audit_unavailable: "יומן הפעולות לא זמין — לא שונה דבר" };
  var when = function (v) { var d = new Date(v); return isNaN(d) ? "—" : d.toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" }); };
  var seq = 0;

  function fail(e) {
    if (e && e.status === 401 && e.code === "stepup_required") { $("#campStepUp").classList.remove("hidden"); FLY.toast("נדרש אימות מחדש — התחברו שוב"); return; }
    FLY.toast((e && ERR[e.code]) || "הפעולה נכשלה");
  }
  function render(ref, d) {
    var p = d.paused;
    var head = '<div class="posting-row"><b>' + (p ? "הפרסום האוטומטי של הסוכן מושהה" : d.disabled ? "החשבון מושבת (עצירה של פייסבוק)" : "הפרסום האוטומטי פעיל") + "</b>" +
      ' <button type="button" class="btn btn-sm ' + (p ? "btn-gold" : "btn-ghost") + '" id="agentPause">' + (p ? "המשך פרסום" : "השהיית הסוכן") + "</button>" +
      ' <span class="posting-note">' + esc(d.running) + " קמפיינים פעילים" + (p ? " · הושהה " + esc(when(p.at)) + " · " + esc(p.reason || "") : "") + "</span></div>";
    var rows = (d.attempts || []).map(function (a) {
      return "<tr><td>" + esc(when(a.at)) + "</td><td>" + esc(a.group || (a.target === "page" ? "דף עסקי" : "—")) + "</td><td>" + esc(STATE[a.state] || a.state) +
        (a.error_code ? " · " + esc(a.error_code) : "") + "</td></tr>";
    }).join("");
    var halts = (d.halts || []).map(function (x) { return "<li>" + esc(when(x.at)) + " · " + esc(x.code) + "</li>"; }).join("");
    var shots = (d.shots || []).map(function (s) {
      return "<li>" + esc(when(s.at)) + " · " + esc(s.error_code || "") + (s.image ? ' · <a href="/api/dev/driver-shots/' + encodeURIComponent(s.id) + '.jpg" target="_blank" rel="noopener">צילום מסך</a>' : "") + "</li>";
    }).join("");
    box.innerHTML = head +
      "<details open><summary>פעילות בשבוע האחרון (" + (d.attempts || []).length + ")</summary>" +
      (rows ? '<table class="posting-table"><thead><tr><th>מתי</th><th>קבוצה</th><th>תוצאה</th></tr></thead><tbody>' + rows + "</tbody></table>" : '<p class="posting-note">אין פעילות.</p>') + "</details>" +
      (halts ? "<details><summary>עצירות של פייסבוק</summary><ul>" + halts + "</ul></details>" : "") +
      (shots ? "<details><summary>צילומי מסך של כשלונות</summary><ul>" + shots + "</ul></details>" : "");
    $("#agentPause").addEventListener("click", function () { toggle(ref, !p, this); });
  }
  function load() {
    var ref = pick.value, my = ++seq;
    box.hidden = !ref;
    if (!ref) { box.innerHTML = ""; return; }
    box.innerHTML = '<p class="posting-note">טוענים…</p>';
    FLY.req(API + encodeURIComponent(ref) + "/activity", { noRedirect: true })
      .then(function (d) { if (my === seq) render(ref, d); })
      .catch(function (e) { if (my === seq) { box.innerHTML = '<p class="posting-note">הטעינה נכשלה.</p>'; fail(e); } });
  }
  function toggle(ref, pause, btn) {
    var reason = "admin"; // one admin: no reason is asked
    btn.disabled = true;
    FLY.req(API + encodeURIComponent(ref) + "/pause", { method: "POST", body: { paused: pause, reason: reason }, noRedirect: true })
      .then(function () { $("#campStepUp").classList.add("hidden"); FLY.toast(pause ? "✅ הסוכן הושהה" : "✅ הפרסום ממשיך"); load(); })
      .catch(function (e) { btn.disabled = false; fail(e); });
  }
  pick.addEventListener("change", load);
})();
