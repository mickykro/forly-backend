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

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  // ── loader video ──────────────────────────────────────────────────────────
  // Once it starts it always plays whole cycles: loaderHide() during playback
  // parks the callback and runs it at the next clean end, so the animation is
  // never cut off mid-stroke. Looping is driven here rather than by the `loop`
  // attribute, which would suppress the "ended" event we need.
  function loaderBox() { return document.querySelector(".vloader"); }

  function loaderShow(msg) {
    var box = loaderBox();
    if (!box) return;
    box._pending = null;
    if (msg) {
      var m = box.querySelector(".vloader-msg");
      if (m) m.textContent = msg;
    }
    box.classList.remove("hidden");
    var v = box.querySelector("video");
    // currentTime throws if metadata has not loaded yet — the reset is cosmetic.
    if (v) { try { v.currentTime = 0; } catch (e) { /* not seekable yet */ }
             var p = v.play(); if (p && p.catch) p.catch(function () {}); }
  }

  // then() runs after the loader is gone — put the "reveal the content" work there.
  function loaderHide(then) {
    var box = loaderBox();
    var done = function () {
      if (box) { box.classList.add("hidden"); clearTimeout(box._safety); }
      if (then) then();
    };
    var v = box && box.querySelector("video");
    // Nothing on screen to wait for.
    if (!box || box.classList.contains("hidden") || !v) return done();
    box._pending = done;
    // A visible loader counts as started even if playback has not kicked in yet
    // (autoplay begins async). But blocked autoplay or a codec failure means
    // "ended" never fires, so never let that strand the page.
    var wait = (v.duration || 5) * 1000 - (v.currentTime || 0) * 1000 + 400;
    clearTimeout(box._safety);
    box._safety = setTimeout(function () {
      if (box._pending) { var f = box._pending; box._pending = null; f(); }
    }, Math.max(400, wait));
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll(".vloader video").forEach(function (v) {
      v.addEventListener("ended", function () {
        var box = v.closest(".vloader");
        if (box && box._pending) { var f = box._pending; box._pending = null; return f(); }
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
      dlg.style.cssText = "width:min(440px,92vw);border:1px solid rgba(185,138,47,.35);border-radius:18px;padding:0;" +
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
           loaderShow: loaderShow, loaderHide: loaderHide,
           guardCreateLinks: guardCreateLinks, quotaBlockedDialog: quotaBlockedDialog };
})();
