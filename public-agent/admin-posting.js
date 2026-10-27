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
  var MODE_LABELS = {
    manual: "פרסום ידני (מנהל מפרסם כל פוסט)", caps: "מגבלות פעילות (מקומי)", pacing: "קצב רגיל (מקומי)", warmup: "חימום חשבון חדש (מקומי)",
    burst: "מצב בדיקה — פרסום רצוף (מקומי)", browse: "גלישה בין סשנים (מקומי)", shots: "צילום מסך של כשלונות",
  };
  var PLATFORM_LABELS = { facebook: "פייסבוק", yad2: "יד2", madlan: "מדלן" };
  var AUDIT_LABELS = {
    caps: "מגבלות פרסום", modes: "מצבי פרסום", switch_global: "מתג ראשי", switch_platform: "מתג פלטפורמה", switch_visible: "לייקים וסטוריז", switch_staging: "פרסום מ־staging", sweep_now: "סבב פרסום ידני", replan: "הקדמת פוסטים לעכשיו",
    reenable: "הפעלה מחדש", revoke_profile: "ביטול פרופיל", resolve_attempt: "הכרעה בפוסט לא ידוע", resume_campaign: "המשך קמפיין",
  };
  var SECTION_LABELS = {
    switch: "המתגים", health: "הבריאות", campaigns: "ספירת הקמפיינים", accounts_disabled: "החשבונות המושבתים",
    halts_recent: "העצירות האחרונות", accounts: "פרטי החשבונות", audit: "יומן הפעולות",
    unknown_attempts: "הפוסטים בתוצאה לא ידועה", internal_paused: "הקמפיינים שנעצרו בתקלה",
  };
  var ERRORS = {
    version_conflict: "המתג שונה בינתיים — המצב נטען מחדש",
    owner_required: "רק בעלים יכולים להפעיל מחדש את החשבון הזה",
    owner_not_configured: "POSTING_OWNER_PHONES לא מוגדר — אין הפעלה מחדש ברמת בעלים",
    agent_confirmation_required: "נדרש אישור שהסוכן וידא את תקינות החשבון",
    reconnect_required: "הסוכן צריך להתחבר מחדש עם פרופיל חדש לפני הפעלה מחדש",
    not_disabled: "החשבון כבר פעיל", reason_required: "חובה לכתוב סיבה", not_found: "החשבון לא נמצא",
    not_outcome_unknown: "הפוסט כבר לא בתוצאה לא ידועה — המצב נטען מחדש", not_internal_pause: "הקמפיין כבר לא עצור בגלל תקלה",
    out_of_range: "ערך מחוץ לטווח המותר", not_resumable: "החשבון עצמו עצור — קודם צריך להפעיל אותו מחדש", posting_unavailable_in_env: "בסביבה הזו אין פרסום אוטומטי",
  };

  function fmt(v) {
    if (!v) return "—";
    var d = new Date(v);
    return isNaN(d.getTime()) ? "—" : d.toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });
  }
  function onOff(on) { return on ? "פעיל" : "כבוי"; }
  // One admin: no reason is asked; the action log records each change as made by the admin.
  function askReason() { return "admin"; }

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
    var lc = d.last_change;
    $("#postingLastChange").textContent =
      (d.changed_at ? "שינוי אחרון במתג הראשי: …" + (d.changed_by_tail || "?") + " · " + (d.reason || "") + " · " + fmt(d.changed_at) : "המתג הראשי לא שונה ידנית.") +
      (lc && lc.what !== "global" ? " | שינוי אחרון בכלל המתגים: " + lc.what + " " + onOff(lc.enabled) + " · …" + (lc.by_tail || "?") + " · " + (lc.reason || "") + " · " + fmt(lc.at) : "");

    var rows = Object.keys(PLATFORM_LABELS).map(function (p) {
      return switchRow("postingPlatform_" + p, PLATFORM_LABELS[p], d.platforms && d.platforms[p]);
    });
    rows.push(switchRow("postingVisible", "לייקים וצפייה בסטוריז", d.visible_interactions_enabled));
    rows.push(switchRow("postingStaging", "פרסום אוטומטי מ־staging (פרודקשן לא מפרסם)", d.sweeper_env === "staging"));
    $("#postingSwitches").innerHTML = known ? rows.join("") : '<p class="posting-note">מצב המתגים לא נטען.</p>';
    if (known) Object.keys(PLATFORM_LABELS).forEach(function (p) {
      var input = $("#postingPlatform_" + p);
      input.addEventListener("change", function () { flip(input, "/switch/platform", { platform: p }); });
    });
    renderCaps(known ? d.caps : null);
    renderModes(known ? d.modes : null);
    renderTemplates(known ? d.copy_templates || {} : null);
    var vis = known && $("#postingVisible");
    if (vis) vis.addEventListener("change", function () { flip(vis, "/switch/visible"); });
    var stg = known && $("#postingStaging");
    if (stg) stg.addEventListener("change", function () { flip(stg, "/switch/staging"); });

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

    renderUnknown(d.outcome_unknown);
    renderInternal(d.internal_paused);

    var h = d.posting_health;
    $("#postingHealth").textContent = !h ? "לא נטען." : "סריקה אחרונה: " + fmt(h.last_sweep_at) + " · ניסיונות שלא שוחררו: " + (h.reap_failures_count || 0) +
      " · ביטולים שנכשלו: " + (h.cancel_failures_count || 0) + (d.owner_configured ? "" : " · POSTING_OWNER_PHONES לא מוגדר");
    $("#postingAudit").innerHTML = (d.recent_audit || []).map(function (e) {
      return "<li>" + esc(fmt(e.at)) + " · " + esc(AUDIT_LABELS[e.action] || e.action) + " · …" + esc(e.operator_tail || "?") +
        (e.target_phone_tail ? ' → <span dir="ltr">…' + esc(e.target_phone_tail) + "</span>" : "") + (e.reason ? " · " + esc(e.reason) : "") + "</li>";
    }).join("") || '<li class="p-addr">אין פעולות ב-30 הימים האחרונים.</li>';
  }

  // I7: outcome_unknown attempts — the verdict is the operator's, after checking the group by hand.
  // Each cap: the admin's value (empty = default), with the default and what applies now.
  // All the posting rules (admin-rules.js): empty = the default.
  function renderCaps(caps) {
    $("#postingCapsSave").disabled = !caps;
    $("#postingCaps").innerHTML = caps ? FORLY_RULES.form(caps) : '<p class="posting-note">החוקים לא נטענו.</p>';
  }

  // Each mode: default (the env's own value) / on / off.
  function renderModes(modes) {
    $("#postingModesSave").disabled = !modes;
    if (!modes) { $("#postingModes").innerHTML = '<p class="posting-note">המצבים לא נטענו.</p>'; return; }
    var envText = function (v) { return v === null ? "לא מוגדר" : v === "1" ? "פעיל" : "כבוי"; };
    $("#postingModes").innerHTML = Object.keys(MODE_LABELS).filter(function (m) { return modes[m]; }).map(function (m) {
      var c = modes[m], sel = c.set === null ? "" : c.set ? "on" : "off";
      var opt = function (v, l) { return '<option value="' + v + '"' + (sel === v ? " selected" : "") + ">" + l + "</option>"; };
      return "<label>" + esc(MODE_LABELS[m]) + '<select data-mode="' + m + '">' + opt("", "ברירת מחדל") + opt("on", "פעיל") + opt("off", "כבוי") + "</select>" +
        '<span class="posting-note">בסביבה: ' + envText(c.env) + "</span></label>";
    }).join("");
  }
  // The pasted post per page language (share-kit.fillTemplate): empty = the built-in Hebrew copy.
  var TEMPLATE_LANGS = { he: "עברית", en: "English", ar: "العربية", ru: "Русский", es: "Español", fr: "Français" };
  function renderTemplates(t) {
    $("#postingTemplatesSave").disabled = !t;
    if (!t) { $("#postingTemplates").innerHTML = '<p class="posting-note">התבניות לא נטענו.</p>'; return; }
    $("#postingTemplates").innerHTML = Object.keys(TEMPLATE_LANGS).map(function (l) {
      return "<label>" + esc(TEMPLATE_LANGS[l]) + '<textarea data-lang="' + l + '" rows="6" maxlength="2000" dir="auto" style="width:100%;font:inherit;padding:8px 10px;border:1px solid rgba(23,20,15,.16);border-radius:9px">' + esc(t[l] || "") + "</textarea></label>";
    }).join("");
  }
  function saveTemplates(btn) {
    var templates = {};
    Array.prototype.forEach.call(document.querySelectorAll("#postingTemplates textarea[data-lang]"), function (ta) { templates[ta.dataset.lang] = ta.value; });
    var reason = askReason("למה משנים את התבניות?");
    if (!reason) return;
    btn.disabled = true;
    send("/templates", { templates: templates, reason: reason, version: state.version })
      .then(function (d) { saved(d, "✅ התבניות נשמרו"); return load(); })
      .catch(function (e) { handleError(e, "שגיאה בשמירת התבניות"); })
      .then(function () { btn.disabled = false; });
  }
  function saveModes(btn) {
    var modes = {};
    Array.prototype.forEach.call(document.querySelectorAll("#postingModes select[data-mode]"), function (s) {
      modes[s.dataset.mode] = s.value === "" ? null : s.value === "on";
    });
    var reason = askReason("למה משנים את מצבי הפרסום?");
    if (!reason) return;
    btn.disabled = true;
    send("/modes", { modes: modes, reason: reason, version: state.version })
      .then(function (d) { saved(d, "✅ המצבים נשמרו"); return load(); })
      .catch(function (e) { handleError(e, "שגיאה בשמירת המצבים"); })
      .then(function () { btn.disabled = false; });
  }
  function saveCaps(btn) {
    var got = FORLY_RULES.read($("#postingCaps"));
    if (got.bad) { got.bad.focus(); FLY.toast("מספר שלם בטווח " + got.bad.min + "–" + got.bad.max); return; }
    var caps = got.rules;
    var reason = askReason("למה משנים את המגבלות?");
    if (!reason) return;
    btn.disabled = true;
    send("/caps", { caps: caps, reason: reason, version: state.version })
      .then(function (d) { saved(d, "✅ החוקים נשמרו"); return load(); })
      .catch(function (e) { handleError(e, "שגיאה בשמירת המגבלות"); })
      .then(function () { btn.disabled = false; });
  }

  function renderUnknown(u) {
    $("#postingUnknownSummary").textContent = !u ? "לא נטען." : u.count ? (u.count_capped ? u.count + "+" : u.count) +
      " פוסטים ממתינים · הוותיק ביותר: " + (u.oldest_age_h == null ? "—" : u.oldest_age_h + " שעות") +
      " · כל פוסט נבדק עד 3 פעמים; אחרי זה — בדקו בקבוצה וסמנו. שום דבר לא מתפרסם מכאן." : "אין פוסטים בתוצאה לא ידועה.";
    $("#postingUnknown").innerHTML = ((u && u.oldest) || []).map(function (x) {
      var btn = function (o, l) { return '<button type="button" class="btn btn-ghost btn-sm" data-resolve="' + o + '" data-key="' + esc(x.key) + '">' + l + "</button>"; };
      return '<tr><td class="num" dir="ltr">…' + esc(x.phone_tail) + '</td><td class="p-addr num">' + esc(fmt(x.since)) + "</td><td>" + esc(x.reconcile_tries) +
        (x.next_reconcile_at ? " · הבאה " + esc(fmt(x.next_reconcile_at)) : " · לבדיקה ידנית") + "</td><td>" + esc(x.note || "—") + "</td><td>" +
        btn("posted", "עלה") + " " + btn("not_posted", "לא עלה") + "</td></tr>";
    }).join("");
  }
  // R5: campaigns paused `internal` — resumed from here once the fix is in.
  function renderInternal(list) {
    $("#postingInternal").innerHTML = (list || []).map(function (c) {
      return '<tr><td class="num" dir="ltr">…' + esc(c.phone_tail) + '</td><td class="p-addr num">' + esc(fmt(c.updated_at)) + "</td><td>" +
        esc((c.selector_failures || 0) + " ממשק · " + (c.tick_errors || 0) + " פנימיות") + '</td><td><button type="button" class="btn btn-ghost btn-sm" data-resume="' +
        esc(c.id) + '">המשך</button></td></tr>';
    }).join("");
    $("#postingInternalEmpty").classList.toggle("hidden", !!(list && list.length));
  }
  function resolveOne(btn) {
    var posted = btn.dataset.resolve === "posted";
    if (!window.confirm(posted ? "בדקתם בקבוצה והפוסט שם? הוא יסומן כפורסם." : "בדקתם בקבוצה והפוסט לא שם? הוא יסומן כלא פורסם (ולא יפורסם שוב).")) return;
    var reason = askReason("מה בדקתם?");
    if (!reason) return;
    btn.disabled = true;
    send("/attempts/" + encodeURIComponent(btn.dataset.key) + "/resolve", { outcome: btn.dataset.resolve, reason: reason })
      .then(function (d) { saved(d, "✅ נשמר"); return load(); })
      .catch(function (e) { btn.disabled = false; handleError(e, "הפעולה נכשלה"); if (e && e.code === "not_outcome_unknown") load(); });
  }
  function resumeOne(btn) {
    if (!window.confirm("התקלה תוקנה? הקמפיין ימשיך לפרסם.")) return;
    var reason = askReason("מה תוקן?");
    if (!reason) return;
    btn.disabled = true;
    send("/campaigns/" + encodeURIComponent(btn.dataset.resume) + "/resume", { reason: reason })
      .then(function (d) { saved(d, "✅ הקמפיין ממשיך"); return load(); })
      .catch(function (e) { btn.disabled = false; handleError(e, "הפעולה נכשלה"); });
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
  // Why each agent is or isn't posting (GET /status): the account's gates, each campaign's
  // state and wait reason, its next posts and its last attempts. Codes as the server names them.
  // A time, with its date when it is not today (a post moved to tomorrow reads as tomorrow).
  function hm(t) {
    if (!t) return "—";
    var d = new Date(t), time = d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString() ? time : d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" }) + " " + time;
  }
  function todayLine(t) {
    if (!t) return "";
    var limit = Math.min(t.cap, t.target);
    return "<br>היום: " + t.counted + "/" + limit + " (פורסמו " + t.posted + ", נכשלו " + t.failed + ", מתוכננים " + t.planned + ")" +
      " · יעד היום " + t.target + " · מגבלה " + t.cap +
      (t.warmup_stage ? " · שלב חימום: ימים " + t.warmup_stage.from_day + "–" + t.warmup_stage.to_day + ", עד " + t.warmup_stage.posts + " ביום" : "") +
      (t.counted >= limit ? " — <b>המכסה להיום מלאה</b>" : "");
  }
  function loadStatus() {
    $("#postingStatus").textContent = "טוען…";
    return FLY.req(API + "/status", { noRedirect: true }).then(function (d) {
      var gates = function (a) {
        var bad = [];
        if (!a.connected) bad.push("לא מחובר לפייסבוק");
        if (!a.permission) bad.push("אין הרשאת פרסום");
        if (a.paused_by_admin) bad.push("הושהה ע״י מנהל");
        if (a.disabled) bad.push("מושבת" + (a.disabled_class ? " (" + a.disabled_class + ")" : ""));
        if (a.needs_reconnect) bad.push("צריך להתחבר מחדש");
        if (a.penalty_until && new Date(a.penalty_until) > new Date()) bad.push("עונש עד " + hm(a.penalty_until));
        if (a.profile && a.profile !== "active") bad.push("פרופיל: " + a.profile);
        bad.push("חימום: " + a.warmup);
        return bad.join(" · ");
      };
      $("#postingStatus").innerHTML = (d.agents || []).length ? d.agents.map(function (g) {
        return "<div style=\"margin:8px 0;padding:8px;border:1px solid rgba(23,20,15,.12);border-radius:8px\"><b>…" + esc(g.phone_tail) + "</b> — " + esc(gates(g.account)) + todayLine(g.today) +
          g.campaigns.map(function (c) {
            return "<div style=\"margin-top:4px\">קמפיין …" + esc(c.id_tail) + ": " + esc(c.status) + (c.pause_reason ? " (" + esc(c.pause_reason) + ")" : "") +
              " · ממתין ל: " + esc(c.wait_reason || "—") +
              "<br>הבאים: " + (c.next.length ? c.next.map(function (p) { return esc(p.status) + " " + hm(p.due) + " " + esc(p.group || ""); }).join(" · ") : "אין") +
              "<br>ניסיונות אחרונים: " + (c.attempts.length ? c.attempts.map(function (a) { return esc(a.state || a.post) + (a.error_code ? " [" + esc(a.error_code) + "]" : "") + " " + hm(a.at); }).join(" · ") : "אין") +
              "</div>";
          }).join("") + "</div>";
      }).join("") : "אין סוכנים עם קמפיין פעיל או מושהה.";
    }).catch(function (e) { $("#postingStatus").textContent = ""; handleError(e, "שגיאה בטעינת המצב"); });
  }
  $("#postingStatusLoad").addEventListener("click", loadStatus);
  // A sweep now (what the server runs every minute): its result, and what each account's tick did.
  var SWEEP_RESULT = { ticked: "רץ", off: "כבוי", manual: "פרסום ידני", breaker: "מפסק הצי נפל", error: "שגיאה" };
  $("#postingSweepNow").addEventListener("click", function () {
    var btn = this; btn.disabled = true; $("#postingSweepOut").textContent = "מריץ…";
    send("/sweep", {}).then(function (d) {
      var l = d.last || {};
      $("#postingSweepOut").textContent = (d.running ? "הסבב עדיין רץ ברקע. " : "") +
        "תוצאה: " + (SWEEP_RESULT[l.result] || l.result || "—") + (l.reason ? " (" + l.reason + ")" : "") + (l.code ? " (" + l.code + ")" : "") +
        (l.accounts != null ? " · חשבונות: " + l.accounts : "") +
        ((d.accounts || []).length ? " · " + d.accounts.map(function (a) { return "…" + a.phone_tail + ": " + a.outcome; }).join(" · ") : "");
      saved(d, "✅ הסבב רץ");
      return loadStatus();
    }).catch(function (e) { $("#postingSweepOut").textContent = ""; handleError(e, "שגיאה בהרצת הסבב"); })
      .then(function () { btn.disabled = false; });
  });
  $("#postingCapsSave").addEventListener("click", function () { saveCaps(this); });
  $("#postingModesSave").addEventListener("click", function () { saveModes(this); });
  $("#postingTemplatesSave").addEventListener("click", function () { saveTemplates(this); });
  // The agents to pick from: the agents list (name · phone tail), as the campaigns tab shows it.
  FLY.req("/api/admin/campaigns/agents", { noRedirect: true }).then(function (d) {
    var agents = (d && d.agents) || [];
    $("#postingWarmAgent").innerHTML = '<option value="">בחרו סוכן…</option>' + agents.map(function (a) {
      return '<option value="' + esc(a.ref) + '">' + esc((a.name || "ללא שם") + " · …" + a.phone_tail) + "</option>";
    }).join("");
  }).catch(function () { $("#postingWarmAgent").innerHTML = '<option value="">רשימת הסוכנים לא נטענה</option>'; });
  // The picked agent's posts booked for later, now (each still checked by the rules when due).
  $("#postingReplan").addEventListener("click", function () {
    var btn = this, ref = $("#postingWarmAgent").value;
    if (!ref) { FLY.toast("בחרו סוכן"); return; }
    var reason = askReason("סיבה?");
    if (!reason) return;
    btn.disabled = true;
    send("/accounts/" + encodeURIComponent(ref) + "/replan", { reason: reason })
      .then(function (d) { saved(d, d.moved ? "✅ " + d.moved + " פוסטים הוקדמו לעכשיו — הריצו סבב" : "אין פוסטים מתוכננים לאחר כך"); return loadStatus(); })
      .catch(function (e) { handleError(e, "ההקדמה נכשלה"); })
      .then(function () { btn.disabled = false; });
  });
  $("#postingWarmSave").addEventListener("click", function () {
    var btn = this, ref = $("#postingWarmAgent").value;
    if (!ref) { FLY.toast("בחרו סוכן"); return; }
    var reason = askReason("סיבה?");
    if (!reason) return;
    btn.disabled = true;
    send("/accounts/" + encodeURIComponent(ref) + "/warmup", { mode: $("#postingWarmMode").value, reason: reason })
      .then(function (d) { saved(d, "✅ החימום נשמר"); })
      .catch(function (e) { handleError(e, e && e.status === 404 ? "לא נמצא חשבון מחובר למספר הזה" : "השמירה נכשלה"); })
      .then(function () { btn.disabled = false; });
  });
  $("#postingHalted").addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-posting-act]");
    if (btn) act(btn);
  });
  $("#postingUnknown").addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-resolve]");
    if (btn) resolveOne(btn);
  });
  $("#postingInternal").addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-resume]");
    if (btn) resumeOne(btn);
  });
})();
