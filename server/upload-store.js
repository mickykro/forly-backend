/*
 * upload-store.js — where an uploaded/imported binary ends up.
 * Local dev writes to uploadDir; a deployed instance relays to the upload
 * host (REMOTE_UPLOAD_BASE). Shared by the PUT /upload route and the
 * photo URL import so both behave identically.
 */
const fs = require("fs");
const path = require("path");
const { relayUpload } = require("./upload-relay");

/*
 * The remote leg goes through relayUpload so the caller's own session is
 * forwarded and the remote — running this same code — re-authorizes the write.
 * A relayed PUT with no credentials would be rejected there anyway, so a call
 * with no `req` stores locally instead of sending an anonymous write.
 */
async function storeBuffer({ fname, buffer, contentType }, { uploadDir, remoteUploadBase, req, fetchFn = fetch }) {
  if (remoteUploadBase && req) {
    const out = await relayUpload({
      fetch: fetchFn, base: remoteUploadBase, fname, req, body: buffer, contentType,
    });
    if (out.status !== 200) { const e = new Error(out.body.error); e.status = out.status; throw e; }
    return out.body;
  }
  fs.writeFileSync(path.join(uploadDir, fname), buffer);
  return { ok: true, remote: false };
}

module.exports = { storeBuffer };
