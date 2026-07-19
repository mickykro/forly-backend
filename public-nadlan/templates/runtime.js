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
     data-wa                  → <a>.href = #contact (all contact goes through the
                                lead form — Forly relays to the agent, no direct WhatsApp)
     data-logo                → brand element: replaced with the agent's logo image
     data-avatar              → agent avatar: logo image, or initials from agent.name
     data-ppm                 → price-per-sqm line (sale listings with price+sqm)
     data-list="area.stops"   → clone the child <template> per array item,
                                filling [data-field="k"] from item[k]
     data-gallery data-gallery-class="g"  → build N tiles from the video's frames
     data-lead-form           → submit posts /api/property-lead
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
  var LANG = DATA.language || "he";
  function T(key, vars) { return window.I18N ? window.I18N.t(LANG, key, vars) : key; }

  // ── i18n: translate static chrome ([data-i18n]) + set <html lang/dir> ──
  if (window.I18N) window.I18N.apply(document, LANG);

  // ── theme: custom colors + fonts override the template's accent tokens ──
  (function applyTheme() {
    var theme = DATA.theme || {};
    var rs = document.documentElement.style;
    function hx(h) { var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(h || "").trim()); return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null; }
    function mix(c, t, a) { return { r: Math.round(c.r + (t - c.r) * a), g: Math.round(c.g + (t - c.g) * a), b: Math.round(c.b + (t - c.b) * a) }; }
    function rgb(c) { return "rgb(" + c.r + "," + c.g + "," + c.b + ")"; }
    var pr = hx(theme.primary);
    if (pr) { rs.setProperty("--accent", rgb(pr)); rs.setProperty("--accent-lite", rgb(mix(pr, 255, 0.3))); rs.setProperty("--accent-deep", rgb(mix(pr, 0, 0.35))); }
    var ac = hx(theme.accent);
    if (ac) rs.setProperty("--accent2", rgb(ac));
    var FF = { "Heebo": "Heebo:wght@300;400;500;600;700", "Assistant": "Assistant:wght@300;400;500;600;700", "Rubik": "Rubik:wght@300;400;500;600;700", "Frank Ruhl Libre": "Frank+Ruhl+Libre:wght@300;400;500;600;700", "Secular One": "Secular+One" };
    function loadFont(f) { if (!FF[f] || document.querySelector('link[data-f="' + f + '"]')) return; var l = document.createElement("link"); l.rel = "stylesheet"; l.setAttribute("data-f", f); l.href = "https://fonts.googleapis.com/css2?family=" + FF[f] + "&display=swap"; document.head.appendChild(l); }
    if (theme.font_url) { var st = document.createElement("style"); st.textContent = '@font-face{font-family:"CF";src:url("' + String(theme.font_url).replace(/"/g, "") + '");font-display:swap}'; document.head.appendChild(st); }
    function role(vars, choice, fb) { if (!choice) return; var fam = (choice === "custom" && theme.font_url) ? '"CF", ' + fb : (FF[choice] ? (loadFont(choice), "'" + choice + "', " + fb) : null); if (fam) vars.forEach(function (v) { rs.setProperty(v, fam); }); }
    role(["--serif", "--disp"], theme.font_title, "'Frank Ruhl Libre', serif"); // title → headings (--disp for reel)
    role(["--sans"], theme.font_body, "'Heebo', sans-serif");
  })();

  // ── scalar text bindings (data-bind="a.b||c.d" → first non-empty path wins) ──
  each("[data-bind]", document, function (el) {
    var v = null, paths = el.getAttribute("data-bind").split("||");
    for (var i = 0; i < paths.length; i++) { v = get(paths[i].trim()); if (v != null && v !== "") break; }
    if (el.getAttribute("data-fmt") === "price") v = fmtPrice(v) + (isRent && v ? " " + T("per_month") : "");
    if (v != null && v !== "") el.textContent = v;
  });
  each("[data-deal]", document, function (el) { el.textContent = isRent ? T("for_rent") : T("for_sale"); });
  each("[data-price-label]", document, function (el) { el.textContent = isRent ? T("monthly_rent") : T("asking_price"); });
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

  // ── contact links: everything funnels into the lead form (#contact). Forly
  //    relays the lead to the agent from its own WhatsApp number — the page
  //    never links prospects directly to the agent.
  each("[data-wa]", document, function (a) {
    a.href = "#contact";
    a.removeAttribute("target");
    a.setAttribute("data-i18n", "leave_details");
    a.textContent = T("leave_details");
  });

  // ── agent logo: brand slot + avatar circle ──
  var logoUrl = String(get("agent.logo_url") || "");
  var escAttr = function (s) { return String(s).replace(/"/g, "&quot;").replace(/</g, "&lt;"); };
  if (/^https?:\/\//.test(logoUrl)) {
    each("[data-logo]", document, function (el) {
      el.innerHTML = '<img src="' + escAttr(logoUrl) + '" alt="' + escAttr(get("agent.brand_name") || get("agent.name") || "") +
        '" style="height:38px;max-width:150px;object-fit:contain;display:block">';
    });
    each("[data-avatar]", document, function (el) {
      el.innerHTML = '<img src="' + escAttr(logoUrl) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">';
    });
  } else {
    var initials = String(get("agent.name") || "").split(/\s+/).map(function (w) { return w.charAt(0); }).join("").slice(0, 2);
    each("[data-avatar]", document, function (el) { if (initials) el.textContent = initials; });
  }

  // ── price per m² (sale listings with both price and size) ──
  var ppmPrice = +get("property.price") || 0, ppmSqm = +get("property.size_sqm") || 0;
  each("[data-ppm]", document, function (el) {
    if (isRent || !ppmPrice || !ppmSqm) { el.remove(); return; }
    el.textContent = "₪" + Math.round(ppmPrice / ppmSqm).toLocaleString("he-IL") + " " + T("per_sqm");
  });

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

  // ── gallery: show the uploaded photos. Real pages carry gallery.images
  //    (the actual listing photos); only the demo preview — which ships
  //    captions but no image URLs — falls back to sampling the tour video's
  //    frames so the template still has something to render.
  each("[data-gallery]", document, function (host) {
    var cls = host.getAttribute("data-gallery-class") || "g";
    var caps = (get("gallery.captions") || []);
    var images = get("gallery.images");
    var useImages = Array.isArray(images) && images.length > 0;
    var count = useImages ?
      Math.min(images.length, 12) :
      +(host.getAttribute("data-gallery-count") || 6);
    var frames = [], srcs = [], tiles = [], i;
    for (i = 0; i < count; i++) {
      var b = document.createElement("button");
      b.className = cls; b.type = "button";
      b.innerHTML = '<span class="g-no">' + (i < 9 ? "0" : "") + (i + 1) + "</span>";
      (function (idx) { b.addEventListener("click", function () { openLB(idx); }); })(i);
      host.appendChild(b); tiles.push(b);
    }

    if (useImages) {
      images.slice(0, count).forEach(function (img, k) {
        if (!img || !img.url) return;
        srcs[k] = img.url;
        var im = document.createElement("img");
        im.src = img.url; im.loading = "lazy"; im.decoding = "async";
        im.alt = img.caption || caps[k] || "";
        im.style.cssText = "width:100%;height:100%;object-fit:cover;display:block";
        tiles[k].insertBefore(im, tiles[k].firstChild);
        tiles[k].classList.add("loaded");
      });
    } else if (vsrc) {
      var FR = [];
      for (i = 0; i < count; i++) FR.push(0.06 + (0.86 * i) / Math.max(1, count - 1));
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
    }

    // lightbox (shared, created once) — holds both an <img> (photo mode) and a
    // <canvas> (video-frame preview mode); openLB shows whichever applies.
    var lb = document.getElementById("__lb");
    if (!lb) {
      lb = document.createElement("div"); lb.id = "__lb";
      lb.style.cssText = "position:fixed;inset:0;z-index:100;background:rgba(8,8,10,.95);display:none;align-items:center;justify-content:center;padding:4vw";
      lb.innerHTML = '<img id="__lbi" alt="" style="max-width:100%;max-height:88vh;border-radius:6px;display:none">' +
        '<canvas id="__lbc" style="max-width:100%;max-height:88vh;border-radius:6px;display:none"></canvas>' +
        '<button id="__lbx" aria-label="סגירה" style="position:absolute;top:22px;inset-inline-end:22px;width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,.4);background:transparent;color:#fff;font-size:1.1rem;cursor:pointer">✕</button>';
      document.body.appendChild(lb);
      lb.addEventListener("click", function (e) { if (e.target === lb) closeLB(); });
      document.getElementById("__lbx").addEventListener("click", closeLB);
      document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeLB(); });
    }
    function openLB(idx) {
      var lbi = document.getElementById("__lbi"), lbc = document.getElementById("__lbc");
      if (useImages) {
        if (!srcs[idx]) return;
        lbc.style.display = "none";
        lbi.src = srcs[idx]; lbi.style.display = "block";
      } else {
        var f = frames[idx]; if (!f) return;
        lbi.removeAttribute("src"); lbi.style.display = "none";
        lbc.width = f.width; lbc.height = f.height; lbc.getContext("2d").drawImage(f, 0, 0);
        lbc.style.display = "block";
      }
      lb.style.display = "flex"; document.body.style.overflow = "hidden";
    }
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
          body: JSON.stringify({ page_id: PAGE_ID, name: name, phone: ph, message: msg }),
        }).catch(function () {});
      }
      var sent = form.querySelector("[data-lead-sent]"); if (sent) sent.style.display = "block";
      beacon("cta_click");
    });
  });
})();
