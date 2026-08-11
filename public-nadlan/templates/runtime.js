/* Forly Nadlan — shared template runtime.
   Renders any of the data-driven landing templates (nocturne/galerie/reel/
   atelier/revue) from a single page payload. In production the server injects
   window.__PAGE__ with the real listing; for previews the template ships a
   window.__DEMO__ fallback.

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
     data-gallery data-gallery-class="g"  → build N tiles from the listing photos
       data-gallery-captions  → also print each tile's caption into <span class="g-cap">
     data-photo="k"           → <img>.src = gallery.images[k] — a single editorial
                                photo slot, outside the gallery grid
     data-lead-form           → submit posts /api/property-lead
       [data-lead="name|phone|message"], [data-lead-sent]
     data-count               → animate the number up when scrolled into view
       data-count-bind="a.b"  → take that number from the payload instead of the
                                attribute; drops [data-count-item] when it's empty
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

  // ── count-up targets taken from the payload rather than a hard-coded
  //    attribute. Runs before the observer below so the element is already
  //    carrying data-count by the time it is registered. A listing with no
  //    value for the field drops its whole stat ([data-count-item]) instead of
  //    animating up to a meaningless zero.
  each("[data-count-bind]", document, function (el) {
    var v = +get(el.getAttribute("data-count-bind"));
    if (v > 0) el.setAttribute("data-count", v);
    else (el.closest("[data-count-item]") || el).remove();
  });

  // ── document title / meta ──
  var title = get("property.title"), brand = get("agent.brand_name") || get("agent.name");
  if (title) document.title = title + (brand ? " · " + brand : "");

  // ── hero video ──
  var vsrc = get("hero.video_url"), poster = get("hero.poster_url");
  each("[data-video]", document, function (v) {
    if (poster) v.poster = poster;
    if (vsrc) { v.src = vsrc; v.load(); var p = v.play && v.play(); if (p && p.catch) p.catch(function () {}); }
  });

  // ── editorial photo slots — the single, full-bleed images the magazine-style
  //    templates hang their layout on, outside the gallery grid. data-photo="k"
  //    takes gallery.images[k] (wrapping round when the listing has fewer
  //    photos than the template has slots). The demo preview ships captions but
  //    no URLs, so it falls back to frames sampled from the tour video — a
  //    template never renders with a hole where a photo should be.
  (function photoSlots() {
    var slots = [], images = get("gallery.images"), caps = get("gallery.captions") || [];
    var have = Array.isArray(images) ? images.length : 0;
    each("img[data-photo]", document, function (img) {
      var k = Math.max(0, +img.getAttribute("data-photo") || 0);
      var pic = have ? images[k % have] : null;
      if (pic && pic.url) {
        img.src = pic.url;
        img.alt = img.alt || pic.caption || caps[k % have] || "";
      } else {
        slots.push({ img: img, k: k });
      }
    });
    if (!slots.length) return;
    if (!vsrc) {
      // nothing to sample from either — drop the empty slots so the layout
      // falls back to each container's own backdrop instead of holding a
      // sourceless <img>.
      slots.forEach(function (s) { s.img.remove(); });
      return;
    }
    var vv = document.createElement("video");
    vv.src = vsrc; vv.muted = true; vv.playsInline = true; vv.preload = "auto"; vv.crossOrigin = "anonymous";
    vv.addEventListener("loadedmetadata", function () {
      var i = 0;
      function seek() {
        if (i >= slots.length) return;
        vv.currentTime = Math.max(0.1, (0.08 + 0.78 * ((slots[i].k % 6) / 5)) * vv.duration);
      }
      vv.addEventListener("seeked", function () {
        try {
          var c = document.createElement("canvas");
          c.width = vv.videoWidth; c.height = vv.videoHeight;
          c.getContext("2d").drawImage(vv, 0, 0, c.width, c.height);
          // 0.85 was visibly soft on the editorial slots, which are the largest
          // thing a sampled frame ever fills. The frames are already the weakest
          // picture on the page — a 480p tour blown up full-bleed — so spending
          // a few KB here rather than compounding the loss is the better trade.
          slots[i].img.src = c.toDataURL("image/jpeg", 0.92);
        } catch (e) {} // tainted canvas (cross-origin video) — leave the slot to its CSS backdrop
        i++; seek();
      });
      seek();
    });
    vv.load();
  })();

  // ── contact links: everything funnels into the lead form (#contact). Forly
  //    relays the lead to the agent from its own WhatsApp number — the page
  //    never links prospects directly to the agent.
  each("[data-wa]", document, function (a) {
    a.href = "#contact";
    a.removeAttribute("target");
    a.setAttribute("data-i18n", "leave_details");
    a.textContent = T("leave_details");
  });

  // ── the logo's own background ─────────────────────────────────────────────
  // Most agency logos arrive as a flat image with a solid card baked in —
  // usually white — which shows as a pasted-on rectangle wherever the page is
  // not that colour. Rather than key it out (which mangles a mark with a soft
  // edge or a drop shadow), read what that colour is and let the template paint
  // with it, so the card the logo sits on and the card inside the logo are the
  // same colour and the seam disappears.
  //
  // Publishing re-hosts the logo onto this origin, so the canvas is readable.
  // Everything here is best-effort: a cut-out logo, a photographic one, a
  // cross-origin host without CORS, or an old browser all end with the template
  // left exactly as authored.
  function srgb(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }

  function sampleLogoBackground(url) {
    var probe = new Image();
    probe.crossOrigin = "anonymous";
    probe.addEventListener("error", function () {});
    probe.addEventListener("load", function () {
      var w = probe.naturalWidth, h = probe.naturalHeight;
      if (w < 4 || h < 4) return;
      var first = null;
      try {
        var c = document.createElement("canvas");
        c.width = w; c.height = h;
        var ctx = c.getContext("2d");
        ctx.drawImage(probe, 0, 0);
        // four corners and the middle of each edge. A mark on a solid card
        // agrees on all eight; a cut-out is transparent at the corners and a
        // photographic or gradient background disagrees between them.
        var pts = [[1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2],
                   [w >> 1, 1], [w >> 1, h - 2], [1, h >> 1], [w - 2, h >> 1]];
        for (var i = 0; i < pts.length; i++) {
          var d = ctx.getImageData(pts[i][0], pts[i][1], 1, 1).data;
          if (d[3] < 250) return;            // transparent — there is no card to match
          if (!first) { first = d; continue; }
          if (Math.abs(d[0] - first[0]) > 6 ||
              Math.abs(d[1] - first[1]) > 6 ||
              Math.abs(d[2] - first[2]) > 6) return;   // not one flat colour
        }
      } catch (e) { return; }                // tainted canvas
      if (!first) return;
      var rs = document.documentElement.style;
      rs.setProperty("--logo-bg", "rgb(" + first[0] + "," + first[1] + "," + first[2] + ")");
      // Whatever the template puts on that ground has to be readable on it, and
      // a logo card can just as easily be near-black as near-white.
      var lum = 0.2126 * srgb(first[0]) + 0.7152 * srgb(first[1]) + 0.0722 * srgb(first[2]);
      var dark = lum > 0.42;
      rs.setProperty("--logo-ink", dark ? "#14151b" : "#f7f5f0");
      rs.setProperty("--logo-ink-soft", dark ? "rgba(20,21,27,.68)" : "rgba(247,245,240,.74)");
      rs.setProperty("--logo-line", dark ? "rgba(20,21,27,.16)" : "rgba(247,245,240,.2)");
      document.documentElement.classList.add("has-logo-bg");
    });
    probe.src = url;
  }

  // ── agent logo: brand slot + avatar circle ──
  var logoUrl = String(get("agent.logo_url") || "");
  var escAttr = function (s) { return String(s).replace(/"/g, "&quot;").replace(/</g, "&lt;"); };
  if (/^https?:\/\//.test(logoUrl)) {
    each("[data-logo]", document, function (el) {
      el.innerHTML = '<img src="' + escAttr(logoUrl) + '" alt="' + escAttr(get("agent.brand_name") || get("agent.name") || "") +
        '" style="height:38px;max-width:150px;object-fit:contain;display:block">';
    });
    // The avatar slot is dressed for initials: a filled circle, in places with
    // a ring around it. A logo dropped into that was `cover`-cropped to the
    // circle, so anything wider than it is tall lost both ends — which is most
    // agency logos. `contain` fits the whole mark inside instead, and the
    // slot's own fill and ring come off so the logo sits on the page rather
    // than on a coloured disc. Initials keep the circle: see the else branch.
    each("[data-avatar]", document, function (el) {
      // Keep the height the design chose and give the slot a width to match the
      // logo's proportions, so a wide wordmark is neither cropped nor shrunk to
      // a quarter of the slot's height.
      //
      // Both numbers are definite, and they have to be. Sizing the slot
      // shrink-to-fit around an image that is itself capped to the slot's width
      // is circular, and CSS breaks the tie by falling back to the picture's
      // intrinsic size — which on a 520x400 logo in an 88px slot came out
      // 184x142 and spilled over the agent's name underneath.
      //
      // offsetHeight, not getBoundingClientRect(): several templates reveal this
      // block with a transform, and the rect is the *transformed* box, so a card
      // mid-animation at scale(.92) pins the slot 8% short and never recovers.
      var h = el.offsetHeight;
      if (h > 0) el.style.height = h + "px";
      el.style.aspectRatio = "auto";
      el.style.background = "none";
      el.style.border = "0";
      el.style.borderRadius = "0";
      el.style.overflow = "hidden";
      // a hook for the decoration templates hang off the slot — spinning rings,
      // pulsing haloes — which are drawn for a circle that is no longer there
      el.classList.add("has-logo");
      var im = document.createElement("img");
      im.alt = "";
      im.style.cssText = "width:100%;height:100%;object-fit:contain;display:block";
      im.addEventListener("load", function () {
        if (!h || !im.naturalWidth || !im.naturalHeight) return;
        el.style.width = Math.min(200, Math.round((h * im.naturalWidth) / im.naturalHeight)) + "px";
      });
      im.src = logoUrl;
      el.textContent = "";
      el.appendChild(im);
    });
    sampleLogoBackground(logoUrl);
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

  // ── amenities + area breakdown chips (parking, storage, elevator, sizes) ──
  //    A Shabbat elevator implies a regular elevator, so only the stronger badge
  //    shows. The host is removed entirely when the listing has none of these.
  each("[data-amenities]", document, function (host) {
    var p = get("property") || {};
    var chips = [];
    if (+p.size_built) chips.push(T("built_area") + " · " + p.size_built + " " + T("sqm"));
    if (+p.size_balcony) chips.push(T("balconies") + " · " + p.size_balcony + " " + T("sqm"));
    if (+p.size_garden) chips.push(T("garden") + " · " + p.size_garden + " " + T("sqm"));
    if (+p.parking) chips.push(p.parking + " " + T("parking"));
    if (p.storage) chips.push(T("storage"));
    if (p.shabbat_elevator) chips.push(T("shabbat_elevator"));
    else if (p.elevator) chips.push(T("elevator"));
    if (!chips.length) { host.remove(); return; }
    host.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;" + (host.style.cssText || "");
    chips.forEach(function (c) {
      var s = document.createElement("span");
      s.textContent = c;
      s.style.cssText = "display:inline-flex;align-items:center;padding:.42em .95em;border:1px solid rgba(128,128,128,.34);border-radius:100px;font-size:.82rem;line-height:1.3;white-space:nowrap";
      host.appendChild(s);
    });
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
    var wantCaps = host.hasAttribute("data-gallery-captions");
    function capOf(k) { return (useImages && images[k] && images[k].caption) || caps[k] || ""; }
    var frames = [], srcs = [], tiles = [], i;
    for (i = 0; i < count; i++) {
      var b = document.createElement("button");
      b.className = cls; b.type = "button";
      b.innerHTML = '<span class="g-no">' + (i < 9 ? "0" : "") + (i + 1) + "</span>";
      if (wantCaps && capOf(i)) {
        var cp = document.createElement("span");
        cp.className = "g-cap"; cp.textContent = capOf(i);
        b.appendChild(cp);
      }
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
      vv.src = vsrc; vv.muted = true; vv.playsInline = true; vv.preload = "auto";
      // Only a cross-origin fetch needs the CORS opt-in, and only it can taint
      // the canvas. On a blob:/data: source WebKit reads the attribute as a
      // failed CORS check and refuses the load, so it has to stay off there.
      if (/^https?:/i.test(vsrc)) vv.crossOrigin = "anonymous";
      // iOS will not decode a detached <video>; it has to be in the document and
      // laid out, so park it off-screen at 2px rather than display:none.
      vv.setAttribute("aria-hidden", "true");
      vv.style.cssText = "position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
      document.body.appendChild(vv);
      vv.addEventListener("loadedmetadata", function () {
        var k = 0;
        function seek() {
          if (k >= count) { if (vv.parentNode) vv.parentNode.removeChild(vv); return; }
          vv.currentTime = Math.max(0.1, FR[k] * vv.duration);
        }
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

  // ── chat bot: premium, resolved server-side (see server/chatbot-config.js).
  //    Assets load only when it is on, so other pages pay nothing. Never in a
  //    template preview — those iframe /tpl/*.html with no window.__PAGE__. ──
  (function loadChat() {
    if (IS_PREVIEW || !PAGE_ID) return;
    if (!DATA.chatbot || !DATA.chatbot.enabled) return;
    var css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/tpl/chat.css";
    document.head.appendChild(css);
    var s = document.createElement("script");
    s.src = "/tpl/chat.js";
    s.onload = function () { if (window.FlyChat) window.FlyChat.init(DATA); };
    document.body.appendChild(s);
  })();
})();
