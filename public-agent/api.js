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

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  return { req: req, toast: toast, uploadFiles: uploadFiles, el: el };
})();
