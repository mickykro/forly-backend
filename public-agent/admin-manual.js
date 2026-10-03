/* Forly Admin Console — the "פרסום ידני" tab (posting-manual, launch 4 Oct 2026).
   The posts agents approved, next to a live browser on the agent's own
   Facebook profile. The admin drives it; buttons only do the tedious parts:
   open the group, type the approved text, and put the property's video into
   Facebook's file chooser the moment it opens. The admin clicks Post in
   Facebook and ticks the group; the last tick sends the agent one WhatsApp.
   Agents are addressed by an opaque ref, never a phone. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var esc = FLY.esc;
  var API = "/api/admin/manual";
  var agents = [], items = [], props = [];
  var shown = null;      // the ref whose browser is on screen
  var picked = null;     // "campaign_id|group_id" of the queue item being worked on
  var state = null, viewer = null, poll = null;

  var ERR = {
    profile_busy: "הפרופיל של הסוכן תפוס כרגע (פרסום אוטומטי או התחברות). נסו שוב בעוד דקה.",
    facebook_not_connected: "הסוכן עוד לא חיבר את פייסבוק.",
    browser_unavailable: "הדפדפן לא נפתח. נסו שוב.",
    no_open_browser: "קודם פתחו את הפייסבוק של הסוכן.",
    no_viewer: "הדפדפן עוד נטען. נסו שוב בעוד רגע.",
    chooser_not_open: "קודם לחצו בפייסבוק על \"תמונה/סרטון\", ואז על העלאת הסרטון.",
    no_property: "קודם בחרו איזה נכס משתפים.",
    no_video: "לנכס הזה אין סרטון.",
    media_unavailable: "לא הצלחנו להביא את הסרטון של הנכס.",
    not_found: "לא נמצא. אולי הקבוצה כבר סומנה או שהקמפיין הסתיים.",
    invalid_input: "הבקשה לא תקינה.",
  };
  var fail = function (e) { FLY.toast(ERR[e && e.code] || "הפעולה נכשלה"); };
  function call(method, path, body) {
    return fetch(API + path, { method: method, credentials: "include", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw Object.assign(new Error(j.error || String(r.status)), { code: j.error, status: r.status });
          return j;
        });
      });
  }
  var B = function (ref) { return "/agents/" + encodeURIComponent(ref) + "/browser"; };
  var price = function (n) { return n ? Number(n).toLocaleString("en-US") + " ש\"ח" : ""; };
  var itemOf = function (k) { return items.filter(function (i) { return i.campaign_id + "|" + i.group_id === k; })[0] || null; };

  // ── the work column ──
  function renderAgents() {
    var sel = $("#manualAgent"), cur = sel.value;
    sel.innerHTML = '<option value="">בחרו סוכן…</option>' + agents.map(function (a) {
      return '<option value="' + esc(a.ref) + '">' + esc(a.name || "סוכן") + " " + esc(a.phone_tail) + (a.owed ? " (" + a.owed + " לפרסום)" : "") + "</option>";
    }).join("");
    sel.value = cur || shown || "";
  }

  function renderQueue() {
    var byRef = {};
    items.forEach(function (i) { (byRef[i.ref] = byRef[i.ref] || []).push(i); });
    var refs = Object.keys(byRef);
    $("#manualQueue").innerHTML = !refs.length ? '<p class="manual-muted">אין כרגע פוסטים לפרסום.</p>' : refs.map(function (ref) {
      var list = byRef[ref], byProp = {};
      list.forEach(function (i) { (byProp[i.page_id] = byProp[i.page_id] || []).push(i); });
      return '<div class="manual-agent"><h3>' + esc(list[0].agent_name || "סוכן") + ' <small class="manual-muted">' + esc(list[0].phone_tail) + "</small></h3>" +
        Object.keys(byProp).map(function (pid) {
          var ps = byProp[pid];
          return '<div class="manual-muted">🏠 <a href="' + esc(ps[0].page_url) + '" target="_blank" rel="noopener">' + esc(ps[0].title) + "</a></div>" +
            ps.map(function (i) {
              var k = esc(i.campaign_id + "|" + i.group_id), on = picked === i.campaign_id + "|" + i.group_id;
              return '<div class="manual-item' + (on ? " on" : "") + '"><b>' + esc(i.group_name || "קבוצה") + "</b> " +
                '<a href="' + esc(i.group_url) + '" target="_blank" rel="noopener">↗</a>' +
                '<pre dir="auto">' + esc(i.copy) + '</pre><div class="manual-row">' +
                '<button type="button" class="btn btn-gold btn-sm" data-act="pick" data-k="' + k + '">בחירה</button>' +
                '<button type="button" class="btn btn-ghost btn-sm" data-act="goto" data-k="' + k + '">1. פתיחת הקבוצה</button>' +
                '<button type="button" class="btn btn-ghost btn-sm" data-act="type" data-k="' + k + '">2. הקלדת הטקסט</button>' +
                '<button type="button" class="btn btn-ghost btn-sm" data-act="copy" data-k="' + k + '">העתקה</button>' +
                '<button type="button" class="btn btn-gold btn-sm" data-act="posted" data-k="' + k + '">פורסם ✓</button>' +
                '<button type="button" class="btn btn-ghost btn-sm" data-act="skipped" data-k="' + k + '">דילוג</button></div></div>';
            }).join("");
        }).join("") + "</div>";
    }).join("");
  }

  function load() {
    return Promise.all([call("GET", "/agents"), call("GET", "/queue")]).then(function (r) {
      agents = r[0].agents || []; items = r[1].items || [];
      renderAgents(); renderQueue();
    }).catch(fail);
  }

  // ── the browser column ──
  function renderSide() {
    var p = state && state.property;
    $("#manualProp").innerHTML = !shown ? '<p class="manual-muted">אין דפדפן פתוח.</p>'
      : !p ? '<p class="manual-muted">איזה נכס משתפים? בחרו פוסט מהרשימה, או נכס מהרשימה למטה.</p>'
      : (p.poster_url ? '<img src="' + esc(p.poster_url) + '" alt="">' : "") +
        '<div><b>משתפים: ' + esc(p.title) + "</b>" + esc(p.address) +
        '<div class="manual-muted">' + [p.rooms ? p.rooms + " חדרים" : "", p.size_sqm ? p.size_sqm + " מ\"ר" : "", p.floor ? "קומה " + p.floor : "", price(p.price)].filter(Boolean).map(esc).join(", ") + "</div>" +
        '<a href="' + esc(p.page_url) + '" target="_blank" rel="noopener">דף הנכס ↗</a>' + (p.video_url ? "" : ' <span class="manual-muted">(אין סרטון)</span>') + "</div>";
    var pick = $("#manualPropPick");
    pick.hidden = !shown;
    pick.innerHTML = '<option value="">החלפת נכס…</option>' + props.map(function (x) {
      return '<option value="' + esc(x.page_id) + '"' + (p && p.page_id === x.page_id ? " selected" : "") + ">" + esc(x.title) + (x.address ? ", " + esc(x.address) : "") + "</option>";
    }).join("");
    var v = $("#manualVideo"), ready = !!(state && state.chooser_open);
    v.disabled = !(p && p.video_url);
    v.classList.toggle("ready", ready);
    v.textContent = ready ? "חלון בחירת קובץ פתוח: העלאת הסרטון" : "לחצו \"תמונה/סרטון\" בפייסבוק, ואז כאן";
    $("#manualClose").hidden = !shown;
  }

  function refresh() {
    if (!shown) return;
    call("GET", B(shown) + "/state").then(function (s) { state = s; renderSide(); })
      .catch(function (e) { if (e && e.status === 409) closed(); });
  }
  function closed() {
    clearInterval(poll); poll = null;
    if (viewer) viewer.unmount();
    viewer = null; shown = null; state = null; props = [];
    $("#manualBrowser").innerHTML = "";
    renderSide(); load();
  }

  // Opens (or reuses) the agent's browser and puts it on screen.
  function show(ref) {
    if (shown === ref && viewer) return Promise.resolve();
    return call("POST", B(ref)).then(function () {
      if (viewer) viewer.unmount();
      shown = ref; state = null;
      viewer = window.ForlyViewer.create($("#manualBrowser"), API + B(ref) + "/view", {
        onEnd: function (code) { if (code !== "closed") FLY.toast("הדפדפן נסגר"); },
      });
      clearInterval(poll);
      poll = setInterval(function () { if (document.visibilityState === "visible") refresh(); }, 1500);
      call("GET", "/agents/" + encodeURIComponent(ref) + "/properties").then(function (j) { props = j.properties || []; renderSide(); }).catch(function () {});
      $("#manualAgent").value = ref;
      renderSide(); refresh();
    });
  }
  var setProperty = function (pageId) {
    return call("POST", B(shown) + "/property", { page_id: pageId }).then(function (j) { state = Object.assign({}, state, { property: j.property }); renderSide(); });
  };

  // ── events ──
  $("#manualOpen").addEventListener("click", function () {
    var ref = $("#manualAgent").value, b = this;
    if (!ref) { FLY.toast("בחרו סוכן"); return; }
    b.disabled = true;
    show(ref).catch(fail).then(function () { b.disabled = false; });
  });
  $("#manualReload").addEventListener("click", load);
  $("#manualPropPick").addEventListener("change", function () { if (this.value) setProperty(this.value).catch(fail); });
  $("#manualClose").addEventListener("click", function () {
    if (!shown || !confirm("לסגור את הדפדפן של הסוכן?")) return;
    call("DELETE", B(shown)).catch(function () {}).then(closed);
  });
  $("#manualVideo").addEventListener("click", function () {
    var b = this;
    if (!shown) return;
    b.disabled = true;
    call("POST", B(shown) + "/video").then(function () { FLY.toast("הסרטון בדרך לפייסבוק. חכו שיסיים לעלות לפני הפרסום."); refresh(); })
      .catch(fail).then(function () { b.disabled = false; });
  });

  $("#manualQueue").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-act]");
    if (!b) return;
    var item = itemOf(b.dataset.k), act = b.dataset.act;
    if (!item) return;
    if (act === "copy") {
      navigator.clipboard.writeText(item.copy).then(function () { FLY.toast("הטקסט הועתק"); }, function () { FLY.toast("ההעתקה נכשלה"); });
      return;
    }
    if (act === "posted" || act === "skipped") {
      if (act === "skipped" && !confirm("לדלג על הקבוצה הזו? היא לא תופיע בהודעה לסוכן.")) return;
      b.disabled = true;
      call("POST", "/campaigns/" + encodeURIComponent(item.campaign_id) + "/groups/" + encodeURIComponent(item.group_id) + "/done", { status: act })
        .then(function (j) { FLY.toast(j.completed ? "הקמפיין הושלם, הסוכן קיבל הודעה" : "סומן ✓"); if (picked === b.dataset.k) picked = null; return load(); })
        .catch(function (e) { b.disabled = false; fail(e); });
      return;
    }
    b.disabled = true;
    var done = function () { b.disabled = false; };
    if (act === "pick") {
      show(item.ref).then(function () { return setProperty(item.page_id); })
        .then(function () { picked = b.dataset.k; renderQueue(); }).catch(fail).then(done);
      return;
    }
    if (shown !== item.ref) { done(); FLY.toast("קודם לחצו \"בחירה\" על הפוסט הזה"); return; }
    var req = act === "goto" ? call("POST", B(shown) + "/goto", { group_url: item.group_url })
      : call("POST", B(shown) + "/type", { text: item.copy });
    req.then(function () { FLY.toast(act === "goto" ? "הקבוצה נפתחה" : "הטקסט הוקלד"); }).catch(fail).then(done);
  });

  // ── tab wiring (like admin-posting.js) ──
  var tab = $("#tabManual"), pane = $("#paneManual");
  if (!tab || !pane) return;
  tab.addEventListener("click", function () {
    document.querySelectorAll(".tabs button").forEach(function (b) { b.classList.toggle("on", b === tab); });
    document.querySelectorAll("#viewAdmin [id^='pane']").forEach(function (p) { p.classList.toggle("hidden", p !== pane); });
    load();
  });
  document.querySelectorAll(".tabs button").forEach(function (b) {
    if (b !== tab) b.addEventListener("click", function () { tab.classList.remove("on"); pane.classList.add("hidden"); });
  });
  renderSide();
})();
