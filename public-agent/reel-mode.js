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
  };
  var msg = function (e) { return ERR[e.message] || "משהו השתבש, נסו שוב"; };

  // A 401 anywhere shows the login card again; it never redirects to /?next=.
  var rawFetch = window.fetch.bind(window);
  function api(path, body) {
    return rawFetch(path, { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })
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
    cc.readOnly = true;
    login.classList.add("hidden");
    viewForm.classList.remove("hidden");
  }

  // Already logged in (terms were accepted then) → straight to the wizard.
  api("/api/promo/quote").then(enter, showLogin);
})();
