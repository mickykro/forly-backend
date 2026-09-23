/* Forly Agent — shared API helpers. Session = httpOnly cookie; 401 → login. */
window.FLY = (function () {
  "use strict";

  function req(path, opts) {
    opts = opts || {};
    return fetch(path, {
      method: opts.method || "GET",
      credentials: "same-origin",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      if (r.status === 401 && !opts.noRedirect) {
        location.href = "/?next=" + encodeURIComponent(location.pathname + location.search);
        throw new Error("unauthenticated");
      }
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) {
          var e = new Error(data.error || ("http " + r.status));
          e.code = data.error; e.status = r.status; e.data = data;
          throw e;
        }
        return data;
      });
    });
  }

  function toast(msg) {
    var t = document.getElementById("toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "toast"; t.className = "toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  /* Upload files straight to Storage via signed URLs.
     onProgress(index, pct). Returns array of public URLs (input order). */
  function uploadFiles(files, extraHeaders, onProgress) {
    var metas = files.map(function (f) { return { name: f.name, contentType: f.type }; });
    return fetch("/api/upload-urls", {
      method: "POST",
      credentials: "same-origin",
      headers: Object.assign({ "Content-Type": "application/json" }, extraHeaders || {}),
      body: JSON.stringify({ files: metas }),
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || "upload init failed"); });
      return r.json();
    }).then(function (d) {
      return Promise.all(d.files.map(function (slot, i) {
        return new Promise(function (resolve, reject) {
          var xhr = new XMLHttpRequest();
          xhr.open(slot.method || "PUT", slot.upload_url);
          xhr.setRequestHeader("Content-Type", slot.content_type);
          xhr.upload.onprogress = function (e) {
            if (e.lengthComputable && onProgress) onProgress(i, Math.round(e.loaded / e.total * 100));
          };
          xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300) resolve(slot.public_url);
            else reject(new Error("upload failed " + xhr.status));
          };
          xhr.onerror = function () { reject(new Error("upload network error")); };
          xhr.send(files[i]);
        });
      }));
    });
  }

  /* Delete a previously uploaded file by its public URL (best-effort — a
     backend without a delete endpoint just leaves the orphan file). */
  function deleteUpload(publicUrl, extraHeaders) {
    var m = String(publicUrl || "").match(/\/files\/([0-9a-f-]{36}\.[a-z0-9]+)$/i);
    if (!m) return Promise.resolve();
    return fetch("/api/upload/" + m[1], {
      method: "DELETE",
      credentials: "same-origin",
      headers: extraHeaders || {},
    }).catch(function () { /* best-effort */ });
  }

  var PAGE_START = Date.now();

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  // ── loader video ──────────────────────────────────────────────────────────
  // The loader is off the screen as soon as the work behind it is done. It used
  // to park the reveal until the clip reached a clean "ended", which charged
  // every visitor a whole 5s cycle even when the API answered in 200ms — and a
  // second cycle when the hide landed just after a loop restart. Now the clip is
  // decoration over the real wait: it is cut off wherever it happens to be, with
  // a short crossfade so the cut does not read as a flicker.
  var LOADER_MIN_MS = 350;    // anti-flicker floor for very fast responses
  var LOADER_FADE_MS = 160;   // must match the .vloader opacity transition
  // How long one pass of the animation should take. The source clip is 5.04s,
  // which is longer than most waits, so the cut lands early in the stroke every
  // time. Speeding it up means a typical wait shows a whole pass instead of the
  // opening few frames. Tune here, not in the asset.
  var LOADER_CYCLE_MS = 2300;
  var CLIP_MS = 5042;         // /assets/loading.mp4, used until metadata lands

  function loaderBox() { return document.querySelector(".vloader"); }

  // playbackRate resets whenever the element reloads its source, so pin
  // defaultPlaybackRate too and re-apply on show.
  function loaderPace(v) {
    if (!v) return;
    var srcMs = (v.duration > 0 && isFinite(v.duration)) ? v.duration * 1000 : CLIP_MS;
    var rate = srcMs / LOADER_CYCLE_MS;
    if (rate < 0.25) rate = 0.25;
    if (rate > 4) rate = 4; // browsers drop audio past ~4x; muted here, but stay sane
    try { v.defaultPlaybackRate = rate; v.playbackRate = rate; } catch (e) { /* ignore */ }
  }

  // Some Safari setups never play the clip (Low Power Mode or a per-site
  // "never auto-play" setting reject play(); some builds just stall on the
  // first frame). An animated image is not subject to autoplay rules, so the
  // loader swaps to /assets/loading.webp — the same clip, pre-paced to one
  // 2.3s pass — whenever the video will not run.
  var FALLBACK_SRC = "/assets/loading.webp";
  function loaderFallback(v) {
    if (!v || !v.parentNode || !v.replaceWith || typeof document.createElement !== "function") return;
    var img = document.createElement("img");
    img.src = FALLBACK_SRC; img.alt = ""; img.setAttribute("aria-hidden", "true");
    try { v.pause(); } catch (e) { /* ignore */ }
    v.replaceWith(img);
  }
  function loaderPlay(v) {
    var p = v.play();
    if (p && p.catch) p.catch(function (e) { if (e && e.name === "NotAllowedError") loaderFallback(v); });
  }

  // Watchdog while the loader is up: if currentTime stops moving, drop the
  // pacing and replay, then reload the source, then fall back to the image.
  // Stops as soon as the loader hides.
  var WATCH_MS = 500;
  function loaderWatch(box, v) {
    if (!box || !v) return;
    clearInterval(box._w);
    var last = -1, strikes = 0;
    box._w = setInterval(function () {
      if (box.classList.contains("hidden") || strikes >= 3) { clearInterval(box._w); return; }
      var t = v.currentTime;
      // real movement only: a reload nudges currentTime by a hair, which must
      // not count as playing (a loop wrap back to 0 does count)
      if (Math.abs(t - last) > 0.05) { last = t; strikes = 0; return; }
      strikes++;
      if (strikes === 3) { clearInterval(box._w); loaderFallback(v); return; }
      try {
        if (strikes === 1) { v.defaultPlaybackRate = 1; v.playbackRate = 1; }
        else if (v.load) v.load();
      } catch (e) { /* ignore */ }
      loaderPlay(v);
    }, WATCH_MS);
    if (box._w && box._w.unref) box._w.unref(); // node tests: don't hold the process open
  }

  function loaderShow(msg) {
    var box = loaderBox();
    if (!box) return;
    clearTimeout(box._t);
    box._shownAt = Date.now();
    if (msg) {
      var m = box.querySelector(".vloader-msg");
      if (m) m.textContent = msg;
    }
    box.classList.remove("vloader-out");
    box.classList.remove("hidden");
    var v = box.querySelector("video");
    // currentTime throws if metadata has not loaded yet — the reset is cosmetic.
    if (v) { try { v.currentTime = 0; } catch (e) { /* not seekable yet */ }
             loaderPace(v);
             loaderPlay(v);
             loaderWatch(box, v); }
  }

  // then() runs after the loader is gone — put the "reveal the content" work there.
  function loaderHide(then) {
    var box = loaderBox();
    // Nothing on screen to wait for.
    if (!box || box.classList.contains("hidden")) { if (then) then(); return; }

    var finish = function () {
      box.classList.add("hidden");
      box.classList.remove("vloader-out");
      var v = box.querySelector("video");
      // Stop decoding a clip nobody can see.
      if (v && v.pause) { try { v.pause(); } catch (e) { /* ignore */ } }
      if (then) then();
    };

    var fade = function () {
      box.classList.add("vloader-out");
      box._t = setTimeout(finish, LOADER_FADE_MS);
    };

    // Loaders that are up from first paint have no _shownAt — page start counts.
    var shownAt = box._shownAt || PAGE_START;
    var left = LOADER_MIN_MS - (Date.now() - shownAt);
    clearTimeout(box._t);
    if (left <= 0) return fade();
    box._t = setTimeout(fade, left);
  }

  document.addEventListener("DOMContentLoaded", function () {
    // Looping is driven here rather than by the `loop` attribute so the clip can
    // be swapped for one that reports "ended"; a hide never waits on it.
    document.querySelectorAll(".vloader video").forEach(function (v) {
      loaderPace(v); // the clip is already autoplaying: pace it now
      v.addEventListener("error", function () { loaderFallback(v); }); // can't decode/load
      var box0 = v.closest(".vloader");
      if (box0 && !box0.classList.contains("hidden")) { // up from first paint
        loaderPlay(v); // autoplay fails silently; an explicit play() reports why
        loaderWatch(box0, v);
      }
      v.addEventListener("loadedmetadata", function () { loaderPace(v); });
      v.addEventListener("ended", function () {
        var box = v.closest(".vloader");
        if (box && box.classList.contains("hidden")) return;
        v.currentTime = 0;
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
      });
    });
    guardCreateLinks();
  });

  // ── quota guard on "new property" links ───────────────────────────────────
  // Every link to /create.html first asks /api/quota/me about the agent's
  // walkthroughs bundle: an exhausted bundle gets a popup (used/cap + payment
  // link) instead of the create form. Fails open on a network error — the
  // server enforces the cap on submit regardless, this only saves the agent
  // filling in a form they can't submit.
  var CREATE_KIND = "walkthroughs";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function quotaBlockedDialog(q) {
    var k = (q && q.kinds && q.kinds[CREATE_KIND]) || {};
    var pay = q && q.payment_url;
    var dlg = document.getElementById("quotaGuardDlg");
    if (!dlg) {
      var st = document.createElement("style");
      st.textContent = "#quotaGuardDlg::backdrop{background:rgba(20,17,12,.45);backdrop-filter:blur(2px)}";
      document.head.appendChild(st);
      dlg = document.createElement("dialog");
      dlg.id = "quotaGuardDlg";
      dlg.setAttribute("dir", "rtl");
      // Explicit centering. Two things fight the browser's default centering:
      // the app's `*{margin:0}` reset cancels dialog{margin:auto}, and the UA
      // sets all four insets to 0 — in an RTL element an over-constrained box
      // resolves to `right`, so top/left alone still snapped it to the right
      // edge. right/bottom:auto removes the conflict in both directions.
      dlg.style.cssText = "position:fixed;top:50%;left:50%;right:auto;bottom:auto;transform:translate(-50%,-50%);margin:0;" +
        "width:min(440px,92vw);max-height:calc(100vh - 32px);overflow:auto;" +
        "border:1px solid rgba(185,138,47,.35);border-radius:18px;padding:0;" +
        "background:var(--paper,#fffdf9);color:var(--ink,#17140f);font:inherit;box-shadow:0 30px 80px rgba(20,17,12,.28)";
      document.body.appendChild(dlg);
    }
    dlg.innerHTML =
      '<div style="padding:26px 26px 22px;text-align:center">' +
        '<div style="font-size:2.2rem;margin-bottom:6px">🔒</div>' +
        '<h3 style="font-family:var(--serif,serif);font-size:1.25rem;margin:0 0 8px">המכסה ליצירת נכסים נוצלה</h3>' +
        '<p style="color:var(--ink-soft,#6b6357);font-weight:300;margin:0;line-height:1.65">' +
          'השתמשת ב-<b dir="ltr">' + esc(k.used || 0) + " / " + (k.cap == null ? "∞" : esc(k.cap)) + "</b> " +
          esc(k.label || "יצירות נכס") + " בחבילה שלך.<br>" +
          (pay ? "לרכישת חבילה נוספת לחצו על הכפתור — אחרי התשלום נעדכן את החשבון."
               : "לרכישת חבילה נוספת דברו איתנו — אחרי התשלום נעדכן את החשבון.") +
        "</p>" +
        '<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:18px">' +
          (pay ? '<a class="btn btn-gold" target="_blank" rel="noopener" href="' + esc(pay) + '">רכישת חבילה</a>' : "") +
          '<button type="button" class="btn btn-ghost" data-close>סגירה</button>' +
        "</div>" +
      "</div>";
    dlg.querySelector("[data-close]").onclick = function () { dlg.close ? dlg.close() : dlg.removeAttribute("open"); };
    if (typeof dlg.showModal === "function") { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute("open", "");
  }

  function guardCreateLinks(root) {
    (root || document).querySelectorAll('a[href^="/create.html"]').forEach(function (a) {
      if (a._quotaGuarded) return;
      a._quotaGuarded = true;
      a.addEventListener("click", function (ev) {
        ev.preventDefault();
        var href = a.getAttribute("href");
        a.style.opacity = ".6"; a.style.pointerEvents = "none";
        req("/api/quota/me").then(function (q) {
          var k = q && q.kinds && q.kinds[CREATE_KIND];
          if (k && k.exhausted) quotaBlockedDialog(q);
          else location.href = href;
        }).catch(function (e) {
          if (e && e.message === "unauthenticated") return;   // req() already redirected to login
          location.href = href;                                 // fail open
        }).then(function () { a.style.opacity = ""; a.style.pointerEvents = ""; });
      });
    });
  }

  return { req: req, toast: toast, uploadFiles: uploadFiles, deleteUpload: deleteUpload, el: el,
           loaderShow: loaderShow, loaderHide: loaderHide, esc: esc,
           guardCreateLinks: guardCreateLinks, quotaBlockedDialog: quotaBlockedDialog };
})();
