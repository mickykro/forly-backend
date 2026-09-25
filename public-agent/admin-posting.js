/* Forly Admin Console — the "פרסום אוטומטי" tab (Task 21).
   Kept out of admin.js (over its size cap): this file wires its own tab and
   pane next to admin.js's four. Everything comes from
   /api/admin/posting/overview; every change asks for a reason, sends the
   switch version it was shown (compare-and-set), and needs a fresh OTP login
   (401 stepup_required → "log in again"). Phones arrive as last-4 tails and
   accounts are addressed by an opaque ref. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var esc = FLY.esc;
  var API = "/api/admin/posting";
  var AUDIT_WARN = "השינוי נשמר אך לא נרשם ביומן — פנו למפתח";
  var OWNER_ONLY = { owner_reenable: 1, reenable_after_reconnect: 1 };
  var AGENT_Q = "הסוכן השלים את האימות ואישר שהחשבון תקין?";
  var state = null;

  var CLASS_LABELS = {
    captcha: "CAPTCHA", checkpoint: "אימות זהות (checkpoint)", restricted: "חשבון מוגבל",
    suspected_compromise: "חשד לפריצה", rate_limited: "הגבלת קצב", feature_blocked: "חסימת פעולה",
    login_required: "נדרשת התחברות", confirmed_removed: "פוסט הוסר ע״י מנהלי קבוצה",
    selector_failure: "תקלת ממשק", unknown: "לא ידוע",
  };
  var PLATFORM_LABELS = { facebook: "פייסבוק", yad2: "יד2", madlan: "מדלן" };
  var AUDIT_LABELS = {
    switch_global: "מתג ראשי", switch_platform: "מתג פלטפורמה", switch_visible: "לייקים וסטוריז",
    reenable: "הפעלה מחדש", revoke_profile: "ביטול פרופיל",
  };
  var SECTION_LABELS = {
    switch: "המתגים", health: "הבריאות", campaigns: "ספירת הקמפיינים", accounts_disabled: "החשבונות המושבתים",
    halts_recent: "העצירות האחרונות", accounts: "פרטי החשבונות", audit: "יומן הפעולות",
  };
  var ERRORS = {
    version_conflict: "המתג שונה בינתיים — המצב נטען מחדש",
    owner_required: "רק בעלים יכולים להפעיל מחדש את החשבון הזה",
    owner_not_configured: "POSTING_OWNER_PHONES לא מוגדר — אין הפעלה מחדש ברמת בעלים",
    agent_confirmation_required: "נדרש אישור שהסוכן וידא את תקינות החשבון",
    reconnect_required: "הסוכן צריך להתחבר מחדש עם פרופיל חדש לפני הפעלה מחדש",
    not_disabled: "החשבון כבר פעיל", reason_required: "חובה לכתוב סיבה", not_found: "החשבון לא נמצא",
  };

  function fmt(v) {
    if (!v) return "—";
    var d = new Date(v);
    return isNaN(d.getTime()) ? "—" : d.toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });
  }
  function onOff(on) { return on ? "פעיל" : "כבוי"; }
  function askReason(q) {
    var r = window.prompt(q || "סיבה?");
    r = r == null ? "" : String(r).trim();
    if (!r) FLY.toast("בוטל — חובה לכתוב סיבה");
    return r || null;
  }

  function handleError(e, fallback) {
    if (e && e.status === 401 && e.code === "stepup_required") {
      $("#postingStepUp").classList.remove("hidden");
      FLY.toast("נדרש אימות מחדש — התחברו שוב");
      return;
    }
    if (e && e.status === 401) { location.href = "/?next=" + encodeURIComponent("/admin.html"); return; }
    FLY.toast((e && ERRORS[e.code]) || fallback || "שגיאה");
    if (e && e.code === "version_conflict") load();
  }

  // A change the server applied but could not write to the audit log.
  function saved(d, msg) { FLY.toast(d && d.audited === false ? AUDIT_WARN : msg); }

  function send(path, body) {
    return FLY.req(API + path, { method: "POST", body: body, noRedirect: true }).then(function (d) {
      $("#postingStepUp").classList.add("hidden");
      return d;
    });
  }

  // A switch: reason first, then compare-and-set against the version shown.
  function flip(input, path, extra) {
    var want = input.checked;
    var reason = askReason(want ? "סיבה להדלקה?" : "סיבה לכיבוי?");
    if (!reason || !state) { input.checked = !want; return; }
    input.disabled = true;
    var body = { enabled: want, reason: reason, version: state.version };
    Object.keys(extra || {}).forEach(function (k) { body[k] = extra[k]; });
    send(path, body)
      .then(function (d) { saved(d, "✅ נשמר"); return load(); })
      .catch(function (e) { input.checked = !want; handleError(e, "שגיאה בעדכון המתג"); })
      .then(function () { input.disabled = false; });
  }

  function switchRow(id, label, on) {
    return '<div class="posting-row"><label class="switch"><input type="checkbox" id="' + id + '"' +
      (on ? " checked" : "") + '><i></i></label> <span>' + esc(label) + " — " + onOff(on) + "</span></div>";
  }

  function statusText(a) {
    var s = a.disabled ? (a.owner_review ? "ממתין לבדיקת בעלים" : "מושבת") :
      a.owner_review ? "ממתין לבדיקת בעלים" :
      a.penalty_until ? "האטה עד " + fmt(a.penalty_until) :
      a.needs_reconnect ? "ממתין להתחברות מחדש" : "—";
    if (a.class === "suspected_compromise" && a.disabled) {
      s += a.reconnected_after_halt ? " · הסוכן התחבר עם פרופיל חדש" : " · ממתין להתחברות מחדש עם פרופיל חדש";
    } else if (a.reconnected_since_disable) s += " · הסוכן התחבר מחדש";
    return s;
  }

  function actionButtons(a) {
    return (a.allowed_actions || []).filter(function (act) {
      // Owner-only buttons for owners only; the reconnect lift only once the
      // agent reconnected a new profile (the server checks both again).
      if (OWNER_ONLY[act] && !(state && state.is_owner)) return false;
      return act !== "reenable_after_reconnect" || a.reconnected_after_halt === true;
    }).map(function (act) {
      var label = act === "reenable" ? "הפעלה מחדש" : act === "owner_reenable" ? "בדיקת בעלים והפעלה" :
        act === "reenable_after_reconnect" ? "הפעלה מחדש (בעלים)" : act === "revoke_profile" ? "ביטול פרופיל" : act;
      var cls = act === "revoke_profile" ? "btn btn-danger btn-sm" : "btn btn-ghost btn-sm";
      return '<button type="button" class="' + cls + '" data-posting-act="' + esc(act) + '" data-ref="' + esc(a.ref) + '"' +
        (a.needs_agent_confirmation ? ' data-agent-confirm="1"' : "") + ">" + esc(label) + "</button>";
    }).join(" ") || '<span class="p-addr">—</span>';
  }

  function renderWarnings(list) {
    var box = $("#postingWarnings");
    box.innerHTML = (list || []).map(function (w) {
      var i = w.indexOf(":");
      var kind = w.slice(0, i), sec = SECTION_LABELS[w.slice(i + 1)] || w.slice(i + 1);
      return "<div>" + (kind === "index_missing" ?
        "חסר אינדקס (" + esc(sec) + ") — יש להריץ firebase deploy --only firestore:indexes" :
        "טעינת " + esc(sec) + " נכשלה") + "</div>";
    }).join("");
    box.classList.toggle("hidden", !(list && list.length));
  }

  function render(d) {
    state = d;
    renderWarnings(d.warnings);
    var known = d.enabled === true || d.enabled === false; // null: the switch doc could not be read
    $("#postingGlobal").checked = !!d.enabled;
    $("#postingGlobal").disabled = !known;
    $("#postingGlobalLabel").textContent = !known ? "לא ידוע" : onOff(d.enabled) + (d.enabled ? "" : d.disabled_reason ? " — " + d.disabled_reason : "");
    $("#postingEnvNote").classList.toggle("hidden", !d.env_forced_off);
    var lc = d.last_change;
    $("#postingLastChange").textContent =
      (d.changed_at ? "שינוי אחרון במתג הראשי: …" + (d.changed_by_tail || "?") + " · " + (d.reason || "") + " · " + fmt(d.changed_at) : "המתג הראשי לא שונה ידנית.") +
      (lc && lc.what !== "global" ? " | שינוי אחרון בכלל המתגים: " + lc.what + " " + onOff(lc.enabled) + " · …" + (lc.by_tail || "?") + " · " + (lc.reason || "") + " · " + fmt(lc.at) : "");

    var rows = Object.keys(PLATFORM_LABELS).map(function (p) {
      return switchRow("postingPlatform_" + p, PLATFORM_LABELS[p], d.platforms && d.platforms[p]);
    });
    rows.push(switchRow("postingVisible", "לייקים וצפייה בסטוריז", d.visible_interactions_enabled));
    $("#postingSwitches").innerHTML = known ? rows.join("") : '<p class="posting-note">מצב המתגים לא נטען.</p>';
    if (known) Object.keys(PLATFORM_LABELS).forEach(function (p) {
      var input = $("#postingPlatform_" + p);
      input.addEventListener("change", function () { flip(input, "/switch/platform", { platform: p }); });
    });
    var vis = known && $("#postingVisible");
    if (vis) vis.addEventListener("change", function () { flip(vis, "/switch/visible"); });

    var c = d.campaigns || {};
    var stat = function (n, l) { return '<div class="stat"><div class="n num">' + esc(n == null ? "—" : n) + '</div><div class="l">' + esc(l) + "</div></div>"; };
    $("#postingCounts").innerHTML = stat(c.running, "קמפיינים פעילים") + stat(c.paused, "מושהים") + stat(c.stopped, "נעצרו") +
      stat(c.completed, "הסתיימו") + stat(d.accounts_disabled, "חשבונות מושבתים") + stat(d.owner_review, "ממתינים לבעלים");

    var html = [];
    Object.keys(d.halts_by_class || {}).sort().forEach(function (cls) {
      d.halts_by_class[cls].forEach(function (a) {
        html.push("<tr><td>" + esc(CLASS_LABELS[cls] || cls) + '</td><td class="num" dir="ltr">…' + esc(a.phone_tail) + "</td>" +
          '<td class="p-addr num">' + esc(fmt(a.disabled_at || a.last_halt_at)) + "</td><td>" + esc(statusText(a)) + "</td>" +
          "<td>" + actionButtons(a) + "</td></tr>");
      });
    });
    $("#postingHalted").innerHTML = html.join("");
    $("#postingHaltedEmpty").classList.toggle("hidden", html.length > 0);

    var h = d.posting_health;
    $("#postingHealth").textContent = !h ? "לא נטען." : "סריקה אחרונה: " + fmt(h.last_sweep_at) + " · ניסיונות שלא שוחררו: " + (h.reap_failures_count || 0) +
      " · ביטולים שנכשלו: " + (h.cancel_failures_count || 0) + (d.owner_configured ? "" : " · POSTING_OWNER_PHONES לא מוגדר");
    $("#postingAudit").innerHTML = (d.recent_audit || []).map(function (e) {
      return "<li>" + esc(fmt(e.at)) + " · " + esc(AUDIT_LABELS[e.action] || e.action) + " · …" + esc(e.operator_tail || "?") +
        (e.target_phone_tail ? ' → <span dir="ltr">…' + esc(e.target_phone_tail) + "</span>" : "") + (e.reason ? " · " + esc(e.reason) : "") + "</li>";
    }).join("") || '<li class="p-addr">אין פעולות ב-30 הימים האחרונים.</li>';
  }

  function act(btn) {
    var kind = btn.dataset.postingAct;
    var ref = btn.dataset.ref;
    var ask = {
      reenable: AGENT_Q,
      reenable_after_reconnect: "חשד לפריצה: הסוכן התחבר עם פרופיל חדש. הפעלה מחדש ברמת בעלים — להמשיך?",
      owner_reenable: "הפעלה מחדש ברמת בעלים (חשבון מוגבל או עצירה שנייה ב-30 יום). להמשיך?",
      revoke_profile: "ביטול ומחיקת פרופיל הדפדפן של הסוכן. הסוכן יצטרך להתחבר מחדש. להמשיך?",
    }[kind];
    if (!ask || !window.confirm(ask)) return;
    // A captcha/checkpoint among the account's halts needs the agent's
    // confirmation on the owner path too: the operator attests it.
    var confirmAgent = kind === "reenable" || (kind !== "revoke_profile" && btn.dataset.agentConfirm === "1");
    if (confirmAgent && kind !== "reenable" && !window.confirm(AGENT_Q)) return;
    var reason = askReason("סיבה?");
    if (!reason) return;
    var path = "/accounts/" + encodeURIComponent(ref) + (kind === "revoke_profile" ? "/revoke-profile" : "/reenable");
    var body = confirmAgent ? { reason: reason, agent_confirmed: true } : { reason: reason };
    btn.disabled = true;
    send(path, body)
      .then(function (d) { saved(d, kind === "revoke_profile" ? "הפרופיל בוטל" : "✅ החשבון הופעל מחדש"); return load(); })
      .catch(function (e) { btn.disabled = false; handleError(e, "הפעולה נכשלה"); });
  }

  function load() {
    return FLY.req(API + "/overview", { noRedirect: true }).then(function (d) {
      $("#postingUnavailable").classList.add("hidden");
      $("#postingBody").classList.remove("hidden");
      render(d);
    }).catch(function (e) {
      if (e && e.status === 404) {
        $("#postingBody").classList.add("hidden");
        $("#postingUnavailable").classList.remove("hidden");
        return;
      }
      handleError(e, "שגיאה בטעינת מצב הפרסום");
    });
  }

  var tab = $("#tabPosting");
  var pane = $("#panePosting");
  if (!tab || !pane) return;
  tab.addEventListener("click", function () {
    document.querySelectorAll(".tabs button").forEach(function (b) { b.classList.toggle("on", b === tab); });
    document.querySelectorAll("#viewAdmin [id^='pane']").forEach(function (p) { p.classList.toggle("hidden", p !== pane); });
    load();
  });
  // admin.js's own tabs show their panes; leaving ours just hides it.
  document.querySelectorAll(".tabs button").forEach(function (b) {
    if (b !== tab) b.addEventListener("click", function () { tab.classList.remove("on"); pane.classList.add("hidden"); });
  });
  $("#postingGlobal").addEventListener("change", function () { flip($("#postingGlobal"), "/switch"); });
  $("#postingHalted").addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-posting-act]");
    if (btn) act(btn);
  });
})();
