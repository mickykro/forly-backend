/* Forly Nadlan — in-page text edit mode ("magic edit link").
   Loaded by page.js only when the payload came back editable (valid #edit=
   token). Turns every visible text on the page into a tap-to-edit field —
   text only: no layout, no images, no numbers, no theme.
   Saves go to POST /api/page/edit-text (whitelist-merged server side). */

(function () {
  "use strict";

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  var payload = null;
  var token = null;
  var dirty = false;
  var originals = []; // [{el, text}] snapshot for cancel

  // Client-side caps (server enforces the same authoritative limits).
  function capFor(key) {
    var fixed = {
      "hero.phrase": 120, "agent.name": 60, "agent.brand_name": 60, "agent.tagline": 120,
      "cta.headline": 120, "cta.sub": 300, "cta.button_label": 40,
    };
    if (fixed[key]) return fixed[key];
    if (/^carousel\..*\.title$/.test(key)) return 80;
    if (/^carousel\..*\.body$/.test(key)) return 400;
    if (/^carousel\..*\.tag$/.test(key)) return 40;
    if (/^carousel\..*\.num$/.test(key)) return 6;
    if (/^gallery\./.test(key)) return 60;
    if (/^area\.blurb\./.test(key)) return 500;
    if (/^area\.stops\..*\.minutes$/.test(key)) return 40;
    if (/^area\.stops\./.test(key)) return 60;
    if (/^area\.stats\..*\.value$/.test(key)) return 40;
    if (/^area\.stats\./.test(key)) return 120;
    if (/^cta\.bullets\./.test(key)) return 120;
    return 200; // texts.* template strings
  }

  function multiline(key) {
    return key === "hero.phrase" || /^area\.blurb\./.test(key);
  }

  function mark(el, key) { if (el) el.setAttribute("data-edit", key); }

  // Wrap an element's bare text nodes in a span so mixed-content elements
  // (✦ bullet ticks, the video-badge dot) stay intact while their text edits.
  function wrapTail(el) {
    if (!el) return null;
    var existing = el.querySelector("[data-edit-wrap]");
    if (existing) return existing;
    var span = document.createElement("span");
    span.setAttribute("data-edit-wrap", "1");
    Array.prototype.slice.call(el.childNodes).forEach(function (n) {
      if (n.nodeType === 3) span.appendChild(n);
    });
    el.appendChild(span);
    return span;
  }

  // ── tag rendered (payload-driven) content with data-edit keys ──
  function annotate() {
    $$("#carousel .card").forEach(function (card, i) {
      mark(card.querySelector(".num"), "carousel.slides." + i + ".num");
      mark(card.querySelector("h3"), "carousel.slides." + i + ".title");
      mark(card.querySelector("p"), "carousel.slides." + i + ".body");
      mark(card.querySelector(".tag"), "carousel.slides." + i + ".tag");
    });
    $$("#gal .gal-item").forEach(function (item, i) {
      var cap = item.querySelector(".cap");
      if (!cap) { // photo without a caption — give it an editable slot
        cap = document.createElement("span");
        cap.className = "cap";
        item.appendChild(cap);
      }
      mark(cap, "gallery.captions." + i);
    });
    $$(".area-copy > p").forEach(function (par, i) { mark(par, "area.blurb." + i); });
    $$(".area-copy .stop").forEach(function (s, i) {
      mark(s.querySelector("b"), "area.stops." + i + ".label");
      mark(s.querySelector(".min"), "area.stops." + i + ".minutes");
    });
    $$(".area-stats .astat").forEach(function (s, i) {
      mark(s.querySelector("b"), "area.stats." + i + ".value");
      mark(s.querySelector("b + span"), "area.stats." + i + ".label");
    });
    $$(".trust > div").forEach(function (div, i) {
      mark(wrapTail(div), "cta.bullets." + i);
    });
    mark(wrapTail($(".video-badge")), "texts.video_badge");
  }

  // ── make everything editable ──
  var PLAINTEXT = (function () {
    var d = document.createElement("div");
    try { d.contentEditable = "plaintext-only"; } catch (e) { return false; }
    return d.contentEditable === "plaintext-only";
  })();

  function textOf(el) {
    return (el.innerText != null ? el.innerText : el.textContent || "").replace(/\u00a0/g, " ");
  }

  function makeEditable() {
    // Hero headline: swap the <br><em> markup for the raw phrase so it edits
    // as plain text (the markup comes back on the next public render).
    var h1 = $('[data-edit="hero.phrase"]');
    if (h1) h1.textContent = payload.hero.phrase || textOf(h1);

    $$("[data-edit]").forEach(function (el) {
      var key = el.getAttribute("data-edit");
      originals.push({ el: el, text: el.textContent });
      el.contentEditable = PLAINTEXT ? "plaintext-only" : "true";
      el.setAttribute("spellcheck", "false");
      // labels would forward clicks to their input instead of taking the caret
      if (el.tagName === "LABEL") el.removeAttribute("for");

      el.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          var allowNl = multiline(key) &&
            (key !== "hero.phrase" || textOf(el).indexOf("\n") === -1);
          if (!allowNl) { e.preventDefault(); return; }
        }
        // hard cap: block printable keys once full (no selection to replace)
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey &&
            textOf(el).length >= capFor(key) &&
            String(window.getSelection && window.getSelection()).length === 0) {
          e.preventDefault();
        }
      });
      el.addEventListener("input", function () {
        if (!PLAINTEXT && el.children.length) el.textContent = textOf(el); // strip pasted markup
        var over = textOf(el).length - capFor(key);
        if (over > 0) {
          el.textContent = textOf(el).slice(0, capFor(key));
          placeCaretEnd(el);
        }
        setDirty(true);
        hint(remainingHint(el, key));
      });
      el.addEventListener("focus", function () { hint(remainingHint(el, key)); });
      el.addEventListener("blur", function () { hint(""); });
      if (!PLAINTEXT) {
        el.addEventListener("paste", function (e) {
          e.preventDefault();
          var t = (e.clipboardData || window.clipboardData).getData("text/plain") || "";
          document.execCommand("insertText", false, t.replace(/\r/g, ""));
        });
      }
    });
  }

  function placeCaretEnd(el) {
    var r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function remainingHint(el, key) {
    var left = capFor(key) - textOf(el).length;
    return left <= 30 ? "נותרו " + Math.max(0, left) + " תווים" : "לחצו על כל טקסט בדף כדי לערוך";
  }

  // ── keep the page inert while editing ──
  function blockInteractions() {
    document.addEventListener("click", function (e) {
      var editable = e.target.closest && e.target.closest("[data-edit]");
      var gal = e.target.closest && e.target.closest(".gal-item");
      if (gal) { // no lightbox in edit mode; still allow caret in the caption
        e.stopPropagation();
        if (!editable) e.preventDefault();
        return;
      }
      if (editable && e.target.closest("a,button")) e.preventDefault();
    }, true);
    var form = $("#leadForm");
    if (form) form.addEventListener("submit", function (e) {
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  // ── toolbar ──
  function buildToolbar() {
    var bar = document.createElement("div");
    bar.className = "edit-toolbar";
    bar.innerHTML =
      '<div class="et-info"><b>מצב עריכה</b><span id="etHint">לחצו על כל טקסט בדף כדי לערוך</span></div>' +
      '<div class="et-actions">' +
      '<button type="button" class="et-btn et-cancel" id="etCancel">ביטול</button>' +
      '<button type="button" class="et-btn et-save" id="etSave" disabled>שמירה</button>' +
      "</div>";
    document.body.appendChild(bar);
    $("#etSave").addEventListener("click", save);
    $("#etCancel").addEventListener("click", cancel);
    window.addEventListener("beforeunload", function (e) {
      if (dirty) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  function hint(msg) {
    var el = $("#etHint");
    if (el) el.textContent = msg || "לחצו על כל טקסט בדף כדי לערוך";
  }

  function setDirty(v) {
    dirty = v;
    var btn = $("#etSave");
    if (btn) btn.disabled = !v;
  }

  // ── collect → save ──
  function visible(el) { return el.getClientRects().length > 0; }

  function collect() {
    var fields = { texts: {}, agent: {}, cta: {} };
    var slides = [], captions = [], stops = [], stats = [], bullets = [], blurb = [];
    $$("[data-edit]").forEach(function (el) {
      if (!visible(el)) return; // hidden sections keep template mock text — never save it
      var key = el.getAttribute("data-edit");
      var val = textOf(el);
      var m;
      if ((m = key.match(/^texts\.(\w+)$/))) fields.texts[m[1]] = val;
      else if (key === "hero.phrase") fields.hero_phrase = val;
      else if ((m = key.match(/^agent\.(\w+)$/))) fields.agent[m[1]] = val;
      else if ((m = key.match(/^cta\.bullets\.(\d+)$/))) bullets[+m[1]] = val;
      else if ((m = key.match(/^cta\.(\w+)$/))) fields.cta[m[1]] = val;
      else if ((m = key.match(/^carousel\.slides\.(\d+)\.(\w+)$/))) {
        (slides[+m[1]] = slides[+m[1]] || {})[m[2]] = val;
      } else if ((m = key.match(/^gallery\.captions\.(\d+)$/))) {
        var img = payload.gallery.images[+m[1]];
        if (img) captions.push({ url: img.url, caption: val });
      } else if ((m = key.match(/^area\.blurb\.(\d+)$/))) blurb[+m[1]] = val;
      else if ((m = key.match(/^area\.stops\.(\d+)\.(\w+)$/))) {
        (stops[+m[1]] = stops[+m[1]] || {})[m[2]] = val;
      } else if ((m = key.match(/^area\.stats\.(\d+)\.(\w+)$/))) {
        (stats[+m[1]] = stats[+m[1]] || {})[m[2]] = val;
      }
    });
    if (slides.length) fields.carousel_slides = slides;
    if (captions.length) fields.gallery_captions = captions;
    if (stops.length) fields.area_stops = stops;
    if (stats.length) fields.area_stats = stats;
    if (bullets.length) fields.cta.bullets = bullets.map(function (b) { return b == null ? "" : b; });
    if (blurb.length) fields.area_blurb = blurb.join("\n");
    return fields;
  }

  function save() {
    var btn = $("#etSave");
    btn.disabled = true;
    btn.textContent = "שומרים...";
    fetch("/api/page/edit-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page_id: payload.page_id, edit_token: token, fields: collect() }),
    }).then(function (r) {
      if (!r.ok) throw new Error("status " + r.status);
      return r.json();
    }).then(function () {
      setDirty(false);
      originals = originals.map(function (o) { return { el: o.el, text: o.el.textContent }; });
      hint("✓ נשמר — הדף עודכן");
    }).catch(function () {
      setDirty(true);
      hint("שגיאה בשמירה — נסו שוב");
    }).finally(function () { btn.textContent = "שמירה"; });
  }

  function cancel() {
    originals.forEach(function (o) { o.el.textContent = o.text; });
    setDirty(false);
    hint("");
  }

  // ── entry point (called by page.js after a tokened, editable fetch) ──
  window.FlyEdit = {
    init: function (d, editToken) {
      payload = d;
      token = editToken;
      document.body.classList.add("edit-mode");
      annotate();
      makeEditable();
      blockInteractions();
      buildToolbar();
    },
  };
})();
