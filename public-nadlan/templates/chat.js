/* Forly Nadlan — landing-page chat bot widget.

   Loaded lazily by runtime.js (server templates) and p/page.js (legacy SPA),
   and ONLY when the resolved payload says the bot is on — so a page without it
   downloads nothing at all. Same trick as the in-page editor (p/page.js
   loadEditor).

   Entry point:  window.FlyChat.init(payload)
   where payload is the /api/property-page shape: it needs page_id, agent,
   language and chatbot:{enabled,greeting}.

   Both host pages have their own renderer, their own CSS and no shared
   component layer, so everything here is self-contained — including the
   "agent logo, else initials" avatar rule, which runtime.js and page.js each
   implement slightly differently and neither exposes. */
(function () {
  "use strict";

  var API = "/api/chat";
  var SS_KEY = "fly_chat_";          // + page_id → conversation id
  var SS_SEEN = "fly_chat_seen_";    // + page_id → proactive opener already fired
  var PROACTIVE_MS = 25000;
  var PROACTIVE_SCROLL = 0.5;
  var MAX_LEN = 500;

  var FALLBACK = {
    he: {
      title: "שאלות על הנכס?", sub: "אני עונה מיד",
      teaser: "יש שאלה על הנכס? אני כאן 👋",
      hello: "היי! אני יכול לענות על שאלות על הנכס — גודל, מחיר, קומה, השכונה. מה מעניין אתכם?",
      ph: "כתבו שאלה…", send: "שליחה", close: "סגירה",
      cta: "השאירו פרטים", err: "משהו השתבש. נסו שוב.",
      note: "העוזר החכם של Forly — עונה מהמידע שבדף",
      lead_intro: "אשמח שהמתווך יחזור אליכם עם התשובה. השאירו שם וטלפון:",
      lead_name: "שם", lead_phone: "טלפון", lead_send: "שליחה",
      lead_sent: "תודה! העברתי את הפרטים למתווך 🙌",
      lead_intro_offer: "רוצים שהמתווך יחזור אליכם? השאירו פרטים ואציע גם נכסים נוספים שמתאימים לתקציב:",
      lead_budget: "תקציב (₪)", lead_budget_rent: "תקציב חודשי (₪)",
      lead_timeline: "מתי מתכננים?", lead_financing: "מימון",
      tl_now: "מיידי", tl_1_3m: "1-3 חודשים", tl_3_6m: "3-6 חודשים", tl_6m_plus: "מעל חצי שנה", tl_looking: "רק מתעניין/ת",
      fn_mortgage: "צריך/ה משכנתא", fn_pre_approved: "יש אישור עקרוני", fn_cash: "הון עצמי מלא",
      fn_selling_first: "מוכר/ת נכס קודם", fn_unsure: "עדיין לא ברור",
      rec_intro: "לפי התקציב, אלה נכסים נוספים של המשרד שיכולים להתאים:",
      rec_rooms: "חד׳",
    },
    en: {
      title: "Questions?", sub: "I reply instantly",
      teaser: "Any questions about this property? 👋",
      hello: "Hi! I can answer questions about this property — size, price, floor, the area. What would you like to know?",
      ph: "Ask a question…", send: "Send", close: "Close",
      cta: "Leave your details", err: "Something went wrong. Please try again.",
      note: "Forly assistant — answers from this page",
      lead_intro: "I'll have the agent get back to you with the answer. Leave your name and phone:",
      lead_name: "Name", lead_phone: "Phone", lead_send: "Send",
      lead_sent: "Thanks! I've passed your details to the agent 🙌",
      lead_intro_offer: "Want the agent to get back to you? Leave your details and I'll also suggest listings that fit your budget:",
      lead_budget: "Budget (₪)", lead_budget_rent: "Monthly budget (₪)",
      lead_timeline: "When are you planning?", lead_financing: "Financing",
      tl_now: "Right away", tl_1_3m: "1-3 months", tl_3_6m: "3-6 months", tl_6m_plus: "6+ months", tl_looking: "Just looking",
      fn_mortgage: "Need a mortgage", fn_pre_approved: "Mortgage pre-approved", fn_cash: "Cash",
      fn_selling_first: "Selling a property first", fn_unsure: "Not sure yet",
      rec_intro: "Based on your budget, these other listings from the office may fit:",
      rec_rooms: "rooms",
    },
  };

  function init(data) {
    if (window.FlyChat._on) return;          // both loaders firing is harmless
    window.FlyChat._on = true;

    var pageId = data.page_id;
    var lang = data.language || "he";
    var rtl = window.I18N ? window.I18N.isRTL(lang) : (lang === "he" || lang === "ar");
    // The dictionary only carries he/en; every other language falls back to
    // Hebrew, matching I18N.t's own behaviour rather than shipping fake
    // translations.
    var S = FALLBACK[lang] || FALLBACK.he;
    var t = function (k) {
      return (window.I18N && window.I18N.t(lang, "chat_" + k) !== "chat_" + k) ?
        window.I18N.t(lang, "chat_" + k) : S[k];
    };

    var agent = data.agent || {};
    var cid = null;
    try { cid = sessionStorage.getItem(SS_KEY + pageId); } catch (e) {}
    var busy = false;
    var open = false;

    // ── shell ──
    var root = document.createElement("div");
    root.dir = rtl ? "rtl" : "ltr";
    document.body.appendChild(root);

    var bubble = el("button", "flychat-b");
    bubble.type = "button";
    bubble.setAttribute("aria-label", t("title"));
    bubble.innerHTML = '<span class="flychat-b-in">' + avatarHtml(agent) + "</span>";
    root.appendChild(bubble);

    var teaser = el("div", "flychat-t hidden");
    teaser.innerHTML = "<b>×</b>" + esc(data.chatbot && data.chatbot.greeting || t("teaser"));
    root.appendChild(teaser);

    var panel = el("div", "flychat-p hidden");
    panel.innerHTML =
      '<div class="flychat-h">' +
        '<span class="av">' + avatarHtml(agent) + "</span>" +
        "<span><span class='nm'>" + esc(agent.brand_name || agent.name || t("title")) + "</span>" +
        "<span class='sb' style='display:block'>" + esc(t("sub")) + "</span></span>" +
        '<button class="x" type="button" aria-label="' + esc(t("close")) + '">✕</button>' +
      "</div>" +
      '<div class="flychat-log"></div>' +
      '<form class="flychat-f"><input type="text" maxlength="' + MAX_LEN + '" ' +
        'placeholder="' + esc(t("ph")) + '" aria-label="' + esc(t("ph")) + '">' +
        '<button type="submit" aria-label="' + esc(t("send")) + '">➤</button></form>' +
      '<div class="flychat-note">' + esc(t("note")) + "</div>";
    root.appendChild(panel);

    var log = panel.querySelector(".flychat-log");
    var form = panel.querySelector(".flychat-f");
    var input = form.querySelector("input");

    // ── the SPA's mobile action bar shares the bottom of the screen ──
    var sticky = document.getElementById("stickyBar");
    if (sticky && window.MutationObserver) {
      var syncLift = function () {
        root.classList.toggle("flychat-lift", sticky.classList.contains("show") &&
          getComputedStyle(sticky).display !== "none");
      };
      new MutationObserver(syncLift).observe(sticky, { attributes: true, attributeFilter: ["class"] });
      syncLift();
    }

    // ── hide the bubble while the contact form is on screen ──
    var contact = document.getElementById("contact");
    if (contact && window.IntersectionObserver) {
      new IntersectionObserver(function (es) {
        if (open) return;
        bubble.classList.toggle("hidden", es[0].isIntersecting);
        if (es[0].isIntersecting) teaser.classList.add("hidden");
      }, { threshold: 0.25 }).observe(contact);
    }

    // ── open / close ──
    function setOpen(v) {
      open = v;
      panel.classList.toggle("hidden", !v);
      bubble.classList.toggle("hidden", v);
      teaser.classList.add("hidden");
      if (v) {
        bubble.classList.remove("ping");
        if (!log.children.length) push("bot", t("hello"));
        setTimeout(function () { input.focus(); }, 60);
        beacon("chat_open");
      }
    }
    bubble.addEventListener("click", function () { setOpen(true); });
    panel.querySelector(".x").addEventListener("click", function () { setOpen(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && open) setOpen(false); });
    teaser.addEventListener("click", function (e) {
      if (e.target.tagName === "B") { dismissTeaser(); return; }
      setOpen(true);
    });

    // ── proactive opener: 50% scroll or 25s dwell, once per session ──
    var teased = false;
    try { teased = sessionStorage.getItem(SS_SEEN + pageId) === "1"; } catch (e) {}
    function tease() {
      if (teased || open) return;
      teased = true;
      try { sessionStorage.setItem(SS_SEEN + pageId, "1"); } catch (e) {}
      if (bubble.classList.contains("hidden")) return;   // sitting over #contact
      teaser.classList.remove("hidden");
      bubble.classList.add("ping");
      beacon("chat_proactive");
    }
    function dismissTeaser() {
      teaser.classList.add("hidden");
      bubble.classList.remove("ping");
      beacon("chat_dismiss");
    }
    var timer = setTimeout(tease, PROACTIVE_MS);
    window.addEventListener("scroll", function onScroll() {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      if (h > 0 && window.scrollY / h >= PROACTIVE_SCROLL) {
        clearTimeout(timer);
        window.removeEventListener("scroll", onScroll);
        tease();
      }
    }, { passive: true });

    // ── messaging ──
    function push(who, text) {
      var m = el("div", "flychat-m " + who);
      m.textContent = text;                    // never innerHTML: model + visitor text
      log.appendChild(m);
      log.scrollTop = log.scrollHeight;
      return m;
    }
    // Mini lead form, inline in the log, shown ONCE per conversation.
    // Name + phone + budget are required; timeline and financing are selects
    // the visitor may skip. On submit it WhatsApps the agent (server side),
    // collapses to a thanks line and, when the server found other listings of
    // the same agent within the budget, renders them as link cards.
    // Tracks an open, unanswered form — not "a form was shown once". Two must
    // never stack, but a visitor who asks something else later and hits handoff
    // again is a second lead the agent still needs to hear about. The server
    // swallows a genuine double-tap (same number inside its dedupe window).
    var leadPending = false;
    var isRent = !!(data.property && data.property.listing_type === "rent");
    var TIMELINES = ["now", "1_3m", "3_6m", "6m_plus", "looking"];
    var FINANCINGS = ["mortgage", "pre_approved", "cash", "selling_first", "unsure"];

    function selectEl(label, keys, prefix) {
      var s = document.createElement("select");
      s.setAttribute("aria-label", label);
      var o0 = document.createElement("option");
      o0.value = ""; o0.textContent = label;
      s.appendChild(o0);
      keys.forEach(function (k) {
        var o = document.createElement("option");
        o.value = k; o.textContent = t(prefix + k);
        s.appendChild(o);
      });
      return s;
    }

    function pushLeadForm(intro) {
      if (leadPending) return;                 // never stack two forms
      leadPending = true;
      form.classList.add("flychat-f-hidden");  // the lead form replaces the composer, not alongside it
      var w = el("div", "flychat-lead");
      var introEl = el("div", "flychat-lead-intro");
      introEl.textContent = intro || t("lead_intro");
      var f = document.createElement("form");
      f.className = "flychat-lead-f";
      var nm = document.createElement("input");
      nm.type = "text"; nm.placeholder = t("lead_name"); nm.setAttribute("aria-label", t("lead_name"));
      nm.maxLength = 60; nm.required = true;
      var ph = document.createElement("input");
      ph.type = "tel"; ph.placeholder = t("lead_phone"); ph.setAttribute("aria-label", t("lead_phone"));
      ph.maxLength = 20; ph.required = true;
      var bd = document.createElement("input");
      bd.type = "number"; bd.inputMode = "numeric"; bd.min = "1"; bd.step = "1";
      bd.placeholder = t(isRent ? "lead_budget_rent" : "lead_budget");
      bd.setAttribute("aria-label", bd.placeholder);
      bd.required = true; bd.className = "flychat-lead-wide";
      var tl = selectEl(t("lead_timeline"), TIMELINES, "tl_");
      var fn = selectEl(t("lead_financing"), FINANCINGS, "fn_");
      var sub = document.createElement("button");
      sub.type = "submit"; sub.textContent = t("lead_send");
      f.appendChild(nm); f.appendChild(ph); f.appendChild(bd); f.appendChild(tl); f.appendChild(fn); f.appendChild(sub);
      w.appendChild(introEl); w.appendChild(f);
      log.appendChild(w);
      log.scrollTop = log.scrollHeight;
      beacon("chat_handoff");

      var fields = [nm, ph, bd, tl, fn, sub];
      function lock(v) { fields.forEach(function (x) { x.disabled = v; }); }

      f.addEventListener("submit", function (e) {
        e.preventDefault();
        var name = nm.value.trim(), phone = ph.value.trim();
        var budget = parseInt(bd.value, 10);
        if (name.length < 2 || phone.length < 9 || !(budget > 0)) return;
        lock(true);
        fetch("/api/chat/handoff", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            page_id: pageId, conversation_id: cid, name: name, phone: phone,
            budget: budget, timeline: tl.value || null, financing: fn.value || null,
          }),
        }).then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (d) {
            if (d && d.ok) {
              w.textContent = t("lead_sent");   // collapse to confirmation
              leadPending = false;              // a later handoff may ask again
              if (!closed) form.classList.remove("flychat-f-hidden");
              beacon("chat_lead");
              if (d.recommendations && d.recommendations.length) pushRecommendations(d.recommendations);
            } else {
              lock(false);
              push("err", t("err"));
            }
          }).catch(function () {
            lock(false);
            push("err", t("err"));
          });
      });
    }

    // Link cards for the agent's other listings within the budget. Rendered
    // from server data only — this widget never composes a listing itself.
    function pushRecommendations(list) {
      var m = push("bot", t("rec_intro"));
      var wrap = el("div", "flychat-recs");
      list.slice(0, 3).forEach(function (r) {
        if (!/^https?:\/\//.test(String(r.url || ""))) return;
        var a = document.createElement("a");
        a.className = "flychat-rec";
        a.href = r.url; a.target = "_blank"; a.rel = "noopener";
        var meta = [r.city, r.rooms ? r.rooms + " " + t("rec_rooms") : ""].filter(Boolean).join(" · ");
        a.innerHTML = "<b>" + esc(r.title || r.city || "") + "</b>" +
          "<span>" + esc(meta) + "</span>" +
          "<em>₪" + esc(Number(r.price).toLocaleString("en-US")) + "</em>";
        wrap.appendChild(a);
      });
      if (wrap.childNodes.length) { m.appendChild(wrap); beacon("chat_recommendation"); }
      log.scrollTop = log.scrollHeight;
    }

    // Conversation capped/closed: show the line, kill the composer.
    var closed = false;
    function closeChat(text) {
      closed = true;
      if (text) push("bot", text);
      input.disabled = true;
      form.querySelector("button").disabled = true;
      form.classList.add("flychat-f-off");
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text || busy) return;
      input.value = "";
      push("me", text);
      busy = true;
      form.querySelector("button").disabled = true;

      var dots = el("div", "flychat-dots");
      dots.innerHTML = "<i></i><i></i><i></i>";
      log.appendChild(dots);
      log.scrollTop = log.scrollHeight;

      fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_id: pageId, conversation_id: cid, message: text }),
      }).then(function (r) {
        return r.json().catch(function () { return {}; });
      }).then(function (d) {
        dots.remove();
        if (!d || !d.reply) { push("err", t("err")); return; }
        if (d.conversation_id) {
          cid = d.conversation_id;
          try { sessionStorage.setItem(SS_KEY + pageId, cid); } catch (e) {}
        }
        beacon("chat_message");
        // Capped/closed conversation: render the line and disable the composer,
        // rather than letting the visitor type into a dead conversation.
        if (d.state === "closed") { closeChat(d.reply); return; }
        push("bot", d.reply);
        // The bot has hit something it has no data for — the warm-lead moment.
        // Offer the name+phone form (once); on submit the agent is WhatsApped.
        if (d.state === "handoff") pushLeadForm();
        else if (d.offer_lead) pushLeadForm(t("lead_intro_offer"));
      }).catch(function () {
        dots.remove();
        push("err", t("err"));
      }).finally(function () {
        busy = false;
        if (closed) return;                    // don't revive a dead composer
        form.querySelector("button").disabled = false;
        input.focus();
      });
    });

    function beacon(ev) {
      try {
        navigator.sendBeacon("/api/property-event",
          JSON.stringify({ page_id: pageId, event: ev }));
      } catch (e) {}
    }
  }

  // ── helpers ──
  function el(tag, cls) {
    var e = document.createElement(tag);
    e.className = cls;
    return e;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  /* Agent logo when there is one, initials otherwise — the same rule
     runtime.js applies to [data-avatar], reimplemented here so the bubble looks
     identical on both rendering paths (page.js builds initials differently). */
  function avatarHtml(agent) {
    var url = String((agent && agent.logo_url) || "");
    if (/^https?:\/\//.test(url)) {
      return '<img src="' + esc(url) + '" alt="" ' +
        "onerror=\"this.remove()\">";
    }
    var initials = String((agent && agent.name) || "")
      .split(/\s+/).map(function (w) { return w.charAt(0); }).join("").slice(0, 2);
    return esc(initials || "💬");
  }

  window.FlyChat = { init: init, _on: false };
})();
