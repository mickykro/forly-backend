/* Forly Admin Console — the live posting sessions in "פרסום אוטומטי"
   (routes/admin-posting-live.js). One tile per browser posting now; one live
   view at a time (connect-viewer.js). Clicks and keys reach the browser only
   after "להשתלט" — the server refuses them before. Every lever needs a fresh
   OTP login, like the rest of the tab. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var esc = FLY.esc;
  var API = "/api/admin/posting/live";
  var STEPS = {
    session_started: "פותח את הקבוצה", composer_ready: "כותב את הפוסט", submit_started: "לוחץ פרסום",
    verification_pending: "מוודא שהפוסט עלה", verified_posted: "פורסם", submitted_for_approval: "ממתין לאישור מנהל הקבוצה",
    verified_failed: "נכשל", outcome_unknown: "לא ברור אם עלה", cancelled: "בוטל",
  };
  var STATES = { running: "רץ", holding: "יסתיים אחרי הפוסט הזה", skipping: "מדלג על הפוסט", taking: "עוצר את האוטומציה…", taken: "בשליטתכם" };
  var sessions = [], watching = null, viewer = null;

  function act(ref, what, body) {
    return FLY.req(API + "/sessions/" + encodeURIComponent(ref) + "/" + what, { method: "POST", body: body || {}, noRedirect: true })
      .then(function (d) { if (d && d.audited === false) FLY.toast("בוצע, אך לא נרשם ביומן"); load(); return d; })
      .catch(function (e) {
        if (e && e.status === 401 && e.code === "stepup_required") return FLY.toast("נדרש אימות מחדש — התחברו שוב");
        FLY.toast(e && e.code === "session_ended" ? "הסשן כבר הסתיים" : "שגיאה: " + ((e && e.code) || ""));
      });
  }

  function tile(s) {
    var taken = s.state === "taken";
    var btn = function (a, label, cls) { return '<button type="button" class="btn ' + (cls || "btn-ghost") + ' btn-sm" data-live="' + a + '" data-ref="' + esc(s.ref) + '">' + label + "</button>"; };
    return '<div class="message-card" style="margin:8px 0">' +
      "<b>סוכן …" + esc(s.phone_tail) + "</b> · " + esc(STATES[s.state] || s.state) +
      "<br>קמפיין …" + esc(s.campaign_tail || "—") + " · פוסט " + esc(String(s.posts || 0)) + " בסשן · " + esc(STEPS[s.step] || s.step || "") +
      (s.target_url ? '<br><a href="' + esc(s.target_url) + '" target="_blank" rel="noopener" dir="ltr">' + esc(s.target_url) + "</a>" : "") +
      '<div class="posting-row">' + btn("watch", watching === s.ref ? "סגירת התצוגה" : "צפייה") +
      (taken ? btn("posted", "✅ פרסמתי — לסמן כפורסם", "btn-gold") + btn("skipped", "לא פורסם — לסמן כדילוג")
        : s.state === "taking" ? "" : btn("hold", "לסיים ולעצור") + btn("skip", "לדלג על הפוסט") + btn("takeover", "להשתלט ידנית", "btn-gold")) +
      "</div></div>";
  }

  function render() {
    $("#postingLiveList").innerHTML = sessions.length ? sessions.map(tile).join("") : "אין סשן פעיל.";
    if (watching && !sessions.some(function (s) { return s.ref === watching; })) unwatch();
  }
  function unwatch() { if (viewer) viewer.unmount(); viewer = null; watching = null; $("#postingLiveView").innerHTML = ""; }
  function watch(ref) {
    unwatch();
    watching = ref;
    viewer = window.ForlyViewer.create($("#postingLiveView"), API + "/sessions/" + encodeURIComponent(ref) + "/view", {
      onEnd: function () { if (watching === ref) { watching = null; viewer = null; } },
    });
    render();
  }

  function load() {
    return FLY.req(API + "/sessions", { noRedirect: true }).then(function (d) { sessions = (d && d.sessions) || []; render(); }).catch(function () {});
  }
  // Polls only while the tab is on screen.
  function tick() { if (document.visibilityState === "visible" && $("#postingLiveList").offsetParent) load(); }

  $("#postingLiveList").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-live]");
    if (!b) return;
    var a = b.getAttribute("data-live"), ref = b.getAttribute("data-ref");
    if (a === "watch") return watching === ref ? (unwatch(), render()) : watch(ref);
    if (a === "takeover" && !confirm("לעצור את האוטומציה ולקבל את הדפדפן? אחר כך תסמנו אם הפוסט פורסם.")) return;
    if (a === "skip" && !confirm("לדלג על הפוסט הנוכחי? הוא לא יפורסם בסבב הזה.")) return;
    if (a === "takeover") act(ref, "takeover").then(function () { if (watching !== ref) watch(ref); });
    else if (a === "posted" || a === "skipped") act(ref, "release", { outcome: a });
    else act(ref, a);
  });
  setInterval(tick, 3000);
  load();
})();
