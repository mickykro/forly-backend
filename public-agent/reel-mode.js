/* /reel = create.html in reel mode. A stranger logs in by WhatsApp OTP (promo-scope
   session) and then gets the same wizard as create.html?key=demo. create.html sets
   reelMode/isDemo/adminDemo; this file adds the login card and the reel-only removals.
   Loaded before create.html's inline script, so the FLY/fetch patches cover it all.
   Markup and classes come from create.html only — no new CSS, no new class names. */
(function () {
  "use strict";
  if (!/^\/reel\/?$/.test(location.pathname)) return;
  var $ = function (s) { return document.querySelector(s); };

  var ERR = {
    invalid_code: "הקוד שגוי", code_expired: "הקוד פג, שלחו שוב", invalid_phone: "מספר הטלפון לא תקין",
    terms_required: "צריך לאשר את תנאי השימוש",
    too_soon: "כבר נשלח קוד — אפשר לבקש שוב בעוד רגע", whatsapp_send_failed: "לא הצלחנו לשלוח וואטסאפ, נסו שוב",
    too_many_attempts: "יותר מדי ניסיונות, בקשו קוד חדש", rate_limited: "יותר מדי בקשות, נסו שוב בעוד כמה דקות",
    code_already_used: "הקוד כבר נוצל, בקשו קוד חדש", no_code_requested: "בקשו קוד קודם",
    already_used: "כבר קיבלת סרטון חינם במספר הזה",
    reel_unavailable: "השירות לא זמין כרגע, נסו שוב מאוחר יותר",
    payment_unavailable: "מערכת התשלום לא זמינה כרגע, נסו שוב בעוד כמה דקות",
  };
  var msg = function (e) { return ERR[e.message] || "משהו השתבש, נסו שוב"; };

  // A 401 anywhere shows the login card again; it never redirects to /?next=.
  var rawFetch = window.fetch.bind(window);
  function api(path, body, method) {
    var get = method === "GET";
    return rawFetch(path, { method: method || "POST", credentials: "same-origin",
      headers: get ? {} : { "Content-Type": "application/json" }, body: get ? undefined : JSON.stringify(body || {}) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) throw Object.assign(new Error(d.error || "error " + r.status), { status: r.status });
          return d;
        });
      });
  }
  window.fetch = function (u) {
    return rawFetch.apply(null, arguments).then(function (r) {
      if (r.status === 401 && /^\/api\//.test(String(u && u.url || u))) showLogin();
      return r;
    });
  };
  var rawReq = FLY.req;
  FLY.req = function (path, opts) { return rawReq(path, Object.assign({}, opts, { noRedirect: true })); };
  // DELETE /api/upload is closed to promo: removing a photo only drops it from the form.
  FLY.deleteUpload = function () {};

  // ── the reel-only removals: fields the order drops (own video, font file, phone2, agent2) ──
  [".video-card", "#thFontFileWrap", "#addPhone2", "#addAgent2"].forEach(function (s) { $(s).classList.add("hidden"); });
  // no font file reaches /order, so "my own font" can't be picked
  Array.prototype.forEach.call(document.querySelectorAll('#thFontTitle option[value="custom"], #thFontBody option[value="custom"]'),
    function (o) { o.remove(); });

  // Same note, same markup; "we save your details automatically" isn't true for strangers.
  var note = $("#demoWorkspaceNote");
  note.querySelector(".demo-index").textContent = "REEL / 01";
  note.querySelector("strong").textContent = "בונים סרטון רילס ודף נכס.";
  note.querySelector("span[data-i18n]").textContent = "ממלאים פרטים ותמונות, ובסוף מקבלים בוואטסאפ את הסרטון ואת הדף.";
  ["strong", "span[data-i18n]"].forEach(function (s) { note.querySelector(s).removeAttribute("data-i18n"); });

  // ── login card, in place of #viewForm; built from the wizard's own card markup ──
  var login = document.createElement("div");
  login.id = "reelLogin";
  login.className = "creation-grid hidden";
  login.innerHTML =
    '<div class="form-column"><div class="card creation-card form-card">' +
    '<div class="section-intro"><span class="section-number">00</span><div><h2>כניסה עם וואטסאפ</h2>' +
    '<p>שולחים לכם קוד בוואטסאפ, ואז ממלאים את פרטי הנכס.</p></div></div>' +
    '<div class="field"><label for="rlPhone">מספר הוואטסאפ שלך</label>' +
    '<input id="rlPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="050-0000000"></div>' +
    '<div class="feature-row">' +
    '<label><input id="rlTerms" type="checkbox"> <span>קראתי ואני מסכים/ה ל<a href="/legal/terms.html" target="_blank" rel="noopener">תנאי השימוש</a>' +
    ' ול<a href="/legal/privacy.html" target="_blank" rel="noopener">מדיניות הפרטיות</a></span></label>' +
    '<label><input id="rlMarketing" type="checkbox"> <span>אשמח לקבל עדכונים והצעות בוואטסאפ (לא חובה)</span></label>' +
    '</div>' +
    '<div class="field hidden" id="rlCodeWrap"><label for="rlCode">הקוד שקיבלת בוואטסאפ</label>' +
    '<input id="rlCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></div>' +
    '<p class="form-err" id="rlErr" role="alert"></p>' +
    '<div class="wizard-actions form-actions"><button type="button" class="btn btn-gold primary-action" id="rlGo" disabled>שלחו לי קוד בוואטסאפ</button></div>' +
    '</div></div>';
  var viewForm = $("#viewForm");
  viewForm.parentNode.insertBefore(login, viewForm);
  viewForm.classList.add("hidden"); // until the session is known

  var err = function (t) { $("#rlErr").textContent = t || ""; $("#rlErr").classList.toggle("show", !!t); };
  var codeSent = false;
  function setCodeSent(on) {
    codeSent = on;
    $("#rlCodeWrap").classList.toggle("hidden", !on);
    $("#rlGo").textContent = on ? "אימות" : "שלחו לי קוד בוואטסאפ";
  }
  $("#rlTerms").addEventListener("change", function () { $("#rlGo").disabled = !$("#rlTerms").checked; });
  $("#rlPhone").addEventListener("input", function () { if (codeSent) setCodeSent(false); });
  $("#rlGo").addEventListener("click", function () {
    var btn = this, phone = $("#rlPhone").value;
    err("");
    if (!$("#rlTerms").checked) { err(ERR.terms_required); return; }
    btn.disabled = true;
    var step = codeSent
      ? api("/api/auth/otp/verify", { phone: phone, code: $("#rlCode").value }).then(function () {
          // best effort: consent is recorded only here, after the number is proven
          api("/api/promo/lead", { stage: "verified", marketing_consent: $("#rlMarketing").checked }).catch(function () {});
          return api("/api/promo/quote").then(enter);
        })
      : api("/api/promo/lead/start", { phone: phone, terms_accepted: true })
          .then(function () { return api("/api/auth/otp", { phone: phone, purpose: "reel" }); })
          .then(function () { setCodeSent(true); $("#rlCode").focus(); });
    step.catch(function (e) { err(msg(e)); }).then(function () { btn.disabled = false; });
  });

  function showLogin() {
    if (!login.classList.contains("hidden")) return;
    viewForm.classList.add("hidden");
    $("#viewBuilding").classList.add("hidden");
    sum.classList.add("hidden");
    FLY.loaderHide();
    login.classList.remove("hidden");
    window.scrollTo(0, 0);
  }

  // Logged in: the agent phone is the session's, read-only (never disabled: that greys it).
  function enter(q) {
    var full = String(q.phone || "");
    var cc = $("#agCC");
    var opt = Array.prototype.filter.call(cc.options, function (o) { return full.indexOf(o.value.replace(/\D/g, "")) === 0; })
      .sort(function (a, b) { return b.value.length - a.value.length; })[0];
    if (opt) {
      cc.value = opt.value;
      // a <select> has no readOnly: keep only the session's country
      Array.prototype.slice.call(cc.options).forEach(function (o) { if (o !== opt) o.remove(); });
    }
    var digits = opt ? opt.value.replace(/\D/g, "") : "";
    var rest = digits ? full.slice(digits.length) : full;
    $("#agPhone").value = digits === "972" ? "0" + rest : rest;
    $("#agPhone").readOnly = true;
    login.classList.add("hidden");
    viewForm.classList.remove("hidden");
    resetSubmit();
    // back from Cardcom: /reel?order=<id>[&failed=1] (once; a re-login resumes it)
    if (returnOrder) { var id = returnOrder; returnOrder = null; pollOrder(id, returnFailed); }
  }

  // ── stage 3 → the summary screen (the only place the price shows) → /api/promo/order ──
  var submit = $("#submitBtn");
  submit.removeAttribute("data-i18n"); // keeps "המשך": no reel button says pay
  function resetSubmit() { submit.disabled = false; submit.textContent = "המשך"; }
  resetSubmit();

  // in place of #viewForm, like #viewBuilding; the login card's markup and classes
  var sum = document.createElement("div");
  sum.id = "reelSummary";
  sum.className = "creation-grid hidden";
  viewForm.parentNode.insertBefore(sum, viewForm);
  function screen(title, text, inner) {
    sum.innerHTML = '<div class="form-column"><div class="card creation-card form-card">' +
      '<div class="section-intro"><span class="section-number">04</span><div><h2></h2><p></p></div></div>' +
      (inner || "") + "</div></div>";
    sum.querySelector("h2").textContent = title;
    sum.querySelector(".section-intro p").textContent = text;
    login.classList.add("hidden");
    viewForm.classList.add("hidden");
    FLY.loaderHide(function () { sum.classList.remove("hidden"); window.scrollTo(0, 0); });
  }
  var again = '<div class="wizard-actions form-actions"><a class="btn btn-gold primary-action" href="/reel">לנסות שוב</a></div>';
  var price = function (q) { return q.price === 0 ? "עלינו 🎁" : "₪" + q.price; };

  function summary(body, btn) {
    return api("/api/promo/quote").then(function (q) {
      screen("סיכום", "בודקים רגע, וממשיכים.",
        '<div class="creation-promise"><div><span class="promise-mark">✦</span><span>מה מקבלים</span></div>' +
        "<p>סרטון רילס לנכס ודף נכס אישי, נשלחים אליך בוואטסאפ.</p></div>" +
        '<div class="field"><label>המחיר</label><strong id="rsPrice"></strong></div>' +
        '<p class="hint">ביטול והחזרים לפי <a href="/legal/terms.html#reel" target="_blank" rel="noopener">תנאי השימוש</a>.</p>' +
        '<p class="form-err" id="rsErr" role="alert"></p>' +
        '<div class="wizard-actions form-actions split"><button type="button" class="btn btn-ghost secondary-action" id="rsBack">← חזרה</button>' +
        '<button type="button" class="btn btn-gold primary-action" id="rsGo">המשך</button></div>');
      $("#rsPrice").textContent = price(q);
      $("#rsBack").addEventListener("click", function () { // stage 3 again, button live
        sum.classList.add("hidden");
        viewForm.classList.remove("hidden");
        resetSubmit();
        btn.scrollIntoView({ block: "center" });
      });
      $("#rsGo").addEventListener("click", function () { order(body, this); });
    }).catch(function (e) {
      if (e.status === 401) return showLogin();
      throw e; // create.html's catch: the form back, with the error
    });
  }

  function order(body, go) {
    var err2 = function (t) { $("#rsErr").textContent = t; $("#rsErr").classList.toggle("show", !!t); };
    err2("");
    go.disabled = true;
    api("/api/promo/order", Object.assign({}, body, { terms_accepted: true })).then(function (o) {
      if (o.pay_url) { location.href = o.pay_url; return; }
      if (o.status === "pending") return screen("ההזמנה התקבלה", "נחזור אליך בוואטסאפ.");
      sum.classList.add("hidden");
      if (o.listing_id) REEL.build(o.listing_id, false);
      else pollOrder(o.order_id, false); // a free order: the listing id comes with the order
    }).catch(function (e) {
      if (e.status === 401) return showLogin();
      err2(msg(e));
      go.disabled = false;
      // the free reel was used meanwhile: show the price the next order will have
      if (e.message === "already_used") api("/api/promo/quote").then(function (q) { $("#rsPrice").textContent = price(q); }, function () {});
    });
  }

  // Cardcom return (and a free order): wait for the order's listing, then the building screen.
  function pollOrder(id, failed) {
    if (failed) {
      api("/api/promo/lead", { stage: "payment_failed" }).catch(function () {}); // best effort
      return screen("התשלום לא הושלם", "לא חויבת.", again);
    }
    viewForm.classList.add("hidden");
    FLY.loaderShow("ממתינים לאישור…");
    var tries = 0;
    (function tick() {
      api("/api/promo/order/" + encodeURIComponent(id), null, "GET").catch(function () { return null; }).then(function (o) {
        if (o && o.listing_id) return REEL.build(o.listing_id, false);
        if (o && (o.status === "failed" || o.status === "amount_mismatch")) return screen("משהו השתבש ביצירה", "ניצור איתך קשר בוואטסאפ.");
        if (++tries >= 20) return screen("ההזמנה התקבלה", "אם התשלום עבר — הסרטון בדרך ונעדכן אותך בוואטסאפ. לא חויבת? אפשר לנסות שוב מאוחר יותר.");
        setTimeout(tick, 3000);
      });
    })();
  }

  var returnOrder = (location.search.match(/[?&]order=([^&]+)/) || [])[1] || null;
  var returnFailed = /[?&]failed=1(&|$)/.test(location.search);
  // create.html calls REEL.summary on stage 3 and sets REEL.build (its startBuildingScreen)
  window.REEL = { summary: summary };

  // Already logged in (terms were accepted then) → straight to the wizard.
  api("/api/promo/quote").then(enter, showLogin);
})();
