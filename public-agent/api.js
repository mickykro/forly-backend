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
  });

  return { req: req, toast: toast, uploadFiles: uploadFiles, deleteUpload: deleteUpload, el: el,
           loaderShow: loaderShow, loaderHide: loaderHide };
})();
