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
    },
    en: {
      title: "Questions?", sub: "I reply instantly",
      teaser: "Any questions about this property? 👋",
      hello: "Hi! I can answer questions about this property — size, price, floor, the area. What would you like to know?",
      ph: "Ask a question…", send: "Send", close: "Close",
      cta: "Leave your details", err: "Something went wrong. Please try again.",
      note: "Forly assistant — answers from this page",
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
    bubble.innerHTML = avatarHtml(agent);
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
    function pushCta() {
      var w = el("div", "flychat-cta");
      var a = document.createElement("a");
      a.href = "#contact";
      a.textContent = t("cta");
      a.addEventListener("click", function () { setOpen(false); });
      w.appendChild(a);
      log.appendChild(w);
      log.scrollTop = log.scrollHeight;
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
        push("bot", d.reply);
        beacon("chat_message");
        // The bot has hit something it has no data for — the warm-lead moment.
        // Phase 3 captures name and phone here and WhatsApps the agent; for now
        // it hands the visitor to the form that already exists.
        if (d.state === "handoff") pushCta();
      }).catch(function () {
        dots.remove();
        push("err", t("err"));
      }).finally(function () {
        busy = false;
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
