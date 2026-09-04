/* admin-social.js — the "רשתות חברתיות" tab of admin.html.
   Renders GET /api/admin/social: one row per property with a live Facebook
   post, plus totals. Numbers are the server's cache (see server/admin-social.js)
   — a "–" means Facebook would not give that figure, never zero. */
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var rows = [];
  var stats = {};
  var bound = false;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtDate(ms) {
    if (!ms) return "—";
    var d = new Date(ms);
    return d.toLocaleDateString("he-IL") + " " + d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
  }
  var fmt = function (n) { return Number(n || 0).toLocaleString("he-IL"); };
  var cell = function (v) { return v == null ? "–" : fmt(v); };
  function statCard(n, label) {
    return '<div class="stat"><div class="n num">' + esc(n) + '</div><div class="l">' + esc(label) + "</div></div>";
  }

  function renderStats() {
    $("#socialStats").innerHTML =
      statCard(stats.posted_properties || 0, "נכסים שפורסמו") +
      statCard(stats.posting_agents || 0, "סוכנים מפרסמים") +
      statCard(fmt(stats.total_likes), "לייקים") +
      statCard(fmt(stats.total_comments), "תגובות") +
      statCard(fmt(stats.total_shares), "שיתופים") +
      statCard(fmt(stats.total_reach), "חשיפה") +
      statCard(stats.unreadable_posts || 0, "פוסטים שלא נקראו");
  }

  function rowHtml(p) {
    var m = p.metrics || {};
    var missing = !!m.missing;
    var num = function (v) {
      return '<td class="num">' + (missing ? "–" : cell(v)) + "</td>";
    };
    var links = [];
    if (p.post_url) links.push('<a href="' + esc(p.post_url) + '" target="_blank" rel="noopener">פייסבוק</a>');
    if (p.instagram_url) links.push('<a href="' + esc(p.instagram_url) + '" target="_blank" rel="noopener">אינסטגרם</a>');
    if (p.page_url) links.push('<a href="' + esc(p.page_url) + '" target="_blank" rel="noopener">דף הנכס</a>');
    return "<tr>" +
      "<td>" + (p.thumb_url ? '<img class="thumb-sm" src="' + esc(p.thumb_url) + '" alt="">' : "") + "</td>" +
      '<td class="prop"><div class="p-title">' + esc(p.title) + '</div><div class="p-addr">' + esc(p.address) + "</div></td>" +
      '<td class="agent">' + esc(p.agent_name) + "</td>" +
      "<td>" + esc(fmtDate(p.posted_at)) + "</td>" +
      num(m.likes) + num(m.comments) + num(m.shares) + num(m.reach) + num(m.video_views) +
      "<td>" + (missing ? '<span class="chip expired" title="פייסבוק לא החזיר את הפוסט (קוד ' + esc(m.error_code) + ')">לא נקרא</span>'
        : esc(m.fetched_at ? fmtDate(new Date(m.fetched_at).getTime()) : "טרם נמדד")) + "</td>" +
      "<td>" + links.join(" · ") + "</td>" +
      "</tr>";
  }

  function apply() {
    var q = ($("#socialSearch").value || "").trim().toLowerCase();
    var sort = $("#socialSort").value;
    var shown = rows.filter(function (p) {
      return !q || (p.title + " " + p.address + " " + p.agent_name).toLowerCase().indexOf(q) !== -1;
    });
    if (sort) {
      shown = shown.slice().sort(function (a, b) {
        var av = a.metrics && !a.metrics.missing ? Number(a.metrics[sort]) || 0 : -1;
        var bv = b.metrics && !b.metrics.missing ? Number(b.metrics[sort]) || 0 : -1;
        return bv - av;
      });
    }
    $("#socialRows").innerHTML = shown.map(rowHtml).join("");
    $("#socialEmpty").classList.toggle("hidden", shown.length > 0);
    $("#socialCount").textContent = shown.length === rows.length ? rows.length + " נכסים" : shown.length + " מתוך " + rows.length;
  }

  function load() {
    if (!bound) {
      bound = true;
      $("#socialSearch").addEventListener("input", apply);
      $("#socialSort").addEventListener("change", apply);
    }
    return FLY.req("/api/admin/social", { noRedirect: true }).then(function (d) {
      rows = d.properties || [];
      stats = d.stats || {};
      renderStats();
      apply();
    }).catch(function () { FLY.toast("שגיאה בטעינת נתוני הרשתות החברתיות"); });
  }

  window.ADMIN_SOCIAL = { load: load };
})();
