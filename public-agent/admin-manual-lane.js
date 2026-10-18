/* Forly Admin Console — the semi-automatic run in the "פרסום ידני" tab
   (server: routes/admin-manual-lane.js). ▶ prepares the agent's next group
   (video, text, checks); a chime says it is ready; the admin clicks Post in
   Facebook and presses "הבא". "הבא" without a post asks why (a skip reason).
   One agent per browser tab: the admin opens several tabs to run several.
   The lane's state arrives on the viewer's event stream and on /state polls;
   the sound plays once per state, whichever brings it first.
   admin-manual.js calls attach / detach / onState; nothing else here knows it. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var esc = window.FLY ? FLY.esc : function (s) { return String(s); };
  var ctx = null, lane = null, lastKey = null, audio = null;
  var TITLE = document.title;

  var CODE = {
    not_member: "הסוכן לא חבר בקבוצה", composer_not_found: "לא נמצא חלון כתיבת פוסט",
    media_not_found: "לא הצלחנו לצרף את הסרטון", media_upload_failed: "העלאת הסרטון נכשלה", media_unavailable: "לא הצלחנו להביא את הסרטון", media_too_large: "הסרטון גדול מדי",
    prep_timeout: "ההכנה לקחה יותר מ-3 דקות", prep_error: "ההכנה נכשלה", no_viewer: "הדפדפן עוד נטען",
    identity_mismatch: "הפרופיל בדפדפן הוא לא של הסוכן", destination_mismatch: "זו לא הקבוצה הנכונה", copy_mismatch: "הטקסט לא הוקלד נכון",
    markers_missing: "לא הצלחנו לקרוא את דף הקבוצה", unreadable: "לא הצלחנו לקרוא את הדף",
  };
  var codeText = function (c) { return CODE[c] || "פייסבוק הציג הודעה (" + (c || "שגיאה") + ")"; };
  var REASONS = [["pending_overload", "כבר יש פוסטים ממתינים"], ["posting_method", "הקבוצה מפרסמת אחרת"], ["other", "אחר…"]];

  // ── sound: generated tones; the ▶ click is the gesture that unlocks audio ──
  function tones(list) {
    if (!audio) return;
    var t = audio.currentTime;
    list.forEach(function (n) {
      var o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = n[0]; o.type = "sine";
      g.gain.setValueAtTime(0.0001, t + n[1]); g.gain.exponentialRampToValueAtTime(0.3, t + n[1] + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + n[1] + n[2]);
      o.connect(g); g.connect(audio.destination); o.start(t + n[1]); o.stop(t + n[1] + n[2] + 0.05);
    });
  }
  var SOUND = { ready: [[880, 0, 0.25], [1320, 0.28, 0.35]], failed: [[220, 0, 0.6]], empty: [[660, 0, 0.2], [520, 0.22, 0.2], [440, 0.44, 0.4]] };

  function render(l) {
    lane = l;
    var box = $("#manualLane");
    if (!box) return;
    var st = l && l.state, g = l && l.item, name = g ? (g.group_name || (g.kind === "page" ? "הדף העסקי" : "קבוצה")) : "";
    box.classList.toggle("ready", st === "ready");
    box.classList.toggle("failed", st === "failed");
    var text = !l ? "לחצו ▶ כדי להכין את הקבוצה הבאה"
      : st === "loading" ? "מחפשים את הקבוצה הבאה…"
      : st === "preparing" ? "מכינים: " + name + " (סרטון וטקסט)…"
      : st === "ready" ? "🔔 מוכן: " + name + ". לחצו \"פרסום\" בפייסבוק ואז הבא"
      : st === "failed" ? "⚠ " + name + ": " + codeText(l.code) + ". ▶ = לנסות שוב, הבא = דילוג"
      : st === "held" ? name + ": למה לא פורסם?"
      : st === "blocked" ? "הקבוצות שנשארו חסומות כרגע במגבלה" + (l.until ? " (עד " + new Date(l.until).toLocaleString("he-IL") + ")" : "")
      : st === "empty" ? "אין עוד קבוצות לסוכן הזה ✓" : "";
    $("#manualLaneStatus").textContent = text + (l && l.left > 1 && ["preparing", "ready"].indexOf(st) >= 0 ? " · עוד " + (l.left - 1) + " אחריה" : "");
    $("#manualNext").disabled = !l || st === "loading";
    $("#manualRun").hidden = !!l && ["loading", "preparing", "ready", "held"].indexOf(st) >= 0; // shown on "failed": ▶ retries the same group
    var key = st + "|" + (g ? g.campaign_id + "|" + g.group_id : "");
    if (key !== lastKey) {
      lastKey = key;
      if (SOUND[st]) tones(SOUND[st]);
      document.title = st === "ready" ? "🔔 מוכן – " + (ctx && ctx.name || "") : st === "failed" ? "⚠ " + (ctx && ctx.name || "") : TITLE;
      if (st !== "held") ask(null);
    }
  }

  // The question under the buttons: a skip reason, or "did it go up?".
  function ask(kind) {
    var box = $("#manualLaneAsk");
    if (!box) return;
    box.hidden = !kind;
    if (!kind) { box.innerHTML = ""; return; }
    box.innerHTML = kind === "confirm"
      ? '<span>לא הצלחנו לראות את הפוסט. פורסם?</span><button type="button" class="btn btn-gold btn-sm" data-lane="posted">כן, פורסם</button><button type="button" class="btn btn-ghost btn-sm" data-lane="no">לא, דילוג</button>'
      : "<span>דילוג. למה?</span>" + REASONS.map(function (r) { return '<button type="button" class="btn btn-ghost btn-sm" data-lane="reason" data-r="' + r[0] + '">' + esc(r[1]) + "</button>"; }).join("") +
        '<input type="text" class="manual-input" id="manualLaneNote" maxlength="200" placeholder="מה הבעיה? (3 תווים לפחות)" hidden>';
  }

  function next(body) {
    if (!ctx) return;
    $("#manualNext").disabled = true;
    ctx.call("POST", ctx.path + "/next", body || {}).then(function (r) {
      render(r.lane);
      if (r.need) ask(r.need);
      if (r.recorded) { FLY.toast(r.recorded === "posted" ? (r.completed ? "פורסם ✓ הקמפיין הושלם" : "פורסם ✓") : "דולג"); if (ctx.onRecorded) ctx.onRecorded(); }
    }).catch(function (e) { $("#manualNext").disabled = false; FLY.toast(e && e.code === "invalid_input" ? "כתבו מה הבעיה (3 תווים לפחות)" : "הפעולה נכשלה"); });
  }

  // ── wiring ──
  var run = $("#manualRun"), nx = $("#manualNext"), askBox = $("#manualLaneAsk");
  if (!run || !nx || !askBox) return;
  run.addEventListener("click", function () {
    if (!ctx) return;
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === "suspended") audio.resume(); } catch (e) { audio = null; }
    ctx.call("POST", ctx.path + "/run").then(function (r) { render(r.lane); }).catch(function () { FLY.toast("ההפעלה נכשלה"); });
  });
  nx.addEventListener("click", function () { next({}); });
  askBox.addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-lane]");
    if (!b) return;
    var act = b.dataset.lane;
    if (act === "posted") return next({ posted: true });
    if (act === "no") return ask("reason");
    var note = $("#manualLaneNote");
    if (b.dataset.r === "other" && note.hidden) { note.hidden = false; note.focus(); return; }
    next({ reason: b.dataset.r, note: b.dataset.r === "other" ? note.value : undefined });
  });

  // ── the global list of skipped groups ──
  var flags = $("#manualFlags");
  if (flags) flags.addEventListener("toggle", function () {
    if (!flags.open) return;
    var R = { pending_overload: "פוסטים ממתינים", posting_method: "מפרסמת אחרת", other: "אחר", prep_failed: "ההכנה נכשלה" };
    fetch("/api/admin/manual/flags", { credentials: "include" }).then(function (r) { return r.json(); }).then(function (j) {
      var rows = j.flags || [];
      $("#manualFlagsList").innerHTML = !rows.length ? '<p class="manual-muted">אין קבוצות מסומנות.</p>'
        : '<ul class="manual-groups">' + rows.map(function (f) {
          var last = (f.recent || [])[0];
          return "<li><b>" + esc(f.name || f.group_id) + "</b>" + (f.url ? ' <a href="' + esc(f.url) + '" target="_blank" rel="noopener">↗</a>' : "") +
            ' <span class="manual-chip skipped">' + esc(f.total) + " דילוגים</span> " +
            Object.keys(f.counts || {}).map(function (k) { return '<span class="manual-muted">' + esc(R[k] || k) + ": " + esc(f.counts[k]) + "</span>"; }).join(" · ") +
            (last && last.note ? ' <span class="manual-muted">· "' + esc(last.note) + '"</span>' : "") + "</li>";
        }).join("") + "</ul>";
    }).catch(function () { $("#manualFlagsList").innerHTML = '<p class="manual-muted">הטעינה נכשלה.</p>'; });
  });

  window.ForlyManualLane = {
    // c: { call, path: "/agents/<ref>/browser", name, onRecorded }
    attach: function (c) { ctx = c; lastKey = null; $("#manualLane").hidden = false; render(null); },
    detach: function () { ctx = null; lane = null; lastKey = null; $("#manualLane").hidden = true; ask(null); document.title = TITLE; },
    onState: function (l) { if (ctx && l !== undefined) render(l); },
    active: function () { return !!(ctx && lane && ["loading", "preparing", "ready", "held", "failed"].indexOf(lane.state) >= 0); },
  };
})();
