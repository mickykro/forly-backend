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
  var agents = [], campaigns = [], props = [];
  var shown = null;      // the ref whose browser is on screen
  var picked = null;     // "campaign_id|group_id" of the queue item being worked on
  var state = null, viewer = null, poll = null;
  var detail = null, detailFor = null; // the session property in full: its groups and every text version
  var texts = [];                      // what the type/copy buttons in the detail panel refer to, by index
  var Lane = window.ForlyManualLane || null; // the semi-automatic run (admin-manual-lane.js)
  var opened = {};                     // campaign_id → expanded in the checklist (collapsed by default)
  var here = null;                     // the group open in the browser { ref, group_id, group_name }: stays after its tick

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
    driver_busy: "הדפדפנים תפוסים כרגע. נסו שוב בעוד דקה.",
    cannot_verify_login: "לא הצלחנו לוודא את ההתחברות. נסו שוב בעוד רגע.",
    verify_failed: "הבדיקה נכשלה. נסו שוב.",
    browser_open: "הדפדפן של הסוכן פתוח. סגרו אותו ואז שמרו את הפרופיל.",
    profile_revoked: "החיבור של הסוכן בוטל — הוא צריך להתחבר מחדש.",
    invalid_profile_name: "שם הפרופיל לא תקין. העתיקו אותו בדיוק מ-Driver (מתחיל ב-facebook-).",
  };
  var LIMIT = { group_daily_cap: "כבר 3 פוסטים של הסוכן בקבוצה הזו היום", property_cooldown: "הנכס פורסם בקבוצה הזו לאחרונה — לא לפני המועד" }; // the interval is the campaign's (3 days, or its repeat)
  var limitText = function (l) { return l.block ? (LIMIT[l.block.why] || "הקבוצה הגיעה למגבלה") + (l.block.until ? " (עד " + when(l.block.until) + ")" : "") : ""; };
  var fail = function (e) { FLY.toast(ERR[e && e.code] || "הפעולה נכשלה"); };
  function call(method, path, body) {
    return fetch(API + path, { method: method, credentials: "include", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw Object.assign(new Error(j.error || String(r.status)), { code: j.error, status: r.status, why: j.why, until: j.until });
          return j;
        });
      });
  }
  // "posted" on a group at its limit: the server says why; the admin may go ahead with a reason (audited).
  // Resolves null when the admin cancels.
  function markPosted(cid, gid) {
    var path = "/campaigns/" + encodeURIComponent(cid) + "/groups/" + encodeURIComponent(gid) + "/done";
    return call("POST", path, { status: "posted" }).catch(function (e) {
      if (!e || e.code !== "group_limit") throw e;
      var r = window.prompt((LIMIT[e.why] || "הקבוצה הגיעה למגבלה") + ". לסמן בכל זאת? כתבו סיבה:");
      if (!r || r.trim().length < 3) { FLY.toast("בוטל"); return null; }
      return call("POST", path, { status: "posted", override_reason: r.trim() });
    });
  }
  var B = function (ref) { return "/agents/" + encodeURIComponent(ref) + "/browser"; };
  var price = function (n) { return n ? Number(n).toLocaleString("en-US") + " ש\"ח" : ""; };
  // A checklist row by its key "campaign_id|group_id": its campaign's head and the group.
  var itemOf = function (k) {
    for (var n = 0; n < campaigns.length; n++) {
      var c = campaigns[n];
      for (var m = 0; m < c.groups.length; m++) {
        var g = c.groups[m];
        if (c.campaign_id + "|" + g.group_id === k) return { ref: c.ref, campaign_id: c.campaign_id, page_id: c.page_id, group_id: g.group_id, group_name: g.name, group_url: g.url, copy: g.copy, status: g.status };
      }
    }
    return null;
  };

  // ── the work column ──
  function renderAgents() {
    var sel = $("#manualAgent"), cur = sel.value;
    sel.innerHTML = '<option value="">בחרו סוכן…</option>' + agents.map(function (a) {
      return '<option value="' + esc(a.ref) + '">' + esc(a.name || "סוכן") + " " + esc(a.phone_tail) + (a.owed ? " (" + a.owed + " לפרסום)" : "") + "</option>";
    }).join("");
    sel.value = cur || shown || "";
    renderProfile();
  }

  // The Driver profile the agent's browser opens: saved on the agent, or (not
  // saved yet) the name this server computes. Pasting the name from Driver and
  // saving attaches that profile to the agent before the browser is opened.
  function renderProfile() {
    var a = agents.filter(function (x) { return x.ref === $("#manualAgent").value; })[0];
    $("#manualProfile").value = a ? (a.profile_name || "") : "";
    $("#manualProfile").disabled = $("#manualProfileSave").disabled = !a;
    $("#manualProfileState").textContent = !a ? "" : a.profile_saved ? "פרופיל שמור לסוכן" : "לא נשמר פרופיל — זה השם המחושב";
  }

  // The checklist: per agent, per property, every group the agent asked for.
  // A tick marks it posted; the property is done when no group is owed.
  var STATE = { owed: "לפרסום", posted: "פורסם ✓", skipped: "דולג" };
  var when = function (iso) { var d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }); };
  var postedOf = function (c) { return c.groups.filter(function (g) { return g.status === "posted"; }).length; };
  function renderQueue() {
    // An agent chosen in the dropdown: only theirs (no browser needed).
    var only = $("#manualAgent").value;
    var list0 = only ? campaigns.filter(function (c) { return c.ref === only; }) : campaigns;
    var byRef = {}, total = 0, done = 0;
    list0.forEach(function (c) {
      (byRef[c.ref] = byRef[c.ref] || []).push(c);
      c.groups.forEach(function (g) { total++; if (g.status !== "owed") done++; });
    });
    var refs = Object.keys(byRef);
    $("#manualSummary").textContent = list0.length
      ? list0.length + " נכסים בפרסום · " + done + " מתוך " + total + " קבוצות טופלו" : "";
    $("#manualQueue").innerHTML = !refs.length ? '<p class="manual-muted">' + (only ? "לסוכן הזה אין נכסים בפרסום." : "אין כרגע נכסים לפרסום.") + "</p>" : refs.map(function (ref) {
      var list = byRef[ref];
      return '<div class="manual-agent"><h3>' + esc(list[0].agent_name || "סוכן") + ' <small class="manual-muted">' + esc(list[0].phone_tail) + "</small></h3>" +
        // Least-posted property first, so the ones still waiting are on top.
        list.slice().sort(function (a, b) { return postedOf(a) - postedOf(b); }).map(function (c) {
          var n = c.groups.length, d = c.groups.filter(function (g) { return g.status !== "owed"; }).length;
          var up = c.groups.filter(function (g) { return g.status === "posted"; });
          var open = opened[c.campaign_id] || (picked && picked.indexOf(c.campaign_id + "|") === 0);
          return '<details class="manual-check" data-cid="' + esc(c.campaign_id) + '"' + (open ? " open" : "") + ">" +
            '<summary class="manual-check-head">🏠 <a href="' + esc(c.page_url) + '" target="_blank" rel="noopener">' + esc(c.title) + "</a>" +
            '<span class="manual-chip ' + (d === n ? "posted" : "owed") + '">' + d + "/" + n + "</span>" +
            (c.awaiting_agent ? ' <span class="manual-chip owed">הסוכן עוד לא אישר את הטקסט</span>' : "") + "</summary>" +
            '<div class="manual-bar"><i style="width:' + (n ? Math.round((d / n) * 100) : 0) + '%"></i></div>' +
            '<div class="manual-muted">' + (up.length ? "עלה ל-" + up.length + " קבוצות: " + up.map(function (g) { return esc(g.name || "קבוצה"); }).join(", ") : "עוד לא עלה לאף קבוצה") + "</div>" +
            '<ul class="manual-groups">' + c.groups.map(function (g) {
              var k = esc(c.campaign_id + "|" + g.group_id), on = picked === c.campaign_id + "|" + g.group_id, owed = g.status === "owed";
              return '<li class="' + (on ? "on" : "") + '"><label class="name"><input type="checkbox" data-act="check" data-k="' + k + '"' +
                (g.status === "posted" ? " checked" : "") + (owed ? "" : " disabled") + "> <b>" + (g.kind === "page" ? "📄 " : "") + esc(g.name || (g.kind === "page" ? "הדף העסקי" : "קבוצה")) + "</b></label>" +
                '<span class="manual-chip ' + esc(g.status) + '">' + STATE[g.status] + (g.posted_at ? " " + esc(when(g.posted_at)) : "") + "</span>" +
                (owed && g.limit ? '<span class="manual-chip ' + (g.limit.block ? "skipped" : "owed") + '">' + esc(g.limit.today) + "/" + esc(g.limit.cap) + " היום</span>" +
                  (g.limit.block ? ' <span class="manual-muted">' + esc(limitText(g.limit)) + "</span>" : "") : "") +
                (owed ? '<button type="button" class="btn btn-gold btn-sm" data-act="open" data-k="' + k + '">' + (g.kind === "page" ? "פתיחה בדף העסקי" : "פתיחה בקבוצה") + "</button>" +
                  '<button type="button" class="btn btn-ghost btn-sm" data-act="type" data-k="' + k + '">הקלדת הטקסט</button>' +
                  '<button type="button" class="btn btn-ghost btn-sm" data-act="copy" data-k="' + k + '">העתקה</button>' +
                  '<button type="button" class="btn btn-ghost btn-sm" data-act="skipped" data-k="' + k + '">דילוג</button>' : "") +
                '<a href="' + esc(g.url) + '" target="_blank" rel="noopener" title="פתיחה בדפדפן שלכם">↗</a>' +
                (owed && g.copy ? '<details class="manual-text"' + (on ? " open" : "") + '><summary>הטקסט</summary><pre dir="auto">' + esc(g.copy) + "</pre></details>" : "") +
                "</li>";
            }).join("") + "</ul></details>";
        }).join("") + "</div>";
    }).join("");
    renderAlso();
  }

  // The group on screen also suits the agent's other properties (same group,
  // still owed there): offer them, one click posts that property here next.
  // Keyed on the group in the browser, not the picked row: ticking a row keeps the offers.
  function alsoHere() {
    var cur = here, p = picked && itemOf(picked);
    if (!cur) return [];
    return campaigns.filter(function (c) {
      return c.ref === cur.ref && !(p && c.campaign_id === p.campaign_id) &&
        c.groups.some(function (g) { return g.group_id === cur.group_id && g.status === "owed"; });
    }).sort(function (a, b) { return postedOf(a) - postedOf(b); });
  }
  function renderAlso() {
    var list = alsoHere(), cur = here;
    $("#manualAlso").innerHTML = !list.length ? "" :
      '<div class="manual-detail"><b>הקבוצה "' + esc(cur.group_name || "") + '" מתאימה גם ל:</b><div class="manual-row">' +
      list.map(function (c) {
        return '<button type="button" class="btn btn-ghost btn-sm" data-also="' + esc(c.campaign_id + "|" + cur.group_id) + '">🏠 ' + esc(c.title) + "</button>";
      }).join("") + "</div></div>";
  }

  // Leaving the group being worked on (another group or property): first ask
  // whether the post went up, and mark it if so. Resolves false to stay put.
  function leavePicked(next) {
    var cur = picked && picked !== next && itemOf(picked);
    if (!cur || cur.status !== "owed") return Promise.resolve(true);
    var title = (campaigns.filter(function (c) { return c.campaign_id === cur.campaign_id; })[0] || {}).title || "";
    return askPosted(title, cur.group_name || "").then(function (a) {
      if (a === "editing") return false;                    // still working on it: stay on this group
      if (a === "failed") { picked = null; return true; }   // could not post: move on, nothing marked
      return markPosted(cur.campaign_id, cur.group_id).then(function (j) {
        if (!j) return false; // a limit override the admin cancelled: stay on this group
        FLY.toast(j.completed ? "הנכס פורסם בכל הקבוצות, הסוכן קיבל הודעה" : "סומן ✓");
        picked = null;
        return load().then(function () { return true; });
      });
    });
  }
  // → "posted" | "failed" | "editing" (also Esc: closing the dialog never moves on).
  function askPosted(title, group) {
    var dlg = $("#manualAsk");
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.id = "manualAsk"; dlg.dir = "rtl";
      dlg.style.cssText = "max-width:420px;border:1px solid rgba(23,20,15,.15);border-radius:14px;padding:20px;font:inherit";
      document.body.appendChild(dlg);
    }
    dlg.innerHTML = '<p style="margin:0 0 14px">לפני שעוברים: הפוסט של <b>' + esc(title) + "</b> בקבוצה <b>" + esc(group) + "</b> פורסם?</p>" +
      '<div class="manual-row">' +
      '<button type="button" class="btn btn-gold btn-sm" data-ans="posted">פורסם ✓</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-ans="failed">לא הצלחתי לפרסם</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-ans="editing">עוד עורך/ת</button></div>';
    return new Promise(function (resolve) {
      var done = function (a) { dlg.onclick = dlg.oncancel = null; if (dlg.open) dlg.close(); resolve(a); };
      dlg.onclick = function (ev) { var b = ev.target.closest("[data-ans]"); if (b) done(b.dataset.ans); };
      dlg.oncancel = function (ev) { ev.preventDefault(); done("editing"); };
      dlg.showModal();
    });
  }

  function load() {
    return Promise.all([call("GET", "/agents"), call("GET", "/queue")]).then(function (r) {
      agents = r[0].agents || []; campaigns = r[1].campaigns || [];
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
      if (Lane) Lane.onState(s.lane);
      var pid = s.property && s.property.page_id;
      if ((pid || null) !== detailFor) loadDetail(pid);
    })
      .catch(function (e) { if (e && e.status === 409) closed(); });
  }
  function closed() {
    clearInterval(poll); poll = null;
    if (Lane) Lane.detach();
    if (viewer) viewer.unmount();
    viewer = null; shown = null; state = null; props = []; detail = null; detailFor = null; here = null;
    renderDetail();
    $("#manualBrowser").innerHTML = "";
    renderSide(); load();
  }

  // Opens (or reuses) the agent's browser and puts it on screen.
  // groupUrl (optional): a browser not yet open starts on that group. → { at_group }.
  function show(ref, groupUrl) {
    if (shown === ref && viewer) return Promise.resolve({ at_group: false });
    return call("POST", B(ref), groupUrl ? { group_url: groupUrl } : undefined).then(function (r) {
      if (viewer) viewer.unmount();
      shown = ref; state = null;
      var me = viewer = window.ForlyViewer.create($("#manualBrowser"), API + B(ref) + "/view", {
        // A dead view must not look open: reset so the next "open" starts the browser again.
        onEnd: function (code) {
          if (code !== "closed") FLY.toast("הדפדפן נסגר — פתחו אותו שוב");
          if (viewer === me) closed();
        },
        onEvent: function (e) { if (e.t === "lane" && Lane && shown === ref) Lane.onState(e.lane); },
      });
      if (Lane) {
        var a = agents.filter(function (x) { return x.ref === ref; })[0];
        Lane.attach({ call: call, path: B(ref), name: (a && a.name) || "", onRecorded: function () { if (detailFor) loadDetail(detailFor); load(); } });
      }
      clearInterval(poll);
      // A running lane keeps polling in a hidden tab too: the backup to the pushed events.
      poll = setInterval(function () { if (document.visibilityState === "visible" || (Lane && Lane.active())) refresh(); }, 1500);
      call("GET", "/agents/" + encodeURIComponent(ref) + "/properties").then(function (j) { props = j.properties || []; renderSide(); }).catch(function () {});
      $("#manualAgent").value = ref;
      renderSide(); refresh();
      return r;
    });
  }
  // The browser's live view attaches a moment after it mounts: retry goto while it does.
  function gotoGroup(ref, url, tries) {
    return call("POST", B(ref) + "/goto", { group_url: url }).catch(function (e) {
      if (e && e.code === "no_viewer" && tries > 0) return new Promise(function (r) { setTimeout(r, 1500); }).then(function () { return gotoGroup(ref, url, tries - 1); });
      throw e;
    });
  }
  // One click: the agent's browser on this group, sharing this property.
  function openAt(item, k) {
    return leavePicked(k).then(function (go) { return go ? goOpen(item, k) : null; });
  }
  function goOpen(item, k) {
    return show(item.ref, item.group_url)
      .then(function (r) { return r && r.at_group ? null : gotoGroup(item.ref, item.group_url, 4); })
      .then(function () { return setProperty(item.page_id); })
      .then(function () { picked = k; here = { ref: item.ref, group_id: item.group_id, group_name: item.group_name }; opened[item.campaign_id] = true; renderQueue(); FLY.toast("הקבוצה נפתחה: " + (item.group_name || "")); });
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

  // ── agents who logged in but never pressed done: check the saved login ──
  function loadUnconnected() {
    var box = $("#manualUnconnectedList");
    return call("GET", "/unconnected").then(function (j) {
      var list = j.agents || [];
      box.innerHTML = !list.length ? '<p class="manual-muted">אין סוכנים כאלה.</p>' : list.map(function (a) {
        return '<div class="manual-item"><b>' + esc(a.name || "סוכן") + '</b> <span class="manual-muted">' + esc(a.phone_tail || "") + " · התחיל התחברות " + esc(when(a.started_at)) + "</span> " +
          // Optional: the exact profile name from Driver's dashboard, for a login made
          // in a profile this server would not find by itself (e.g. on staging).
          '<input type="text" class="manual-input" dir="ltr" data-profile="' + esc(a.ref) + '" placeholder="שם הפרופיל ב-Driver (לא חובה)" title="העתיקו את השם בדיוק מ-Driver. שם של סוכן אחר יחבר את החשבון שלו לסוכן הזה."> ' +
          '<button type="button" class="btn btn-ghost btn-sm" data-verify="' + esc(a.ref) + '">בדיקת התחברות</button></div>';
      }).join("");
    }).catch(function (e) { box.innerHTML = '<p class="manual-muted">לא הצלחנו לטעון את הרשימה.</p>'; fail(e); });
  }
  $("#manualUnconnected").addEventListener("toggle", function () { if (this.open) loadUnconnected(); });
  $("#manualUnconnectedList").addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-verify]");
    if (!btn) return;
    var ref = btn.getAttribute("data-verify");
    var input = btn.parentNode.querySelector("[data-profile]");
    var typed = input ? input.value.trim() : "";
    btn.disabled = true; btn.textContent = "בודקים…";
    call("POST", "/unconnected/" + encodeURIComponent(ref) + "/verify", typed ? { profile_name: typed } : null).then(function (r) {
      if (r.state === "connected") { FLY.toast("הסוכן מחובר ✓" + (r.identity_label ? " (" + r.identity_label + ")" : "")); load(); loadUnconnected(); }
      else { FLY.toast("הפרופיל השמור לא מחובר — הסוכן צריך להתחבר מחדש."); btn.disabled = false; btn.textContent = "בדיקת התחברות"; }
    }).catch(function (e) { fail(e); btn.disabled = false; btn.textContent = "בדיקת התחברות"; });
  });
  $("#manualAgent").addEventListener("change", renderQueue);
  $("#manualAgent").addEventListener("change", renderProfile);
  $("#manualProfileSave").addEventListener("click", function () {
    var ref = $("#manualAgent").value, name = $("#manualProfile").value.trim(), btn = this;
    if (!ref || !name) return;
    btn.disabled = true;
    call("POST", "/agents/" + encodeURIComponent(ref) + "/profile-name", { profile_name: name }).then(function (r) {
      agents.forEach(function (a) { if (a.ref === ref) { a.profile_name = r.profile_name; a.profile_saved = true; } });
      FLY.toast("הפרופיל נשמר לסוכן ✓");
      renderProfile();
    }).catch(fail).then(function () { btn.disabled = false; });
  });
  $("#manualPropPick").addEventListener("change", function () {
    var v = this.value, sel = this;
    if (!v) return;
    leavePicked(null).then(function (go) {
      if (!go) { sel.value = (state && state.property && state.property.page_id) || ""; return; }
      renderQueue();
      return setProperty(v);
    }).catch(fail);
  });
  // Another property for the group already on screen: no navigation needed.
  $("#manualAlso").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-also]");
    if (!b) return;
    var k = b.dataset.also, item = itemOf(k);
    if (!item) return;
    b.disabled = true;
    leavePicked(k).then(function (go) {
      if (!go) return;
      if (shown !== item.ref) return goOpen(item, k);
      return setProperty(item.page_id).then(function () {
        picked = k; opened[item.campaign_id] = true; renderQueue();
        FLY.toast("עכשיו משתפים: " + b.textContent.replace("🏠 ", ""));
      });
    }).catch(fail).then(function () { b.disabled = false; });
  });
  // Remember which properties are expanded, across the list's redraws.
  $("#manualQueue").addEventListener("toggle", function (ev) {
    var d = ev.target;
    if (d.matches && d.matches("details[data-cid]")) opened[d.dataset.cid] = d.open;
  }, true);
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
      var cid = detail.campaign.id, last = null, marked = 0;
      ids.reduce(function (p, gid) {
        return p.then(function () { return markPosted(cid, gid).then(function (j) { if (j) { last = j; marked++; } }); });
      }, Promise.resolve())
        .then(function () { if (marked) FLY.toast(last && last.completed ? "הקמפיין הושלם, הסוכן קיבל הודעה" : "סומנו " + marked + " קבוצות ✓"); })
        .catch(fail).then(function () { b.disabled = false; loadDetail(detailFor); load(); });
      return;
    }
    if (act === "copy") { navigator.clipboard.writeText(t).then(function () { FLY.toast("הטקסט הועתק"); }, function () { FLY.toast("ההעתקה נכשלה"); }); return; }
    b.disabled = true;
    var req = act === "type" ? call("POST", B(shown) + "/type", { text: t })
      : leavePicked(picked && itemOf(picked) && itemOf(picked).group_url === b.dataset.url ? picked : null).then(function (go) { renderQueue(); if (!go) throw { code: "cancelled" }; return call("POST", B(shown) + "/goto", { group_url: b.dataset.url }); });
    req.then(function () { FLY.toast(act === "type" ? "הטקסט הוקלד" : "הקבוצה נפתחה"); }).catch(function (e) { if (!e || e.code !== "cancelled") fail(e); }).then(function () { b.disabled = false; });
  });
  $("#manualBig").addEventListener("click", function () {
    var big = $(".manual-grid").classList.toggle("big");
    this.textContent = big ? "⤡ הקטנה" : "⤢ הגדלה";
  });
  $("#manualFull").addEventListener("click", function () {
    var el = $("#manualBrowser");
    if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen().catch(function () { FLY.toast("מסך מלא לא זמין בדפדפן הזה"); });
  });

  $("#manualQueue").addEventListener("change", function (ev) {
    var box = ev.target.closest("input[data-act=check]");
    if (!box) return;
    var item = itemOf(box.dataset.k);
    if (!item || item.status !== "owed") return;
    if (!confirm("לסמן את " + (item.group_name || "הקבוצה") + " כ\"פורסם\"? אי אפשר לבטל.")) { box.checked = false; return; }
    box.disabled = true;
    markPosted(item.campaign_id, item.group_id)
      .then(function (j) { if (!j) { box.checked = false; box.disabled = false; return; } FLY.toast(j.completed ? "הנכס פורסם בכל הקבוצות, הסוכן קיבל הודעה" : "סומן ✓"); if (picked === box.dataset.k) picked = null; if (detailFor) loadDetail(detailFor); return load(); })
      .catch(function (e) { box.checked = false; box.disabled = false; fail(e); });
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
    if (act === "skipped") {
      if (!confirm("לדלג על הקבוצה הזו? היא לא תופיע בהודעה לסוכן.")) return;
      b.disabled = true;
      call("POST", "/campaigns/" + encodeURIComponent(item.campaign_id) + "/groups/" + encodeURIComponent(item.group_id) + "/done", { status: act })
        .then(function (j) { FLY.toast(j.completed ? "הקמפיין הושלם, הסוכן קיבל הודעה" : "סומן ✓"); if (picked === b.dataset.k) picked = null; if (detailFor) loadDetail(detailFor); return load(); })
        .catch(function (e) { b.disabled = false; fail(e); });
      return;
    }
    b.disabled = true;
    var done = function () { b.disabled = false; };
    if (act === "open") { openAt(item, b.dataset.k).catch(fail).then(done); return; }
    if (shown !== item.ref) { done(); FLY.toast("קודם לחצו \"פתיחה בקבוצה\""); return; }
    call("POST", B(shown) + "/type", { text: item.copy }).then(function () { FLY.toast("הטקסט הוקלד"); }).catch(fail).then(done);
  });

  // ── tab wiring (like admin-posting.js) ──
  var tab = $("#tabManual"), pane = $("#paneManual");
  if (!tab || !pane) return;
  tab.addEventListener("click", function () {
    $("#viewAdmin").classList.add("wide");
    document.querySelectorAll(".tabs button").forEach(function (b) { b.classList.toggle("on", b === tab); });
    document.querySelectorAll("#viewAdmin [id^='pane']").forEach(function (p) { p.classList.toggle("hidden", p !== pane); });
    load();
  });
  document.querySelectorAll(".tabs button").forEach(function (b) {
    if (b !== tab) b.addEventListener("click", function () { tab.classList.remove("on"); pane.classList.add("hidden"); $("#viewAdmin").classList.remove("wide"); });
  });
  renderSide();
})();
