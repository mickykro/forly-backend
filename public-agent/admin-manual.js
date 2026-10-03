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
  var detail = null, detailFor = null; // the session property in full: its groups and every text version
  var texts = [];                      // what the type/copy buttons in the detail panel refer to, by index

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

  // ── the session property in full: the agent's groups and every text version ──
  var STATUS = { owed: "לפרסום", posted: "פורסם ✓", skipped: "דולג" };
  function renderDetail() {
    var box = $("#manualDetail");
    if (!shown || !detail) { box.innerHTML = ""; return; }
    texts = [];
    var tx = function (t) { texts.push(t); return texts.length - 1; };
    var btns = function (i) {
      return '<button type="button" class="btn btn-ghost btn-sm" data-dt="type" data-i="' + i + '">הקלדה בדפדפן</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-dt="copy" data-i="' + i + '">העתקה</button>';
    };
    var c = detail.campaign;
    var groups = detail.groups.length ? '<ul class="manual-groups">' + detail.groups.map(function (g) {
      var tickable = g.status === "owed" && c && c.status === "running";
      return '<li><label class="name"><input type="checkbox" data-gid="' + esc(g.group_id) + '"' + (g.status === "posted" ? " checked" : "") + (tickable ? "" : " disabled") + "> " +
        "<b>" + esc(g.name || "קבוצה") + '</b></label> <a href="' + esc(g.url) + '" target="_blank" rel="noopener">↗</a>' +
        '<span class="manual-chip ' + esc(g.status) + '">' + STATUS[g.status] + "</span>" +
        '<button type="button" class="btn btn-ghost btn-sm" data-dt="goto" data-url="' + esc(g.url) + '">פתיחה בדפדפן</button>' +
        (g.copy ? btns(tx(g.copy)).replace("הקלדה בדפדפן", "הקלדת הטקסט שאושר") : "") +
        "</li>";
    }).join("") + "</ul>" +
      (c && c.status === "running" ? '<button type="button" class="btn btn-gold btn-sm" data-dt="tick">סימון הקבוצות המסומנות כ"פורסם"</button>' : "")
      : '<p class="manual-muted">לנכס הזה אין קבוצות שהסוכן בחר.</p>';
    var versions = '<div class="manual-versions">' + detail.versions.map(function (t, n) {
      return "<details" + (n === 0 ? " open" : "") + "><summary>גרסה " + (n + 1) + ": " + esc(t.split("\n")[0]) + '</summary><pre dir="auto">' + esc(t) + '</pre><div class="manual-row">' + btns(tx(t)) + "</div></details>";
    }).join("") + "</div>";
    box.innerHTML = '<div class="manual-detail"><h3 class="manual-h">הקבוצות שהסוכן בחר (' + detail.groups.length + ")" +
      (c ? ' <small class="manual-muted">קמפיין: ' + esc(c.status) + "</small>" : "") + "</h3>" + groups +
      '<h3 class="manual-h">כל גרסאות הטקסט (' + detail.versions.length + ")</h3>" + versions + "</div>";
  }
  function loadDetail(pageId) {
    if (!shown || !pageId) { detail = null; detailFor = null; renderDetail(); return; }
    detailFor = pageId;
    call("GET", "/agents/" + encodeURIComponent(shown) + "/properties/" + encodeURIComponent(pageId))
      .then(function (j) { if (detailFor === pageId) { detail = j; renderDetail(); } })
      .catch(function (e) {
        $("#manualDetail").innerHTML = '<p class="manual-muted">לא הצלחנו לטעון את הקבוצות והטקסטים של הנכס (' + esc((e && (e.code || e.status)) || "שגיאה") + '). <button type="button" class="btn btn-ghost btn-sm" data-dt="retry">נסו שוב</button></p>';
      });
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
    // The options are rebuilt only when the list changes: redrawing them on
    // every poll closed the dropdown while it was open.
    var pick = $("#manualPropPick"), list = JSON.stringify(props.map(function (x) { return x.page_id; }));
    pick.hidden = !shown;
    if (pick.dataset.list !== list) {
      pick.dataset.list = list;
      pick.innerHTML = '<option value="">החלפת נכס…</option>' + props.map(function (x) {
        return '<option value="' + esc(x.page_id) + '">' + esc(x.title) + (x.address ? ", " + esc(x.address) : "") + "</option>";
      }).join("");
    }
    if (document.activeElement !== pick) pick.value = (p && p.page_id) || "";
    var v = $("#manualVideo"), ready = !!(state && state.chooser_open);
    v.disabled = !(p && p.video_url);
    v.classList.toggle("ready", ready);
    v.textContent = ready ? "חלון בחירת קובץ פתוח: העלאת הסרטון" : "לחצו \"תמונה/סרטון\" בפייסבוק, ואז כאן";
    $("#manualClose").hidden = !shown;
  }

  function refresh() {
    if (!shown) return;
    call("GET", B(shown) + "/state").then(function (s) {
      state = s; renderSide();
      var pid = s.property && s.property.page_id;
      if ((pid || null) !== detailFor) loadDetail(pid);
    })
      .catch(function (e) { if (e && e.status === 409) closed(); });
  }
  function closed() {
    clearInterval(poll); poll = null;
    if (viewer) viewer.unmount();
    viewer = null; shown = null; state = null; props = []; detail = null; detailFor = null;
    renderDetail();
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
    return call("POST", B(shown) + "/property", { page_id: pageId }).then(function (j) { state = Object.assign({}, state, { property: j.property }); renderSide(); loadDetail(pageId); });
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

  $("#manualDetail").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-dt]");
    if (!b || !shown) return;
    var act = b.dataset.dt, t = texts[Number(b.dataset.i)];
    if (act === "retry") { loadDetail(detailFor); return; }
    if (act === "tick") {
      // Every group the poster ticked: marked posted one by one. A mark cannot be undone, so ask first.
      var ids = [].slice.call($("#manualDetail").querySelectorAll("input[data-gid]:checked:not(:disabled)")).map(function (i) { return i.dataset.gid; });
      if (!ids.length) { FLY.toast("סמנו את הקבוצות שבהן פרסמתם"); return; }
      if (!confirm("לסמן " + ids.length + " קבוצות כ\"פורסם\"? אי אפשר לבטל.")) return;
      b.disabled = true;
      var cid = detail.campaign.id, last = null;
      ids.reduce(function (p, gid) {
        return p.then(function () { return call("POST", "/campaigns/" + encodeURIComponent(cid) + "/groups/" + encodeURIComponent(gid) + "/done", { status: "posted" }).then(function (j) { last = j; }); });
      }, Promise.resolve())
        .then(function () { FLY.toast(last && last.completed ? "הקמפיין הושלם, הסוכן קיבל הודעה" : "סומנו " + ids.length + " קבוצות ✓"); })
        .catch(fail).then(function () { b.disabled = false; loadDetail(detailFor); load(); });
      return;
    }
    if (act === "copy") { navigator.clipboard.writeText(t).then(function () { FLY.toast("הטקסט הועתק"); }, function () { FLY.toast("ההעתקה נכשלה"); }); return; }
    b.disabled = true;
    var req = act === "type" ? call("POST", B(shown) + "/type", { text: t })
      : call("POST", B(shown) + "/goto", { group_url: b.dataset.url });
    req.then(function () { FLY.toast(act === "type" ? "הטקסט הוקלד" : "הקבוצה נפתחה"); }).catch(fail).then(function () { b.disabled = false; });
  });
  $("#manualBig").addEventListener("click", function () {
    var big = $(".manual-grid").classList.toggle("big");
    this.textContent = big ? "⤡ הקטנה" : "⤢ הגדלה";
  });
  $("#manualFull").addEventListener("click", function () {
    var el = $("#manualBrowser");
    if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen().catch(function () { FLY.toast("מסך מלא לא זמין בדפדפן הזה"); });
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
        .then(function (j) { FLY.toast(j.completed ? "הקמפיין הושלם, הסוכן קיבל הודעה" : "סומן ✓"); if (picked === b.dataset.k) picked = null; if (detailFor) loadDetail(detailFor); return load(); })
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
