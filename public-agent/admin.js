/* Forly Admin Console — all-agent property management.
   Reuses the shared FLY helpers (session cookie auth). A non-admin session
   gets 403 from /api/admin/* and lands on the "access denied" view; an
   unauthenticated one is bounced to the OTP login with ?next=/admin.html. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };

  var STATUS_LABELS = {
    active: "פעיל", expiring: "עומד לפוג", expired: "פג תוקף",
    archived: "בארכיון", building: "בבנייה",
  };

  var all = [];   // full property list from the server
  var stats = {};
  var agents = [];      // agent directory, loaded lazily when the tab is opened
  var agentStats = {};

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function chip(status) {
    return '<span class="chip ' + esc(status) + '">' + (STATUS_LABELS[status] || esc(status)) + "</span>";
  }

  function money(n) {
    if (!n) return "";
    return "₪" + Number(n).toLocaleString("he-IL");
  }

  function statCard(n, label) {
    return '<div class="stat"><div class="n num">' + esc(n) + '</div><div class="l">' + esc(label) + "</div></div>";
  }

  function renderStats() {
    $("#statGrid").innerHTML =
      statCard((stats.total_properties || 0), "נכסים") +
      statCard((stats.total_agents || 0), "סוכנים") +
      statCard((stats.active_pages || 0), "דפים פעילים") +
      statCard(Number(stats.total_views || 0).toLocaleString("he-IL"), "צפיות") +
      statCard(Number(stats.total_leads || 0).toLocaleString("he-IL"), "לידים");
  }

  function rowHtml(p) {
    var thumb = p.thumb_url ?
      '<img class="thumb-sm" src="' + esc(p.thumb_url) + '" alt="" loading="lazy">' :
      '<div class="thumb-sm" style="display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.4)">🏗️</div>';

    var actions = [];
    if (p.page_url && (p.page_status === "active" || p.page_status === "expiring")) {
      actions.push('<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="' + esc(p.page_url) + '">צפייה</a>');
    }
    if (p.page_id && p.page_status !== "building") {
      actions.push('<button class="btn btn-ghost btn-sm" data-extend="' + esc(p.page_id) + '">+30</button>');
    }
    if (p.listing_status !== "archived") {
      actions.push('<button class="btn btn-ghost btn-sm" data-archive="' + esc(p.listing_id) + '">ארכיון</button>');
    }
    actions.push('<button class="btn btn-danger btn-sm" data-delete="' + esc(p.listing_id) + '">מחיקה</button>');

    var priceLine = p.price ? '<div class="p-addr num">' + esc(money(p.price)) + "</div>" : "";

    return "<tr>" +
      "<td>" + thumb + "</td>" +
      '<td class="prop"><div class="p-title">' + esc(p.title || "—") + "</div>" +
        '<div class="p-addr">' + esc(p.address || "") + "</div>" + priceLine + "</td>" +
      '<td class="agent">' + esc(p.agent_name) +
        '<div class="p-addr num" dir="ltr">' + esc(p.business_phone || "") + "</div></td>" +
      "<td>" + chip(p.page_status) +
        (p.listing_status === "archived" ? " " + chip("archived") : "") + "</td>" +
      '<td class="num">' + esc(p.view_count) + "</td>" +
      '<td class="num">' + esc(p.lead_count) + "</td>" +
      '<td class="num">' + (p.days_left != null ? esc(p.days_left) : "—") + "</td>" +
      '<td><div class="row-actions">' + actions.join("") + "</div></td>" +
      "</tr>";
  }

  function applyFilters() {
    var q = ($("#search").value || "").trim().toLowerCase();
    var status = $("#statusFilter").value;
    var shown = all.filter(function (p) {
      if (status) {
        var matches = p.page_status === status ||
          (status === "archived" && p.listing_status === "archived");
        if (!matches) return false;
      }
      if (q) {
        var hay = [p.title, p.address, p.city, p.agent_name, p.business_phone].join(" ").toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    $("#rows").innerHTML = shown.map(rowHtml).join("");
    $("#emptyState").classList.toggle("hidden", shown.length > 0);
    $("#shownCount").textContent = shown.length === all.length ?
      all.length + " נכסים" : shown.length + " מתוך " + all.length;
    bindRowActions();
  }

  function bindRowActions() {
    document.querySelectorAll("[data-extend]").forEach(function (b) {
      b.addEventListener("click", function () {
        b.disabled = true;
        FLY.req("/api/admin/page/extend", { method: "POST", body: { page_id: b.dataset.extend }, noRedirect: true })
          .then(function () { FLY.toast("✅ הדף הוארך ב-30 יום"); load(); })
          .catch(function () { FLY.toast("שגיאה בהארכה"); b.disabled = false; });
      });
    });
    document.querySelectorAll("[data-archive]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (!confirm("להעביר את הנכס לארכיון? הדף יוסתר מהציבור.")) return;
        b.disabled = true;
        FLY.req("/api/admin/properties/delete", { method: "POST", body: { listing_id: b.dataset.archive, mode: "archive" }, noRedirect: true })
          .then(function () { FLY.toast("הנכס הועבר לארכיון"); load(); })
          .catch(function () { FLY.toast("שגיאה"); b.disabled = false; });
      });
    });
    document.querySelectorAll("[data-delete]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (!confirm("למחוק את הנכס לצמיתות? קבצי הדף יימחקו ולא ניתן לשחזר.")) return;
        b.disabled = true;
        FLY.req("/api/admin/properties/delete", { method: "POST", body: { listing_id: b.dataset.delete, mode: "delete" }, noRedirect: true })
          .then(function () { FLY.toast("הנכס נמחק"); load(); })
          .catch(function () { FLY.toast("שגיאה"); b.disabled = false; });
      });
    });
  }

  // ── agents view: premium feature flags, one row per agent ──

  function readinessPills(r) {
    r = r || {};
    // Only show the buckets that exist, so a tidy agent doesn't get three zeros.
    var parts = [];
    if (r.rich) parts.push('<span class="rich" title="דפים עם הרבה מידע">' + r.rich + " מלא</span>");
    if (r.ok) parts.push('<span title="דפים עם מידע בסיסי">' + r.ok + " בסיסי</span>");
    if (r.thin) parts.push('<span class="thin" title="דפים דלים — הבוט יעביר לסוכן כמעט מיד">' + r.thin + " דל</span>");
    return parts.length ? '<div class="rd">' + parts.join("") + "</div>" : '<span class="p-addr">—</span>';
  }

  function agentRowHtml(a) {
    var demo = a.is_demo ? '<span class="tag-demo">demo</span>' : "";
    return "<tr>" +
      '<td class="agent"><div class="agent-name">' + esc(a.name) + demo + "</div>" +
        '<div class="p-addr num" dir="ltr">' + esc(a.phone) + "</div></td>" +
      '<td class="num">' + esc(a.active_pages) + "</td>" +
      '<td class="num">' + Number(a.views || 0).toLocaleString("he-IL") + "</td>" +
      '<td class="num">' + Number(a.leads || 0).toLocaleString("he-IL") + "</td>" +
      "<td>" + readinessPills(a.readiness) + "</td>" +
      '<td><label class="switch"><input type="checkbox" data-chatbot="' + esc(a.phone) + '"' +
        (a.chatbot_enabled ? " checked" : "") + "><i></i></label></td>" +
      "</tr>";
  }

  function applyAgentFilter() {
    var q = ($("#agentSearch").value || "").trim().toLowerCase();
    var shown = agents.filter(function (a) {
      return !q || (a.name + " " + a.phone).toLowerCase().indexOf(q) !== -1;
    });
    $("#agentRows").innerHTML = shown.map(agentRowHtml).join("");
    $("#agentEmpty").classList.toggle("hidden", shown.length > 0);
    $("#agentCount").textContent = agentStats.chatbot_agents != null ?
      agentStats.chatbot_agents + " מתוך " + agents.length + " עם צ׳אט · " +
      agentStats.chatbot_pages + " דפים" : "";
    bindAgentActions();
  }

  function bindAgentActions() {
    document.querySelectorAll("[data-chatbot]").forEach(function (input) {
      input.addEventListener("change", function () {
        var phone = input.dataset.chatbot;
        var want = input.checked;
        input.disabled = true;
        FLY.req("/api/admin/business/features", {
          method: "POST",
          body: { phone: phone, feature: "chatbot", enabled: want },
          noRedirect: true,
        }).then(function () {
          // Keep the local copy in step so a re-filter doesn't revert the switch.
          var a = agents.filter(function (x) { return x.phone === phone; })[0];
          if (a) a.chatbot_enabled = want;
          agentStats.chatbot_agents = agents.filter(function (x) { return x.chatbot_enabled; }).length;
          agentStats.chatbot_pages = agents.reduce(function (n, x) {
            return n + (x.chatbot_enabled ? x.active_pages : 0);
          }, 0);
          applyAgentFilter();
          FLY.toast(want ? "✅ צ׳אט בוט הופעל לכל הדפים של הסוכן" : "צ׳אט בוט כובה");
        }).catch(function (e) {
          input.checked = !want;   // the server refused — don't lie about the state
          input.disabled = false;
          FLY.toast(e.code === "unknown_agent" ? "הסוכן לא נמצא" : "שגיאה בעדכון");
        });
      });
    });
  }

  function loadAgents() {
    return FLY.req("/api/admin/agents", { noRedirect: true }).then(function (d) {
      agents = d.agents || [];
      agentStats = d.stats || {};
      applyAgentFilter();
    });
  }

  function showTab(which) {
    var onAgents = which === "agents";
    $("#tabAgents").classList.toggle("on", onAgents);
    $("#tabProps").classList.toggle("on", !onAgents);
    $("#paneAgents").classList.toggle("hidden", !onAgents);
    $("#paneProps").classList.toggle("hidden", onAgents);
    if (onAgents && !agents.length) loadAgents();
  }

  function load() {
    return FLY.req("/api/admin/properties", { noRedirect: true }).then(function (d) {
      all = d.properties || [];
      stats = d.stats || {};
      renderStats();
      applyFilters();
      // Refresh the agents view too, but only once it has been opened.
      if (agents.length) return loadAgents();
    });
  }

  function showDenied(msg) {
    $("#viewAdmin").classList.add("hidden");
    $("#viewDenied").classList.remove("hidden");
    if (msg) $("#deniedMsg").textContent = msg;
  }

  // boot: verify admin access, then load. 401 → login (with return path);
  // 403 → access-denied view.
  FLY.req("/api/admin/me", { noRedirect: true })
    .then(function (me) {
      $("#viewAdmin").classList.remove("hidden");
      $("#who").textContent = me.phone || "";
      $("#search").addEventListener("input", applyFilters);
      $("#statusFilter").addEventListener("change", applyFilters);
      $("#agentSearch").addEventListener("input", applyAgentFilter);
      $("#tabProps").addEventListener("click", function () { showTab("props"); });
      $("#tabAgents").addEventListener("click", function () { showTab("agents"); });
      $("#refreshBtn").addEventListener("click", function () {
        FLY.toast("מרענן…"); load();
      });
      return load();
    })
    .catch(function (e) {
      if (e.status === 401) {
        location.href = "/?next=" + encodeURIComponent("/admin.html");
        return;
      }
      showDenied(e.code === "not_admin" ?
        "החשבון שלך אינו מורשה לגשת למסך הניהול." : "שגיאה בטעינת מסך הניהול.");
    });
})();
