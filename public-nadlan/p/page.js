/* Forly Nadlan — property page renderer.
   Fetches /api/property-page?id={pageId} and binds the payload onto the
   approved template structure. States: loading → active | expired | notfound. */

(function () {
  "use strict";

  var pageId = (location.pathname.split("/p/")[1] || "").split("/")[0].split("?")[0];
  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  // Magic edit link: /p/{id}#edit={token}. The token stays in the fragment
  // (never sent to the server in the URL) and is stripped from the address
  // bar immediately; we hand it to the API explicitly.
  var editToken = (function () {
    var m = location.hash.match(/(?:^#|[#&])edit=([0-9a-f]{16,64})(?:&|$)/i);
    if (!m) return null;
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* no-op */ }
    return m[1];
  })();

  function setState(state) {
    document.body.classList.remove("is-loading", "has-state", "state-expired", "state-notfound");
    if (state === "active") return;
    if (state === "loading") { document.body.classList.add("is-loading"); return; }
    document.body.classList.add("has-state", "state-" + state);
  }

  function fmtPrice(n) {
    if (!n) return "";
    if (n >= 1e6) {
      var m = n / 1e6;
      return "₪" + (m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)) + "M";
    }
    return "₪" + Number(n).toLocaleString("he-IL");
  }

  function beacon(event) {
    if (editToken) return; // the agent editing his page is not a visitor
    try {
      navigator.sendBeacon("/api/property-event",
        JSON.stringify({ page_id: pageId, event: event }));
    } catch (e) { /* no-op */ }
  }

  // ── theme ───────────────────────────────────────────────
  // Curated Hebrew fonts we can load from Google Fonts on demand.
  var FONT_FAMILIES = {
    "Heebo": "Heebo:wght@300;400;500;600;700",
    "Assistant": "Assistant:wght@300;400;500;600;700",
    "Rubik": "Rubik:wght@300;400;500;600;700",
    "Frank Ruhl Libre": "Frank+Ruhl+Libre:wght@300;400;500;600;700",
    "Secular One": "Secular+One",
  };

  function hexToRgb(h) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(h || "").trim());
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
  }
  function mix(rgb, target, amt) { // amt 0..1 toward target (255=lighten, 0=darken)
    return {
      r: Math.round(rgb.r + (target - rgb.r) * amt),
      g: Math.round(rgb.g + (target - rgb.g) * amt),
      b: Math.round(rgb.b + (target - rgb.b) * amt),
    };
  }
  var rgbStr = function (c) { return "rgb(" + c.r + "," + c.g + "," + c.b + ")"; };

  var TEMPLATES = { classic: 1, minimal: 1, bold: 1 };

  function applyTheme(theme) {
    if (!theme) return;
    var root = document.documentElement.style;

    // Layout template (classic | minimal | bold) — swaps look via CSS variants.
    document.documentElement.setAttribute("data-template",
      TEMPLATES[theme.template] ? theme.template : "classic");

    // Colors: primary drives the gold accent tokens; derive bright/faint from it.
    var primary = hexToRgb(theme.primary);
    if (primary) {
      root.setProperty("--gold", rgbStr(primary));
      root.setProperty("--gold-bright", rgbStr(mix(primary, 255, 0.28)));
      root.setProperty("--gold-faint", "rgba(" + primary.r + "," + primary.g + "," + primary.b + ",.16)");
    }
    var accent = hexToRgb(theme.accent);
    if (accent) root.setProperty("--dark", rgbStr(mix(accent, 0, 0.45)));

    // Fonts: a custom uploaded font is registered once; each role (title →
    // --serif, body → --sans) is set to its chosen family, loading the Google
    // family on demand. "custom" points a role at the uploaded font.
    if (theme.font_url) {
      var style = document.createElement("style");
      style.textContent = '@font-face{font-family:"CustomFont";src:url("' +
        theme.font_url.replace(/"/g, "") + '");font-display:swap}';
      document.head.appendChild(style);
    }
    applyRoleFont("--serif", theme.font_title, "'Frank Ruhl Libre', serif");
    applyRoleFont("--sans", theme.font_body, "'Heebo', sans-serif");
  }

  function loadGoogleFont(family) {
    if (!FONT_FAMILIES[family]) return;
    if (document.querySelector('link[data-font="' + family + '"]')) return;
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.setAttribute("data-font", family);
    link.href = "https://fonts.googleapis.com/css2?family=" + FONT_FAMILIES[family] + "&display=swap";
    document.head.appendChild(link);
  }
  function applyRoleFont(cssVar, choice, fallback) {
    if (!choice) return;
    if (choice === "custom") {
      document.documentElement.style.setProperty(cssVar, '"CustomFont", ' + fallback);
    } else if (FONT_FAMILIES[choice]) {
      loadGoogleFont(choice);
      document.documentElement.style.setProperty(cssVar, "'" + choice + "', " + fallback);
    }
  }

  // ── render ──────────────────────────────────────────────

  function render(d) {
    applyTheme(d.theme);
    var p = d.property, a = d.agent;
    var text = function (sel, val) { var el = $(sel); if (el && val != null) el.textContent = val; };

    // meta / og
    document.title = p.title + " · " + a.brand_name;
    var metas = {
      'meta[name="description"]': d.hero.phrase || p.title,
      'meta[property="og:title"]': p.title,
      'meta[property="og:description"]': d.hero.phrase || (d.area && d.area.blurb) || "",
      'meta[property="og:image"]': d.hero.poster_url || "",
    };
    Object.keys(metas).forEach(function (sel) {
      var el = $(sel); if (el) el.setAttribute("content", metas[sel]);
    });

    // topbar brand
    var brand = $(".brand");
    if (a.logo_url) {
      brand.innerHTML = '<img src="' + a.logo_url + '" alt="' + a.brand_name +
        '" style="height:40px;max-width:150px;object-fit:contain">';
    } else {
      brand.querySelector("b").textContent = a.brand_name || a.name;
      brand.querySelector("span").textContent = a.tagline || "";
    }

    // hero
    text(".hero-copy .eyebrow",
      (p.listing_type === "rent" ? "להשכרה" : "למכירה") + " · " +
      (p.neighborhood ? p.neighborhood + ", " : "") + p.city);
    var h1 = $(".hero-copy h1");
    var phrase = d.hero.phrase || p.title;
    var parts = phrase.split("\n");
    h1.innerHTML = parts.length > 1
      ? escapeHtml(parts[0]) + "<br><em>" + escapeHtml(parts.slice(1).join(" ")) + "</em>"
      : "<em>" + escapeHtml(phrase) + "</em>";
    text(".hero-copy p.sub", buildSubline(p));
    var vid = $("#walkthrough");
    vid.poster = d.hero.poster_url || "";
    vid.src = d.hero.video_url;
    vid.load();
    var pp = vid.play(); if (pp && pp.catch) pp.catch(function () {});
    var heroBg = $(".hero-bg");
    if (heroBg && d.hero.poster_url) heroBg.style.backgroundImage = "url('" + d.hero.poster_url + "')";

    // specs strip — price label + suffix depend on sale vs. rent
    var specs = $$(".spec");
    var isRent = p.listing_type === "rent";
    fillSpec(specs[0], fmtPrice(p.price) + (isRent && p.price ? " / חודש" : ""), isRent ? "שכר דירה חודשי" : "מחיר מבוקש");
    fillSpec(specs[1], p.rooms ? p.rooms + " חד׳" : "", p.size_sqm ? p.size_sqm + " מ״ר" : "");
    fillSpec(specs[2], p.floor ? "קומה " + p.floor : (p.neighborhood || p.city), p.address || "");
    fillSpec(specs[3], p.parking ? p.parking + " חניות" : "", p.parking ? "בטאבו" : "");

    // gallery
    if (d.sections.gallery && d.gallery.images.length) {
      var gal = $("#gal");
      gal.innerHTML = d.gallery.images.map(function (img, i) {
        return '<button class="gal-item" data-cap="' + escapeAttr(img.caption || p.title) + '">' +
          '<img src="' + img.url + '" alt="' + escapeAttr(img.caption || "תמונה " + (i + 1)) + '" loading="lazy">' +
          (img.caption ? '<span class="cap">' + escapeHtml(img.caption) + "</span>" : "") +
          "</button>";
      }).join("");
      initLightbox();
    } else {
      hideSection("#gallery");
    }

    // carousel ("why") cards
    if (d.sections.carousel && d.carousel.slides.length) {
      $("#carousel").innerHTML = d.carousel.slides.map(function (s) {
        return '<article class="card reveal in">' +
          '<span class="num">' + escapeHtml(s.num || "") + "</span>" +
          "<h3>" + escapeHtml(s.title) + "</h3>" +
          "<p>" + escapeHtml(s.body) + "</p>" +
          (s.tag ? '<span class="tag">' + escapeHtml(s.tag) + "</span>" : "") +
          "</article>";
      }).join("");
    } else {
      hideSection("#why");
    }

    // footer + form-done: genericize the template's mock brand/name
    var fbrand = $(".fbrand");
    if (fbrand && (a.brand_name || a.name)) fbrand.textContent = a.brand_name || a.name;
    var doneSub = $("#formDone p");
    if (doneSub) doneSub.textContent = (a.name || "המתווך") + " יחזור אליכם באופן אישי בהקדם.";
    var areaSub = $('[data-edit="texts.area_sub"]');
    if (areaSub && p.city) areaSub.textContent = "אחת השכונות המבוקשות ב" + p.city + " — וזה לא במקרה.";

    // agent strip
    var initials = (a.name || "").split(" ").map(function (w) { return w[0] || ""; }).join("״").slice(0, 3);
    var avatar = $(".agent-strip .avatar");
    if (a.logo_url) {
      avatar.innerHTML = '<img src="' + a.logo_url + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">';
    } else {
      avatar.textContent = initials;
    }
    text(".agent-meta b", a.name);
    text(".agent-meta span",
      [a.brand_name, a.tagline, a.license ? "רישיון תיווך " + a.license : ""]
        .filter(Boolean).join(" · "));

    // area
    if (d.sections.area && d.area && (d.area.blurb || d.area.stats.length)) {
      var areaHead = $("#area .sec-head h2");
      if (areaHead && p.neighborhood) {
        areaHead.innerHTML = escapeHtml("השכונה: " + p.neighborhood);
      }
      var copy = $(".area-copy");
      var blurbHtml = (d.area.blurb || "").split("\n").filter(Boolean)
        .map(function (par) { return "<p>" + escapeHtml(par) + "</p>"; }).join("");
      var stopsHtml = d.area.stops.length
        ? '<div class="map-line">' + d.area.stops.map(function (s) {
            return '<div class="stop"><b>' + escapeHtml(s.label) +
              '</b><span class="min">' + escapeHtml(s.minutes) + "</span></div>";
          }).join("") + "</div>"
        : "";
      copy.innerHTML = blurbHtml + stopsHtml;
      $(".area-stats").innerHTML = d.area.stats.slice(0, 4).map(function (s) {
        var src = s.source_url
          ? '<span class="stat-src"><a href="' + escapeAttr(s.source_url) +
            '" target="_blank" rel="noopener nofollow">לפי ' + hostname(s.source_url) + "</a></span>"
          : "";
        return '<div class="astat reveal in"><b>' + escapeHtml(s.value) + "</b><span>" +
          escapeHtml(s.label) + "</span>" + src + "</div>";
      }).join("");
    } else {
      hideSection("#area");
    }

    // CTA
    text(".cta-info h2", null); // keep template layout; set below
    var ctaH = $(".cta-info h2");
    ctaH.innerHTML = escapeHtml(d.cta.headline);
    text(".cta-info p", d.cta.sub);
    if (d.cta.bullets && d.cta.bullets.length) {
      $(".trust").innerHTML = d.cta.bullets.map(function (b) {
        return '<div><span class="tick">✦</span> ' + escapeHtml(b) + "</div>";
      }).join("");
    }
    var submitBtn = $("#leadForm .btn-gold");
    if (submitBtn) submitBtn.textContent = d.cta.button_label;

    // WhatsApp links
    var waText = encodeURIComponent("היי " + (a.name || "") + ", ראיתי את הדף של " + p.title + " ואשמח לפרטים");
    $$("a.btn-wa").forEach(function (el) {
      el.href = "https://wa.me/" + a.phone + "?text=" + waText;
    });

    setState("active");
    initInteractions();
    beacon("view");
  }

  function buildSubline(p) {
    var bits = [];
    if (p.rooms) bits.push(p.rooms + " חדרים");
    if (p.size_sqm) bits.push(p.size_sqm + " מ״ר");
    if (p.floor) bits.push("קומה " + p.floor);
    var loc = p.neighborhood ? p.neighborhood + ", " + p.city : p.city;
    return bits.join(" · ") + (loc ? " — " + loc : "");
  }

  function fillSpec(el, b, span) {
    if (!el) return;
    if (!b) { el.style.display = "none"; return; }
    el.querySelector("b").textContent = b;
    el.querySelector("span").textContent = span || "";
  }

  function hideSection(sel) { var el = $(sel); if (el) el.style.display = "none"; }

  // Agent text overrides (saved from edit mode) — applied after render() so
  // they win over both template statics and derived strings.
  function applyTexts(texts) {
    if (!texts) return;
    Object.keys(texts).forEach(function (k) {
      var el = $('[data-edit="texts.' + k + '"]');
      if (el && texts[k]) el.textContent = texts[k];
    });
  }

  // Edit mode assets load only for a valid edit link — visitors never pay for them.
  function loadEditor(d) {
    var css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/p/edit.css";
    document.head.appendChild(css);
    var s = document.createElement("script");
    s.src = "/p/edit.js";
    s.onload = function () { window.FlyEdit.init(d, editToken); };
    document.body.appendChild(s);
  }

  function notice(msg) {
    var n = document.createElement("div");
    n.style.cssText = "position:fixed;bottom:18px;right:50%;transform:translateX(50%);" +
      "background:rgba(23,20,15,.94);color:#fff;padding:12px 22px;border-radius:12px;" +
      "font-size:.9rem;z-index:1200;box-shadow:0 10px 30px rgba(0,0,0,.25);text-align:center";
    n.textContent = msg;
    document.body.appendChild(n);
    setTimeout(function () { n.remove(); }, 6000);
  }

  function hostname(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return "מקור"; }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // ── interactions (from the approved template) ───────────

  function initInteractions() {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.16, rootMargin: "0px 0px -6% 0px" });
    $$(".reveal:not(.in)").forEach(function (el) { io.observe(el); });

    var topbar = $("#topbar"), sticky = $("#stickyBar"), hero = $(".hero");
    var videoWrap = $("#videoWrap");
    var scroll50 = false, scroll90 = false;
    addEventListener("scroll", function () {
      var y = scrollY;
      topbar.classList.toggle("scrolled", y > 40);
      sticky.classList.toggle("show", y > hero.offsetHeight * 0.7);
      videoWrap.style.setProperty("--parallax", (y * -0.06) + "px");
      var depth = (y + innerHeight) / document.body.scrollHeight;
      if (!scroll50 && depth > 0.5) { scroll50 = true; beacon("scroll_50"); }
      if (!scroll90 && depth > 0.9) { scroll90 = true; beacon("scroll_90"); }
    }, { passive: true });

    var vid = $("#walkthrough"), soundBtn = $("#soundBtn");
    var played = false;
    soundBtn.addEventListener("click", function () {
      vid.muted = !vid.muted;
      soundBtn.textContent = vid.muted ? "🔇" : "🔊";
    });
    vid.addEventListener("play", function () {
      if (!played) { played = true; beacon("video_play"); }
    });

    var car = $("#carousel");
    var step = function () { return Math.min(344, car.clientWidth * 0.85); };
    $("#nextBtn").addEventListener("click", function () { car.scrollBy({ left: -step(), behavior: "smooth" }); });
    $("#prevBtn").addEventListener("click", function () { car.scrollBy({ left: step(), behavior: "smooth" }); });

    initLeadForm();
  }

  function initLightbox() {
    var galItems = $$(".gal-item");
    var lb = $("#lightbox"), lbImg = $("#lbImg"), lbCap = $("#lbCap"), lbCount = $("#lbCount");
    var lbIdx = 0;
    function lbShow(i) {
      lbIdx = (i + galItems.length) % galItems.length;
      var item = galItems[lbIdx];
      lbImg.src = item.querySelector("img").src;
      lbImg.alt = item.dataset.cap || "";
      lbCap.textContent = item.dataset.cap || "";
      lbCount.textContent = (lbIdx + 1) + " / " + galItems.length;
    }
    function lbOpen(i) { lbShow(i); lb.classList.add("open"); document.body.style.overflow = "hidden"; }
    function lbClose() { lb.classList.remove("open"); document.body.style.overflow = ""; }
    galItems.forEach(function (el, i) { el.addEventListener("click", function () { lbOpen(i); }); });
    $("#lbClose").addEventListener("click", lbClose);
    $("#lbNext").addEventListener("click", function () { lbShow(lbIdx + 1); });
    $("#lbPrev").addEventListener("click", function () { lbShow(lbIdx - 1); });
    lb.addEventListener("click", function (e) { if (e.target === lb) lbClose(); });
    addEventListener("keydown", function (e) {
      if (!lb.classList.contains("open")) return;
      if (e.key === "Escape") lbClose();
      if (e.key === "ArrowLeft") lbShow(lbIdx + 1);
      if (e.key === "ArrowRight") lbShow(lbIdx - 1);
    });
    var touchX = null;
    lb.addEventListener("touchstart", function (e) { touchX = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener("touchend", function (e) {
      if (touchX === null) return;
      var dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) > 48) lbShow(lbIdx + (dx < 0 ? 1 : -1));
      touchX = null;
    }, { passive: true });
  }

  function initLeadForm() {
    var form = $("#leadForm");
    var err = document.createElement("p");
    err.className = "form-err";
    form.appendChild(err);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var name = $("#name").value.trim();
      var phone = $("#phone").value.trim();
      err.classList.remove("show");
      var btn = form.querySelector(".btn-gold");
      btn.disabled = true;
      beacon("cta_click");
      fetch("/api/property-lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_id: pageId, name: name, phone: phone }),
      }).then(function (r) {
        if (!r.ok) throw new Error("bad status " + r.status);
        form.style.display = "none";
        $("#formDone").style.display = "flex";
      }).catch(function () {
        btn.disabled = false;
        err.textContent = "משהו השתבש — נסו שוב או פנו בוואטסאפ";
        err.classList.add("show");
      });
    });
  }

  // ── boot ────────────────────────────────────────────────

  if (!pageId) { setState("notfound"); return; }
  fetch("/api/property-page?id=" + encodeURIComponent(pageId) +
      (editToken ? "&edit_token=" + encodeURIComponent(editToken) : ""))
    .then(function (r) {
      if (r.status === 404) { setState("notfound"); return null; }
      if (!r.ok) throw new Error("status " + r.status);
      return r.json();
    })
    .then(function (d) {
      if (!d) return;
      if (d.status === "expired" || d.status === "archived") {
        if (d.agent && d.agent.phone) {
          var wa = $("#expiredWa");
          wa.style.display = "inline-flex";
          wa.href = "https://wa.me/" + d.agent.phone;
        }
        if (d.agent && d.agent.name) {
          $("#expiredSub").textContent =
            "תוקף הדף הסתיים. לפרטים על הנכס אפשר לפנות ל" + d.agent.name + ".";
        }
        setState("expired");
        return;
      }
      render(d);
      applyTexts(d.texts);
      if (editToken) {
        if (d.editable) loadEditor(d);
        else notice("קישור העריכה אינו תקף — מוצג מצב צפייה בלבד");
      }
    })
    .catch(function () { setState("notfound"); });
})();
