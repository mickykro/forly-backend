/* Forly Nadlan — shared template runtime.
   Renders any of the data-driven landing templates (nocturne/galerie/reel) from
   a single page payload. In production the server injects window.__PAGE__ with
   the real listing; for previews the template ships a window.__DEMO__ fallback.

   Binding contract (attributes the templates use):
     data-bind="a.b.c"        → element.textContent = value at that path
       data-fmt="price"       → format as ₪, add " / חודש" for rentals
     data-deal                → "למכירה" / "להשכרה" by listing_type
     data-price-label         → "מחיר מבוקש" / "שכר דירה חודשי"
     data-show="a.b"          → element removed if the value is empty
     data-video               → <video>.src = hero.video_url (+ poster)
     data-wa                  → <a>.href = wa.me link to the agent
     data-list="area.stops"   → clone the child <template> per array item,
                                filling [data-field="k"] from item[k]
     data-gallery data-gallery-class="g"  → build N tiles from the video's frames
     data-lead-form           → submit posts /api/property-lead, then WhatsApp
       [data-lead="name|phone|message"], [data-lead-sent]
     data-count               → animate the number up when scrolled into view
   Interactions: scroll-reveal (.reveal), lightbox, view/CTA beacons. */
(function () {
  "use strict";
  var DATA = window.__PAGE__ || window.__DEMO__ || {};
  var PAGE_ID = DATA.page_id || (location.pathname.split("/p/")[1] || "").split(/[/?]/)[0];
  var IS_PREVIEW = !window.__PAGE__;
  var reduce = matchMedia("(prefers-reduced-motion:reduce)").matches;

  function get(path) {
    return path.split(".").reduce(function (o, k) { return (o == null) ? null : o[k]; }, DATA);
  }
  function fmtPrice(n) {
    if (!n) return "";
    n = +n;
    if (n >= 1e6) { var m = n / 1e6; return "₪" + (m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)) + "M"; }
    return "₪" + n.toLocaleString("he-IL");
  }
  var each = function (sel, root, fn) { Array.prototype.forEach.call((root || document).querySelectorAll(sel), fn); };

  var isRent = get("property.listing_type") === "rent";

  // ── scalar text bindings ──
  each("[data-bind]", document, function (el) {
    var v = get(el.getAttribute("data-bind"));
    if (el.getAttribute("data-fmt") === "price") v = fmtPrice(v) + (isRent && v ? " / חודש" : "");
    if (v != null && v !== "") el.textContent = v;
  });
  each("[data-deal]", document, function (el) { el.textContent = isRent ? "להשכרה" : "למכירה"; });
  each("[data-price-label]", document, function (el) { el.textContent = isRent ? "שכר דירה חודשי" : "מחיר מבוקש"; });
  each("[data-show]", document, function (el) { if (!get(el.getAttribute("data-show"))) el.remove(); });

  // ── document title / meta ──
  var title = get("property.title"), brand = get("agent.brand_name") || get("agent.name");
  if (title) document.title = title + (brand ? " · " + brand : "");

  // ── hero video ──
  var vsrc = get("hero.video_url"), poster = get("hero.poster_url");
  each("[data-video]", document, function (v) {
    if (poster) v.poster = poster;
    if (vsrc) { v.src = vsrc; v.load(); var p = v.play && v.play(); if (p && p.catch) p.catch(function () {}); }
  });

  // ── WhatsApp links ──
  var phone = String(get("agent.phone") || get("business_phone") || "").replace(/\D/g, "");
  var waText = encodeURIComponent("שלום, ראיתי את " + (title || "הנכס") + " ואשמח לתאם ביקור.");
  each("[data-wa]", document, function (a) { if (phone) a.href = "https://wa.me/" + phone + "?text=" + waText; });

  // ── list loops (clone the inner <template> per item) ──
  each("[data-list]", document, function (host) {
    var items = get(host.getAttribute("data-list"));
    var tpl = host.querySelector("template");
    if (!Array.isArray(items) || !tpl) return;
    host.innerHTML = "";
    items.forEach(function (item) {
      var node = tpl.content.firstElementChild.cloneNode(true);
      var fields = Array.prototype.slice.call(node.querySelectorAll("[data-field]"));
      if (node.matches && node.matches("[data-field]")) fields.unshift(node); // root can bind too
      fields.forEach(function (el) {
        var v = item[el.getAttribute("data-field")];
        if (v != null && v !== "") el.textContent = v;
      });
      host.appendChild(node);
    });
  });

  // ── gallery: extract frames from the tour video ──
  each("[data-gallery]", document, function (host) {
    var cls = host.getAttribute("data-gallery-class") || "g";
    var caps = (get("gallery.captions") || []);
    var count = +(host.getAttribute("data-gallery-count") || 6);
    var FR = [], i;
    for (i = 0; i < count; i++) FR.push(0.06 + (0.86 * i) / Math.max(1, count - 1));
    var frames = [], tiles = [];
    for (i = 0; i < count; i++) {
      var b = document.createElement("button");
      b.className = cls; b.type = "button";
      b.innerHTML = '<span class="g-no">' + (i < 9 ? "0" : "") + (i + 1) + "</span>";
      (function (idx) { b.addEventListener("click", function () { openLB(idx); }); })(i);
      host.appendChild(b); tiles.push(b);
    }
    if (!vsrc) return;
    var vv = document.createElement("video");
    vv.src = vsrc; vv.muted = true; vv.playsInline = true; vv.preload = "auto"; vv.crossOrigin = "anonymous";
    vv.addEventListener("loadedmetadata", function () {
      var k = 0;
      function seek() { if (k >= count) return; vv.currentTime = Math.max(0.1, FR[k] * vv.duration); }
      vv.addEventListener("seeked", function () {
        var c = document.createElement("canvas"); c.width = vv.videoWidth; c.height = vv.videoHeight;
        try { c.getContext("2d").drawImage(vv, 0, 0, c.width, c.height); frames[k] = c; tiles[k].insertBefore(c, tiles[k].firstChild); tiles[k].classList.add("loaded"); } catch (e) {}
        k++; seek();
      });
      seek();
    });
    vv.load();

    // lightbox (shared, created once)
    var lb = document.getElementById("__lb");
    if (!lb) {
      lb = document.createElement("div"); lb.id = "__lb";
      lb.style.cssText = "position:fixed;inset:0;z-index:100;background:rgba(8,8,10,.95);display:none;align-items:center;justify-content:center;padding:4vw";
      lb.innerHTML = '<canvas id="__lbc" style="max-width:100%;max-height:88vh;border-radius:6px"></canvas>' +
        '<button id="__lbx" aria-label="סגירה" style="position:absolute;top:22px;inset-inline-end:22px;width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,.4);background:transparent;color:#fff;font-size:1.1rem;cursor:pointer">✕</button>';
      document.body.appendChild(lb);
      lb.addEventListener("click", function (e) { if (e.target === lb) closeLB(); });
      document.getElementById("__lbx").addEventListener("click", closeLB);
      document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeLB(); });
    }
    function openLB(idx) { var f = frames[idx]; if (!f) return; var c = document.getElementById("__lbc"); c.width = f.width; c.height = f.height; c.getContext("2d").drawImage(f, 0, 0); lb.style.display = "flex"; document.body.style.overflow = "hidden"; }
    function closeLB() { lb.style.display = "none"; document.body.style.overflow = ""; }
  });

  // ── count-up ──
  function countUp(el) {
    var to = +el.getAttribute("data-count"), suf = el.getAttribute("data-count-suffix") || "", pre = el.getAttribute("data-count-prefix") || "";
    if (reduce) { el.textContent = pre + to.toLocaleString("he-IL") + suf; return; }
    var t0 = null;
    function step(ts) { if (!t0) t0 = ts; var p = Math.min(1, (ts - t0) / 1100), e = 1 - Math.pow(1 - p, 3); el.textContent = pre + Math.round(to * e).toLocaleString("he-IL") + suf; if (p < 1) requestAnimationFrame(step); }
    requestAnimationFrame(step);
  }

  // ── scroll reveal + count-up trigger ──
  var revs = document.querySelectorAll(".reveal, [data-count]");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add("in");
        if (e.target.hasAttribute("data-count")) countUp(e.target);
        each("[data-count]", e.target, countUp);
        io.unobserve(e.target);
      });
    }, { threshold: 0.15 });
    each(".reveal", document, function (el) { io.observe(el); });
    each("[data-count]", document, function (el) { io.observe(el); });
  } else {
    each(".reveal", document, function (el) { el.classList.add("in"); });
    each("[data-count]", document, countUp);
  }

  // ── beacons ──
  function beacon(ev) { if (IS_PREVIEW || !PAGE_ID) return; try { navigator.sendBeacon("/api/property-event", JSON.stringify({ page_id: PAGE_ID, event: ev })); } catch (e) {} }
  beacon("view");
  each("[data-wa],[href='#contact'],a[href*='wa.me']", document, function (a) { a.addEventListener("click", function () { beacon("cta_click"); }); });

  // ── lead form ──
  each("[data-lead-form]", document, function (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var name = (form.querySelector("[data-lead='name']") || {}).value || "";
      var ph = (form.querySelector("[data-lead='phone']") || {}).value || "";
      var msg = (form.querySelector("[data-lead='message']") || {}).value || "";
      name = String(name).trim(); ph = String(ph).trim(); msg = String(msg).trim();
      if (!IS_PREVIEW && PAGE_ID && name && ph) {
        fetch("/api/property-lead", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page_id: PAGE_ID, name: name, phone: ph }),
        }).catch(function () {});
      }
      if (phone) window.open("https://wa.me/" + phone + "?text=" + encodeURIComponent("שלום, אני " + name + " (" + ph + ") ואשמח לתאם ביקור ב" + (title || "נכס") + "." + (msg ? "\n" + msg : "")), "_blank");
      var sent = form.querySelector("[data-lead-sent]"); if (sent) sent.style.display = "block";
      beacon("cta_click");
    });
  });
})();
