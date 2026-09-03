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
  var portfolios = [];  // portfolio list, loaded lazily
  var portfolioStats = {};
  var customers = [];   // agent directory for the messaging tab
  var selectedCustomers = {};
  var maxMessageRecipients = 200;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function chip(status) {
    return '<span class="chip ' + esc(status) + '">' + (STATUS_LABELS[status] || esc(status)) + "</span>";
  }

  function fmtDate(ms) {
    if (!ms) return "—";
    return new Date(ms).toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "2-digit" });
  }

  function money(n) {
    if (!n) return "";
    return "₪" + Number(n).toLocaleString("he-IL");
  }

  function statCard(n, label) {
    return '<div class="stat"><div class="n num">' + esc(n) + '</div><div class="l">' + esc(label) + "</div></div>";
  }

  function renderStats() {
    console.log("renderStats", stats);
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
      actions.push('<a class="btn btn-ghost btn-sm" href="/edit.html?id=' + esc(p.page_id) + '&from=admin">עריכה</a>');
      actions.push('<button class="btn btn-ghost btn-sm" data-extend="' + esc(p.page_id) + '">+30</button>');
    }
    if (p.listing_status !== "archived") {
      actions.push('<button class="btn btn-ghost btn-sm" data-archive="' + esc(p.listing_id) + '">ארכיון</button>');
    }
    actions.push('<button class="btn btn-danger btn-sm" data-delete="' + esc(p.listing_id) + '">מחיקה</button>');

    var priceLine = p.price ? '<div class="p-addr num">' + esc(money(p.price)) + "</div>" : "";
    var cb = chatbotCell(p);

    return "<tr>" +
      "<td>" + thumb + "</td>" +
      '<td class="prop"><div class="p-title">' + esc(p.title || "—") + "</div>" +
        '<div class="p-addr">' + esc(p.address || "") + "</div>" + priceLine + "</td>" +
      '<td class="agent">' + esc(p.agent_name) +
        '<div class="p-addr num" dir="ltr">' + esc(p.business_phone || "") + "</div></td>" +
      '<td class="p-addr num">' + esc(fmtDate(p.created_at)) + "</td>" +
      "<td>" + chip(p.page_status) +
        (p.listing_status === "archived" ? " " + chip("archived") : "") + "</td>" +
      '<td class="num">' + esc(p.view_count) + "</td>" +
      '<td class="num">' + esc(p.lead_count) + "</td>" +
      '<td class="num">' + (p.days_left != null ? esc(p.days_left) : "—") + "</td>" +
      "<td>" + cb + "</td>" +
      '<td><div class="row-actions">' + actions.join("") + "</div></td>" +
      "</tr>";
  }

  // Per-page chat-bot override: "" = inherit the agent, on = force on for this
  // page even if the agent is off, off = force off even if the agent is on.
  // The line underneath spells out what "inherit" currently works out to,
  // since otherwise the selector alone never tells you the actual state.
  var CB_REASON = {
    page_on: "מופעל לדף הזה", page_off: "כבוי לדף הזה",
    agent_on: "מופעל דרך הסוכן", agent_off: "כבוי — הסוכן לא מורשה",
    global_off: "כבוי גלובלית",
  };

  function chatbotCell(p) {
    if (!p.page_id || !p.chatbot) return '<span class="p-addr">—</span>';
    var v = p.chatbot.page === true ? "on" : p.chatbot.page === false ? "off" : "";
    return '<select class="cb ' + esc(v) + '" data-cb="' + esc(p.page_id) + '">' +
      '<option value=""' + (v === "" ? " selected" : "") + ">ירושה מהסוכן</option>" +
      '<option value="on"' + (v === "on" ? " selected" : "") + ">מופעל</option>" +
      '<option value="off"' + (v === "off" ? " selected" : "") + ">כבוי</option>" +
      "</select>" +
      '<span class="cb-eff">' + (p.chatbot.effective ? "✓ " : "") +
      esc(CB_REASON[p.chatbot.reason] || "") + "</span>";
  }

  function applyFilters() {
    var q = ($("#search").value || "").trim().toLowerCase();
    var status = $("#statusFilter").value;
    var agent = $("#agentFilter").value;
    var sort = $("#sortBy").value;
    var shown = all.filter(function (p) {
      if (agent && p.business_phone !== agent) return false;
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
    if (sort === "views" || sort === "leads") {
      var key = sort === "views" ? "view_count" : "lead_count";
      shown.sort(function (a, b) { return (Number(b[key]) || 0) - (Number(a[key]) || 0); });
    }
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
    document.querySelectorAll("[data-cb]").forEach(function (sel) {
      sel.addEventListener("change", function () {
        var prev = sel.dataset.prev != null ? sel.dataset.prev : "";
        var val = sel.value;
        sel.disabled = true;
        FLY.req("/api/admin/page/chatbot", {
          method: "POST",
          body: { page_id: sel.dataset.cb, enabled: val === "on" ? true : val === "off" ? false : null },
          noRedirect: true,
        }).then(function (d) {
          // Patch the local row so re-filtering doesn't revert the selector.
          var row = all.filter(function (x) { return x.page_id === sel.dataset.cb; })[0];
          if (row) row.chatbot = d.chatbot;
          applyFilters();
          FLY.toast(d.chatbot && d.chatbot.effective ?
            "✅ צ׳אט בוט פעיל בדף" : "צ׳אט בוט כבוי בדף");
        }).catch(function () {
          sel.value = prev;          // the server refused — don't show a lie
          sel.disabled = false;
          FLY.toast("שגיאה בעדכון");
        });
      });
      sel.dataset.prev = sel.value;
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
      '<td><label class="switch"><input type="checkbox" data-portfolio-feature="' + esc(a.phone) + '"' +
        (a.portfolio_enabled ? " checked" : "") + "><i></i></label></td>" +
      '<td><label class="switch"><input type="checkbox" data-distribution="' + esc(a.phone) + '"' +
        (a.distribution_enabled ? " checked" : "") + "><i></i></label></td>" +
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
    // Portfolio + distribution entitlements share one shape: flip a feature
    // flag on the business, keep the local row in step, toast the result.
    // (Distribution arms the WhatsApp publish offer for FUTURE pages.)
    [
      { attr: "portfolioFeature", sel: "[data-portfolio-feature]", feature: "portfolio", key: "portfolio_enabled",
        on: "✅ דף נכסים הופעל לסוכן", off: "דף נכסים כובה" },
      { attr: "distribution", sel: "[data-distribution]", feature: "distribution", key: "distribution_enabled",
        on: "✅ הפצה הופעלה — נכסים חדשים יקבלו הצעת פרסום בוואטסאפ", off: "הפצה כובתה לסוכן" },
    ].forEach(function (f) {
      document.querySelectorAll(f.sel).forEach(function (input) {
        input.addEventListener("change", function () {
          var phone = input.dataset[f.attr];
          var want = input.checked;
          input.disabled = true;
          FLY.req("/api/admin/business/features", {
            method: "POST",
            body: { phone: phone, feature: f.feature, enabled: want },
            noRedirect: true,
          }).then(function () {
            var a = agents.filter(function (x) { return x.phone === phone; })[0];
            if (a) a[f.key] = want;
            input.disabled = false;
            FLY.toast(want ? f.on : f.off);
          }).catch(function (e) {
            input.checked = !want;   // the server refused — don't lie about the state
            input.disabled = false;
            FLY.toast(e.code === "unknown_agent" ? "הסוכן לא נמצא" : "שגיאה בעדכון");
          });
        });
      });
    });

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

  // ── portfolios view ──

  var PORTFOLIO_STATUS = { open: "פתוח", closed: "סגור", draft: "טיוטה" };

  function portfolioRowHtml(p) {
    var statusClass = p.status === "open" ? "active" : p.status === "closed" ? "expired" : "building";
    var actions = [];
    if (p.url) {
      actions.push('<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="' + esc(p.url) + '">צפייה</a>');
    }
    if (p.status === "open") {
      actions.push('<button class="btn btn-ghost btn-sm" data-portfolio-close="' + esc(p.phone) + '">סגירה</button>');
    } else {
      actions.push('<button class="btn btn-ghost btn-sm" data-portfolio-open="' + esc(p.phone) + '">פתיחה</button>');
    }
    return "<tr>" +
      '<td class="agent"><div class="agent-name">' + esc(p.name) + "</div></td>" +
      '<td><code style="font-size:.8rem">' + esc(p.slug) + "</code></td>" +
      '<td><span class="chip ' + esc(statusClass) + '">' + (PORTFOLIO_STATUS[p.status] || esc(p.status)) + "</span></td>" +
      '<td class="num" dir="ltr">' + esc(p.phone) + "</td>" +
      '<td><div class="row-actions">' + actions.join("") + "</div></td>" +
      "</tr>";
  }

  function applyPortfolioFilter() {
    var q = ($("#portfolioSearch").value || "").trim().toLowerCase();
    var status = $("#portfolioStatusFilter").value;
    var shown = portfolios.filter(function (p) {
      if (status && p.status !== status) return false;
      return !q || (p.name + " " + p.slug + " " + p.phone).toLowerCase().indexOf(q) !== -1;
    });
    $("#portfolioRows").innerHTML = shown.map(portfolioRowHtml).join("");
    $("#portfolioEmpty").classList.toggle("hidden", shown.length > 0);
    $("#portfolioCount").textContent = portfolioStats.total != null ?
      portfolioStats.open + " פתוחים מתוך " + portfolioStats.total : "";
    bindPortfolioActions();
  }

  function bindPortfolioActions() {
    document.querySelectorAll("[data-portfolio-open]").forEach(function (b) {
      b.addEventListener("click", function () {
        b.disabled = true;
        FLY.req("/api/admin/portfolio-status", {
          method: "POST", body: { phone: b.dataset.portfolioOpen, status: "open" }, noRedirect: true,
        }).then(function () {
          FLY.toast("✅ הפורטפוליו נפתח"); loadPortfolios();
        }).catch(function () { FLY.toast("שגיאה"); b.disabled = false; });
      });
    });
    document.querySelectorAll("[data-portfolio-close]").forEach(function (b) {
      b.addEventListener("click", function () {
        b.disabled = true;
        FLY.req("/api/admin/portfolio-status", {
          method: "POST", body: { phone: b.dataset.portfolioClose, status: "closed" }, noRedirect: true,
        }).then(function () {
          FLY.toast("הפורטפוליו נסגר"); loadPortfolios();
        }).catch(function () { FLY.toast("שגיאה"); b.disabled = false; });
      });
    });
  }

  function loadPortfolios() {
    return FLY.req("/api/admin/portfolios", { noRedirect: true }).then(function (d) {
      portfolios = d.portfolios || [];
      portfolioStats = d.stats || {};
      applyPortfolioFilter();
    });
  }

  function selectedCustomerCount() {
    return Object.keys(selectedCustomers).filter(function (phone) { return selectedCustomers[phone]; }).length;
  }

  function customerRowHtml(customer) {
    var checked = selectedCustomers[customer.phone] ? " checked" : "";
    return "<tr>" +
      '<td><input class="customer-check" type="checkbox" data-customer="' + esc(customer.phone) + '"' + checked + "></td>" +
      '<td class="agent">' + esc(customer.name) + '</td>' +
      '<td class="num" dir="ltr">' + esc(customer.phone) + '</td>' +
      '<td class="num">' + esc(customer.active_pages || 0) + "</td>" +
      "</tr>";
  }

  function updateMessageMeta() {
    var audience = $("#messageAudience").value;
    var count = audience === "all" ? customers.length : selectedCustomerCount();
    $("#messageLength").textContent = ($("#customerMessage").value || "").length + " / 1500";
    $("#messageRecipientCount").textContent = count + (audience === "all" ? " סוכנים יקבלו את ההודעה" : " סוכנים נבחרו");
    $("#sendCustomerMessage").disabled = count === 0 || count > maxMessageRecipients;
  }

  function applyCustomerFilter() {
    var q = ($("#customerSearch").value || "").trim().toLowerCase();
    var shown = customers.filter(function (customer) {
      return !q || (customer.name + " " + customer.phone).toLowerCase().indexOf(q) !== -1;
    });
    $("#customerRows").innerHTML = shown.map(customerRowHtml).join("");
    $("#customerEmpty").classList.toggle("hidden", shown.length > 0);
    $("#customerCount").textContent = shown.length === customers.length ? customers.length + " לקוחות" : shown.length + " מתוך " + customers.length;
    document.querySelectorAll("[data-customer]").forEach(function (input) {
      input.addEventListener("change", function () {
        selectedCustomers[input.dataset.customer] = input.checked;
        updateMessageMeta();
      });
    });
    updateMessageMeta();
  }

  function loadCustomers() {
    return FLY.req("/api/admin/agents", { noRedirect: true }).then(function (d) {
      customers = d.agents || [];
      applyCustomerFilter();
    });
  }

  function sendCustomerMessage() {
    var audience = $("#messageAudience").value;
    var count = audience === "all" ? customers.length : selectedCustomerCount();
    var message = ($("#customerMessage").value || "").trim();
    if (!message) return FLY.toast("יש לכתוב הודעה לפני השליחה");
    if (count > maxMessageRecipients) return FLY.toast("ניתן לשלוח לעד " + maxMessageRecipients + " סוכנים בפעולה אחת");
    if (!count) return FLY.toast("יש לבחור לפחות סוכן אחד");
    if (!confirm("לשלוח את ההודעה ל-" + count + " סוכנים?")) return;
    var button = $("#sendCustomerMessage");
    button.disabled = true;
    FLY.req("/api/admin/messages", {
      method: "POST",
      body: { audience: audience, phones: Object.keys(selectedCustomers).filter(function (phone) { return selectedCustomers[phone]; }), message: message },
      noRedirect: true,
    }).then(function (d) {
      FLY.toast("✅ ההודעה נשלחה ל-" + d.recipient_count + " סוכנים");
    }).catch(function (e) {
      FLY.toast(e.code === "too_many_recipients" ? "יש לצמצם את רשימת הסוכנים" : "שליחת ההודעה נכשלה");
    }).finally(function () { updateMessageMeta(); });
  }

  var TABS = ["props", "agents", "portfolios", "messages"];
  var TAB_IDS = { props: "Props", agents: "Agents", portfolios: "Portfolios", messages: "Messages" };

  function showTab(which) {
    TABS.forEach(function (t) {
      $("#tab" + TAB_IDS[t]).classList.toggle("on", t === which);
      $("#pane" + TAB_IDS[t]).classList.toggle("hidden", t !== which);
    });
    if (which === "agents" && !agents.length) loadAgents();
    if (which === "portfolios" && !portfolios.length) loadPortfolios();
    if (which === "messages" && !customers.length) loadCustomers();
  }

  function fillAgentFilter() {
    var sel = $("#agentFilter");
    var prev = sel.value;
    var seen = {};
    var opts = ['<option value="">כל הסוכנים</option>'];
    all.forEach(function (p) {
      if (!p.business_phone || seen[p.business_phone]) return;
      seen[p.business_phone] = 1;
      opts.push('<option value="' + esc(p.business_phone) + '">' +
        esc(p.agent_name || p.business_phone) + "</option>");
    });
    sel.innerHTML = opts.join("");
    if (seen[prev]) sel.value = prev;
  }

  function load() {
    return FLY.req("/api/admin/properties", { noRedirect: true }).then(function (d) {
      all = d.properties || [];
      stats = d.stats || {};
      renderStats();
      fillAgentFilter();
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

  $("#btnLogout").addEventListener("click", function () {
    FLY.req("/api/auth/logout", { method: "POST", noRedirect: true })
      .finally(function () { location.href = "/"; });
  });

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
      $("#tabPortfolios").addEventListener("click", function () { showTab("portfolios"); });
      $("#tabMessages").addEventListener("click", function () { showTab("messages"); });
      $("#portfolioSearch").addEventListener("input", applyPortfolioFilter);
      $("#portfolioStatusFilter").addEventListener("change", applyPortfolioFilter);
      $("#agentFilter").addEventListener("change", applyFilters);
      $("#sortBy").addEventListener("change", applyFilters);
      $("#customerSearch").addEventListener("input", applyCustomerFilter);
      $("#messageAudience").addEventListener("change", updateMessageMeta);
      $("#customerMessage").addEventListener("input", updateMessageMeta);
      $("#welcomeTemplate").addEventListener("click", function () {
        $("#customerMessage").value = "היי, ברוכים הבאים ל-FORLY 🏠✨\nכיף שאתם איתנו!\n\n🔗 כניסה למערכת:\nhttps://nadlan.call4li.com\n\nמוסיפים נכס, מעלים פרטים ותמונות, ואנחנו יוצרים עבורכם דף נכס מקצועי וסרטון שיווקי.\n\nלכל ההסבר על הכלים והשירותים, לחצו על סימן השאלה במערכת.\nלכל שאלה, אנחנו כאן בוואטסאפ ❤️";
        updateMessageMeta();
      });
      $("#sendCustomerMessage").addEventListener("click", sendCustomerMessage);
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
