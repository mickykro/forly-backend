/*
 * admin-promo.js — the admin's "ריל" tab (routes/promo.js): the ₪59 promo's
 * last day, every number that started /reel and how far it got, and "mark
 * paid" for a waiting order. Writes need a fresh step-up, like campaigns.
 */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var esc = FLY.esc;
  var API = "/api/promo/admin";
  var rows = [];
  var STAGE = { otp_sent: "לא אימת קוד", verified: "אומת, לא הזמין", checkout: "בתשלום — לא הושלם", payment_failed: "תשלום נכשל", paid: "שילם / קיבל" };
  var OPEN = { verified: 1, checkout: 1, payment_failed: 1 };
  var ORDER = { failed: " · היצירה נכשלה", amount_mismatch: " · סכום התשלום שגוי" }; // needs you: retry / refund
  var DONE = { done: " · נמסר ✓" };
  var fmt = function (v) { var d = new Date(v); return isNaN(d) ? "—" : d.toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" }); };

  function req(method, path, body) {
    return FLY.req(API + path, { method: method, body: body, noRedirect: true }).then(function (d) { $("#promoStepUp").classList.add("hidden"); return d; });
  }
  function fail(e) {
    if (e && e.status === 401 && e.code === "stepup_required") { $("#promoStepUp").classList.remove("hidden"); FLY.toast("נדרש אימות מחדש — התחברו שוב"); return; }
    FLY.toast(e && e.code === "already_started" ? "ההזמנה כבר טופלה" : "הפעולה נכשלה");
  }

  function showSettings(s) {
    $("#promoUntil").value = s.until_date || "";
    $("#promoState").textContent = s.until_date ? "המבצע פעיל עד " + new Date(s.until_date).toLocaleDateString("he-IL") : "אין מבצע כרגע";
  }

  function render() {
    var f = $("#promoStage").value;
    var list = rows.filter(function (r) { return f === "open" ? OPEN[r.stage] : f === "problem" ? ORDER[r.order_status] : !f || r.stage === f; });
    $("#promoCount").textContent = list.length + " מספרים";
    $("#promoLeads").innerHTML = list.map(function (r) {
      // WhatsApp only to numbers that opted in (Communications Law §30A) and verified the code.
      var wa = r.stage === "otp_sent" || !r.marketing_consent_at ? "" : '<a class="btn" target="_blank" rel="noopener" href="https://wa.me/' + esc(r.phone) + '">וואטסאפ</a> ';
      var rebuild = r.stage === "paid" && r.order_status === "failed";
      var pay = ((r.stage === "checkout" || r.stage === "payment_failed") && r.order_status !== "amount_mismatch" || rebuild) && r.order_id ? '<button class="btn" data-paid="' + esc(r.order_id) + '">' + (rebuild ? "בנה מחדש" : "סמן כשולם") + "</button>" : "";
      return "<tr><td class=\"num\">" + esc(r.phone) + "</td><td>" + esc(r.agent_name || "—") + "</td><td>" + esc((STAGE[r.stage] || r.stage) + (ORDER[r.order_status] || DONE[r.order_status] || "")) +
        "</td><td class=\"num\">" + (r.price == null ? "—" : "₪" + esc(String(r.price))) + "</td><td>" + fmt(r.last_seen_at) + "</td><td>" + wa + pay + "</td></tr>";
    }).join("") || '<tr><td colspan="6">אין עדיין</td></tr>';
  }

  function load() {
    return Promise.all([req("GET", "/settings"), req("GET", "/leads")]).then(function (a) {
      showSettings(a[0]); rows = a[1].leads || []; render();
    }, fail);
  }

  function save(date) {
    return req("PUT", "/settings", { until_date: date }).then(function (s) { showSettings(s); FLY.toast("נשמר"); }, fail);
  }

  $("#promoSave").addEventListener("click", function () {
    var d = $("#promoUntil").value;
    if (!d) { FLY.toast("בחרו תאריך"); return; }
    save(d);
  });
  $("#promoClear").addEventListener("click", function () { if (confirm("לסיים את המבצע עכשיו?")) save(null); });
  $("#promoStage").addEventListener("change", render);
  $("#promoLeads").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-paid]"); if (!b || b.disabled) return;
    if (!confirm("לסמן כשולם ולהתחיל ליצור את הסרטון?")) return;
    b.disabled = true;
    req("POST", "/orders/" + encodeURIComponent(b.getAttribute("data-paid")) + "/mark-paid", {})
      .then(function () { FLY.toast("הסרטון בהכנה"); return load(); }, fail)
      .then(function () { b.disabled = false; });
  });

  // ── tab wiring (like admin-campaigns.js) ──
  var tab = $("#tabPromo"), pane = $("#panePromo");
  if (!tab || !pane) return;
  tab.addEventListener("click", function () {
    document.querySelectorAll(".tabs button").forEach(function (b) { b.classList.toggle("on", b === tab); });
    document.querySelectorAll("#viewAdmin [id^='pane']").forEach(function (p) { p.classList.toggle("hidden", p !== pane); });
    load();
  });
  document.querySelectorAll(".tabs button").forEach(function (b) {
    if (b !== tab) b.addEventListener("click", function () { tab.classList.remove("on"); pane.classList.add("hidden"); });
  });
})();
