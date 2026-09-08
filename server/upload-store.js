/*
 * upload-store.js — where an uploaded/imported binary ends up.
 * Local dev writes to uploadDir; a deployed instance relays to the upload
 * host (REMOTE_UPLOAD_BASE). Shared by the PUT /upload route and the
 * photo URL import so both behave identically.
 */
const fs = require("fs");
const path = require("path");

async function storeBuffer({ fname, buffer, contentType }, { uploadDir, remoteUploadBase, fetchFn = fetch }) {
  if (remoteUploadBase) {
    let r;
    try {
      r = await fetchFn(`${remoteUploadBase}/api/upload/${fname}`, {
        method: "PUT",
        headers: { "Content-Type": contentType || "application/octet-stream" },
        body: buffer,
        signal: AbortSignal.timeout(120000),
      });
    } catch (err) { const e = new Error(`remote upload failed: ${err.message}`); e.status = 502; throw e; }
    if (!r.ok) { const e = new Error(`remote upload failed: ${r.status}`); e.status = 502; throw e; }
    return { ok: true, remote: true };
  }
  fs.writeFileSync(path.join(uploadDir, fname), buffer);
  return { ok: true, remote: false };
}

module.exports = { storeBuffer };
