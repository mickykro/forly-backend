/*
 * upload-store.js — where an imported binary ends up.
 * Local dev writes to uploadDir; a deployed instance relays to the upload
 * host (REMOTE_UPLOAD_BASE), forwarding the caller's session so the remote
 * (running this same code) re-authorizes the write — see upload-relay.js.
 * Used by the photo/import-url route; PUT /upload relays directly.
 */
const fs = require("fs");
const path = require("path");
const { relayUpload } = require("./upload-relay");

async function storeBuffer({ fname, buffer, contentType }, { uploadDir, remoteUploadBase, req, fetchFn = fetch }) {
  if (remoteUploadBase) {
    const out = await relayUpload({ fetch: fetchFn, base: remoteUploadBase, fname, req, body: buffer, contentType });
    if (out.status !== 200) { const e = new Error(out.body.error); e.status = out.status; throw e; }
    return out.body;
  }
  fs.writeFileSync(path.join(uploadDir, fname), buffer);
  return { ok: true, remote: false };
}

module.exports = { storeBuffer };
