/* Forly Nadlan — video-story engine (Passage, Soleil). Loaded after runtime.js.
   The page scrolls over a fixed video layer (.bg). Hooks the templates use:
     [data-story-pin]        the arrival pin; its [data-at] items get .on as it scrolls
     [data-edge]             sections whose shape follows --p (0 entering → 1 landed)
     .in-view                fades in once on screen
     [data-story-highlights] carousel.slides as an auto-cycling block
       data-story-mode="accordion|window"; items are [data-hl]
     [data-story-gallery]    big stage mirrored from runtime.js's [data-gallery] tiles
   Spec: docs/superpowers/specs/2026-09-30-passage-soleil-templates-design.md */
(function () {
  "use strict";
  var reduce = matchMedia("(prefers-reduced-motion:reduce)").matches;
  var root = document.documentElement, DATA = window.__PAGE__ || window.__DEMO__ || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function clamp(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function noop() {}
  var images = (DATA.gallery && DATA.gallery.images) || [], caps = (DATA.gallery && DATA.gallery.captions) || [];

  // ── background: the video, else the poster, else the first photo ──
  var bg = $(".bg"), vid = bg && $("video", bg);
  if (bg && !(DATA.hero && DATA.hero.video_url)) {
    var still = (DATA.hero && DATA.hero.poster_url) || (images[0] && images[0].url);
    if (still) bg.style.backgroundImage = 'url("' + String(still).replace(/["\\]/g, "") + '")';
    if (vid) vid.remove();
    vid = null;
  }

  // ── scroll loop: reveal, edges, top bar, video pause under opaque panels ──
  var pin = $("[data-story-pin]"), steps = pin ? $$("[data-at]", pin) : [], phrase = pin && $(".phrase", pin);
  var edges = $$("[data-edge]"), panels = $$(".panel"), bar = $(".topbar"), ticking = false;
  function frame() {
    ticking = false;
    var vh = innerHeight;
    if (pin) {
      var r = pin.getBoundingClientRect(), p = clamp(-r.top / Math.max(1, r.height - vh));
      if (phrase) phrase.classList.toggle("off", !reduce && p > 0.04);
      steps.forEach(function (e) { e.classList.toggle("on", reduce || p >= +e.getAttribute("data-at")); });
      root.style.setProperty("--dim", Math.min(1, p * 1.6).toFixed(3));
      if (bar) bar.classList.toggle("solid", r.bottom <= bar.offsetHeight);
    }
    edges.forEach(function (s) { s.style.setProperty("--p", reduce ? 1 : clamp((vh - s.getBoundingClientRect().top) / (vh * 0.7)).toFixed(3)); });
    if (!vid) return;
    var covered = panels.some(function (s) { var b = s.getBoundingClientRect(); return b.top <= 0 && b.bottom >= vh; });
    if (covered) { if (!vid.paused) vid.pause(); }
    else if (vid.paused && vid.currentSrc) { var pl = vid.play(); if (pl && pl.catch) pl.catch(noop); }
  }
  addEventListener("scroll", function () { if (!ticking) { ticking = true; requestAnimationFrame(frame); } }, { passive: true });
  addEventListener("resize", frame);
  frame();

  // ── fade-ins ──
  if ("IntersectionObserver" in window && !reduce) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("on"); io.unobserve(e.target); } });
    }, { threshold: 0.12 });
    $$(".in-view").forEach(function (e) { io.observe(e); });
  } else $$(".in-view").forEach(function (e) { e.classList.add("on"); });

  // ── cycle: open item 0 now, then every 2.5 s while ≥30% visible; a pick restarts ──
  function cycle(el, n, show) {
    var i = 0, t, vis = false;
    function go(k) { i = (k + n) % n; show(i); }
    function restart() { clearInterval(t); if (!reduce && vis && n > 1) t = setInterval(function () { go(i + 1); }, 2500); }
    if ("IntersectionObserver" in window) new IntersectionObserver(function (es) { vis = es[0].isIntersecting; restart(); }, { threshold: 0.3 }).observe(el);
    go(0);
    return { pick: function (k) { go(k); restart(); }, step: function (d) { go(i + d); restart(); }, at: function () { return i; } };
  }
  // restart a CSS progress bar: drop .on, reflow, put it back
  function flip(list, k) {
    list.forEach(function (el, j) { if (j === k) { el.classList.remove("on"); void el.offsetWidth; } el.classList.toggle("on", j === k); });
  }

  // ── photos: the gallery tiles runtime.js builds (real <img> or demo <canvas>) ──
  var tilesHost = $("[data-gallery]");
  function tiles() { return tilesHost ? $$(":scope > button", tilesHost) : []; }
  function copyMedia(tile) {
    var m = tile && $("img,canvas", tile);
    if (!m) return null;
    if (m.tagName === "IMG") { var im = new Image(); im.src = m.currentSrc || m.src; im.alt = m.alt || ""; im.decoding = "async"; return im; }
    var c = document.createElement("canvas"); c.width = m.width; c.height = m.height;
    try { c.getContext("2d").drawImage(m, 0, 0); } catch (e) {}
    return c;
  }
  function capOf(k) { return (images[k] && images[k].caption) || caps[k] || ""; }
  var refreshers = [];
  if (tilesHost && "MutationObserver" in window) {
    new MutationObserver(function () { refreshers.forEach(function (f) { f(); }); })
      .observe(tilesHost, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  }

  // ── highlights ──
  $$("[data-story-highlights]").forEach(function (host) {
    var items = $$("[data-hl]", host);
    if (!items.length) { host.remove(); return; }
    var mode = host.getAttribute("data-story-mode"), win = $(".window", host), tag = win && $(".tag", win);
    var slots = items.map(function (it) {
      if (mode === "window" && win) { var s = document.createElement("span"); s.className = "w-img"; win.insertBefore(s, tag || null); return s; }
      return $("[data-hl-img]", it);
    });
    function fill() {
      var t = tiles(), n = t.length;
      slots.forEach(function (s, k) {
        if (!s || !n || s.firstChild) return;
        var m = copyMedia(t[(k + 1) % n]);
        if (m) s.appendChild(m);
      });
    }
    refreshers.push(fill); fill();
    var c = cycle(host, items.length, function (i) {
      flip(items, i);
      if (mode === "window") flip(slots, i);
      items.forEach(function (it, k) { var b = it.matches("button") ? it : $("button", it); if (b) b.setAttribute("aria-expanded", k === i); });
      if (tag) { var tx = $(".hl-tag", items[i]); tag.textContent = tx ? tx.textContent : ""; tag.hidden = !tag.textContent; }
    });
    items.forEach(function (it, k) { (it.matches("button") ? it : $("button", it)).addEventListener("click", function () { c.pick(k); }); });
  });

  // ── gallery: stage + thumbnails (the runtime tiles), auto-swipe 2.5 s ──
  $$("[data-story-gallery]").forEach(function (gal) {
    var track = $(".g-track", gal), count = $(".g-count", gal), cap = $(".g-cap b", gal), main = $(".g-main", gal);
    var t = tiles(), n = t.length, passthru = false;
    if (!n) { (gal.closest("section") || gal).remove(); return; }
    if (n < 2) gal.classList.add("single");
    var figs = t.map(function () { var f = document.createElement("figure"); track.appendChild(f); return f; });
    function fill() { tiles().forEach(function (tile, k) { if (figs[k] && !figs[k].firstChild) { var m = copyMedia(tile); if (m) figs[k].appendChild(m); } }); }
    refreshers.push(fill); fill();
    var c = cycle(gal, n, function (i) {
      track.style.transform = "translateX(" + (-i * 100) + "%)";
      t.forEach(function (tile, k) { tile.classList.toggle("on", k === i); });
      if (count) count.textContent = (i + 1) + " / " + n;
      if (cap) cap.textContent = capOf(i);
    });
    // a thumbnail swaps the stage instead of opening the runtime lightbox
    tilesHost.addEventListener("click", function (e) {
      if (passthru) return;
      var tile = e.target.closest("button"), k = t.indexOf(tile);
      if (k < 0) return;
      e.stopPropagation(); e.preventDefault();
      c.pick(k);
    }, true);
    // swipe the stage; a plain tap opens the lightbox at the current photo
    var x0 = null;
    main.addEventListener("pointerdown", function (e) { x0 = e.clientX; });
    main.addEventListener("pointerup", function (e) {
      if (x0 === null) return;
      var dx = e.clientX - x0; x0 = null;
      if (Math.abs(dx) > 40) { if (n > 1) c.step(dx < 0 ? 1 : -1); return; }
      passthru = true; t[c.at()].click(); passthru = false;
    });
    main.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); passthru = true; t[c.at()].click(); passthru = false; }
    });
  });
})();
