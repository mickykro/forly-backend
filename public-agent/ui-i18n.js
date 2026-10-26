/* ui-i18n.js — the dashboard in the agent's language.
   Every page is authored in Hebrew. The chosen language is the create form's
   (localStorage "forly_lang", form-i18n.js); for any language but Hebrew this
   sets <html lang/dir>, fetches /api/i18n/<lang> — a dictionary of the pages'
   own Hebrew strings, translated once by Claude and cached on the server — and
   swaps text nodes and the visible attributes, now and as the page changes.
   A node is matched whole first, then by fragments (strings the code joins to a
   name or a number), never inside a Hebrew word. Nothing an agent typed leaves
   the browser. The switcher goes into the topbar; a page with its own (create)
   keeps it. No dictionary (no key on the server): the page stays Hebrew. */
(function () {
  "use strict";
  var KEY = "forly_lang";
  var ORDER = ["he", "en", "ar", "ru", "es", "fr"];
  var FLAGS = { he: "🇮🇱", en: "🇬🇧", ar: "🇸🇦", ru: "🇷🇺", es: "🇪🇸", fr: "🇫🇷" };
  var NAMES = { he: "עברית", en: "English", ar: "العربية", ru: "Русский", es: "Español", fr: "Français" };
  var RTL = { he: 1, ar: 1 };
  var HE = /[א-ת]/;
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, PRE: 1, CODE: 1, NOSCRIPT: 1 };
  var ATTRS = ["placeholder", "title", "aria-label", "alt"];
  var lang = "he";
  try { lang = localStorage.getItem(KEY) || "he"; } catch (e) { /* storage off */ }
  if (ORDER.indexOf(lang) < 0) lang = "he";

  var dict = {}, fragments = null, written = new WeakMap(), polls = 0;

  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  // Fragments: longest first, three characters at least, never starting inside
  // a Hebrew word; nor ending inside one, unless the fragment ends with a lone
  // letter — a preposition the code glues to the next word ("הפוסט עלה ל" + name).
  var LONE = /(^|\s)[\u05D0-\u05EA]$/;
  function compile() {
    var keys = Object.keys(dict).filter(function (k) { return k.length >= 3 && dict[k] !== k; }).sort(function (a, b) { return b.length - a.length; });
    fragments = keys.length ? new RegExp("(?<![\\u05D0-\\u05EA])(?:" + keys.map(function (k) { return esc(k) + (LONE.test(k) ? "" : "(?![\\u05D0-\\u05EA])"); }).join("|") + ")", "g") : null;
  }
  function translate(s) {
    if (!HE.test(s)) return null;
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s), core = m[2], t = dict[core];
    if (t == null && fragments) {
      t = core.replace(fragments, function (k, at, str) {
        var r = dict[k], next = str.charAt(at + k.length);
        return LONE.test(k) && !/\s$/.test(r) && next && !/\s/.test(next) ? r + " " : r; // the glued word gets its space back
      });
      if (t === core) t = null;
    }
    return t == null ? null : m[1] + t + m[3];
  }
  function node(n) {
    var v = n.nodeValue;
    if (written.get(n) === v) return;
    var t = translate(v);
    if (t != null && t !== v) { written.set(n, t); n.nodeValue = t; }
  }
  function attrs(el) {
    ATTRS.forEach(function (a) {
      if (!el.hasAttribute(a)) return;
      var t = translate(el.getAttribute(a));
      if (t != null) el.setAttribute(a, t);
    });
    if (el.tagName === "INPUT" && /^(button|submit|reset)$/i.test(el.type)) { var t = translate(el.value); if (t != null) el.value = t; }
  }
  function visit(n) {
    if (n.nodeType === 3) return node(n);
    if (n.nodeType !== 1 || SKIP[n.tagName] || n.getAttribute("translate") === "no" || n.isContentEditable) return;
    attrs(n);
    for (var c = n.firstChild; c; c = c.nextSibling) visit(c);
  }
  function pass() { visit(document.documentElement); }

  function load() {
    return fetch("/api/i18n/" + lang, { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      dict = d.entries || {};
      compile();
      pass();
      if (d.pending && polls++ < 30) setTimeout(load, 4000); // the server is still filling this language
    }).catch(function () { /* stays Hebrew */ });
  }

  function switcher() {
    if (document.getElementById("langSwitch")) return; // the page has its own (create.html)
    var tools = document.querySelector(".topbar-tools") || document.querySelector(".topbar");
    if (!tools) return;
    var sw = document.createElement("div");
    sw.className = "lang-switch";
    sw.setAttribute("translate", "no");
    sw.innerHTML = '<button type="button" class="lang-btn" aria-haspopup="true" aria-expanded="false"><span class="fl">' + FLAGS[lang] + "</span><span>" + NAMES[lang] + '</span><span aria-hidden="true">▾</span></button>' +
      '<div class="lang-menu" role="menu">' + ORDER.map(function (l) {
        return '<button type="button" class="lang-opt" role="menuitem" data-l="' + l + '" aria-selected="' + (l === lang) + '"><span class="fl">' + FLAGS[l] + "</span><span>" + NAMES[l] + "</span></button>";
      }).join("") + "</div>";
    var btn = sw.firstChild, menu = sw.lastChild;
    btn.addEventListener("click", function (e) { e.stopPropagation(); btn.setAttribute("aria-expanded", String(menu.classList.toggle("open"))); });
    document.addEventListener("click", function () { menu.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); });
    menu.addEventListener("click", function (e) {
      var opt = e.target.closest("[data-l]");
      if (!opt) return;
      try { localStorage.setItem(KEY, opt.getAttribute("data-l")); } catch (err) { /* storage off */ }
      location.reload(); // every string on the page is re-rendered in the new language
    });
    tools.insertBefore(sw, tools.firstChild);
  }

  function start() {
    switcher();
    if (lang === "he") return;
    document.documentElement.setAttribute("lang", lang);
    document.documentElement.setAttribute("dir", RTL[lang] ? "rtl" : "ltr");
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        if (m.type === "characterData") node(m.target);
        else if (m.type === "attributes") attrs(m.target);
        else for (var i = 0; i < m.addedNodes.length; i++) visit(m.addedNodes[i]);
      });
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    load();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
