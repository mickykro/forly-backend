/*
 * posting-media.js — the property's video on a Facebook post (posting-driver).
 *
 * fetchVideo(url, deps) downloads it on the server, BEFORE a browser opens: a
 * video we cannot serve never costs a session. attach(page, x, file) hands it
 * to our own composer — its file input, else its Photo/video button — as an
 * in-memory file (the Driver browser is remote: a server path means nothing
 * there). waitUploaded(page, x) waits for Facebook to finish the upload, so
 * the Post click never races it.
 *
 * Codes (all pre-submit, so nothing was posted): media_unavailable (we could
 * not fetch it), media_too_large, media_not_found (no way to attach in the
 * composer: a selector failure), media_upload_failed (never finished).
 * Selectors live in posting-driver-proof SELECTORS, all [Unverified].
 */
const fs = require("fs");
const path = require("path");
const { SELECTORS: S } = require("./posting-driver-proof");

// Playwright's cap on an in-memory file is 50 MB; stay under it.
const MAX_BYTES = 48 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60 * 1000;
const UPLOAD_TIMEOUT_MS = 4 * 60 * 1000;

// detail: what the download saw (posting-diag's failure note): the host, never the path.
// One line per stage of a video's trip, so a slow post shows WHERE it was slow:
// download, encode, handover to the remote browser, preview, Facebook's upload.
// Times and sizes only — never a URL, a phone or a page.
const since = (t0) => Date.now() - t0;
const logTiming = (stage, fields) => console.log(`posting-media: ${stage}`, JSON.stringify(fields));

const fail = (code, detail) => Object.assign(new Error(code), { code, detail: detail || null });
const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };

// A /files/ address is one of our own uploads (index.js serves UPLOAD_DIR
// there). When this server holds the file it is read from disk: no egress,
// and it survives the host it was stored under going away (a dev tunnel).
function ownFile(url, deps = {}) {
  let p;
  try { p = decodeURIComponent(new URL(url).pathname); } catch { return null; }
  if (!p.startsWith("/files/")) return null;
  const root = path.resolve(deps.uploadDir || process.env.UPLOAD_DIR || path.join(__dirname, "data", "uploads"));
  const file = path.resolve(root, "." + p.slice("/files".length));
  if (!file.startsWith(root + path.sep)) return null;
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

// → { name, mimeType, buffer }. Throws { code } on anything short of a video.
async function fetchVideo(url, deps = {}) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw fail("media_unavailable", { why: "not an http(s) address" });
  if (typeof deps.fetchMedia === "function") return deps.fetchMedia(url);
  const host = hostOf(url);
  const own = ownFile(url, deps);
  const t0 = Date.now();
  if (own) {
    const bytes = fs.statSync(own).size;
    if (!bytes) throw fail("media_unavailable", { host, why: "empty file" });
    if (bytes > MAX_BYTES) throw fail("media_too_large", { host, bytes, max_bytes: MAX_BYTES, why: "larger than the upload limit" });
    const mov = /\.mov$/i.test(own);
    return shrinkTimed({ name: `property.${mov ? "mov" : "mp4"}`, mimeType: mov ? "video/quicktime" : "video/mp4", buffer: fs.readFileSync(own) }, deps, "disk", since(t0));
  }
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" }); }
  catch (e) { throw fail("media_unavailable", { host, why: `no response (${(e && (e.cause && e.cause.code || e.name)) || "error"})` }); }
  const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const seen = { host, http: res.status, type: type || null, bytes: Number(res.headers.get("content-length")) || null, max_bytes: MAX_BYTES };
  if (!res.ok) throw fail("media_unavailable", { ...seen, why: `HTTP ${res.status}` });
  if (type && !type.startsWith("video/") && type !== "application/octet-stream") throw fail("media_unavailable", { ...seen, why: `not a video (${type})` });
  if (Number(res.headers.get("content-length")) > MAX_BYTES) throw fail("media_too_large", { ...seen, why: "larger than the upload limit" });
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw fail("media_unavailable", { ...seen, why: "empty file" });
  if (buffer.length > MAX_BYTES) throw fail("media_too_large", { ...seen, bytes: buffer.length, why: "larger than the upload limit" });
  const mimeType = type.startsWith("video/") ? type : "video/mp4";
  // Re-encoded light once per video (posting-video): every post uploads it, and Driver bills the bytes.
  return shrinkTimed({ name: `property.${mimeType === "video/quicktime" ? "mov" : "mp4"}`, mimeType, buffer }, deps, "http", since(t0));
}

async function shrinkTimed(file, deps, source, fetchMs) {
  const t0 = Date.now();
  const out = await require("./posting-video").shrink(file, deps);
  logTiming("video ready", { source, fetch_ms: fetchMs, shrink_ms: since(t0), source_bytes: file.buffer.length, bytes: out.buffer.length });
  return out;
}

const countOf = (page, sel) => page.locator(sel).count().catch(() => 0);
// How many of each thing the attach step looks for were on the page.
const mediaCounts = async (page) => ({ file_input: await countOf(page, S.mediaInput), photo_video_button: await countOf(page, S.mediaButton),
  add_photos_area: await countOf(page, S.mediaDrop), video_preview: await countOf(page, S.mediaAttached), progress_bar: await countOf(page, S.mediaProgress) });

// → null when the file is in the composer, else an error code.
async function attach(page, x, file) {
  const t0 = Date.now();
  const toInput = async () => {
    if ((await countOf(page, S.mediaInput)) < 1) return false;
    await page.locator(S.mediaInput).first().setInputFiles(file);
    return true;
  };
  try {
    let done = await toInput();
    if (!done && (await countOf(page, S.mediaButton)) > 0) {
      await page.locator(S.mediaButton).first().click();
      await x.wait(page, 1, 3);
      done = await toInput();
      if (!done && (await countOf(page, S.mediaDrop)) > 0) {
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 10000 }),
          page.locator(S.mediaDrop).first().click(),
        ]);
        await chooser.setFiles(file);
        done = true;
      }
    }
    if (!done) { x.diag = { why: "no way to attach a video in the composer", counts: await mediaCounts(page) }; return "media_not_found"; }
  } catch (e) { x.diag = { why: `attaching threw (${(e && e.name) || "error"})`, counts: await mediaCounts(page) }; return "media_not_found"; }
  const handoverMs = since(t0);
  const seen = await page.locator(S.mediaAttached).first().waitFor({ timeout: 120000 }).then(() => true, () => false); // the file travels to a remote browser first
  logTiming("video attached", { handover_ms: handoverMs, preview_ms: since(t0), preview: seen, bytes: file && file.buffer ? file.buffer.length : null });
  if (!seen) x.diag = { why: "the file was handed over but no video preview appeared in 120 s", counts: await mediaCounts(page) };
  return seen ? null : "media_upload_failed";
}

// → null once the upload is done (no progress bar, Post enabled), else a code.
async function waitUploaded(page, x, timeoutMs = UPLOAD_TIMEOUT_MS) {
  const t0 = Date.now();
  const until = t0 + timeoutMs;
  while (Date.now() < until) {
    const busy = await countOf(page, S.mediaProgress);
    const disabled = await page.locator(S.submit).first().getAttribute("aria-disabled").catch(() => null);
    if (busy === 0 && disabled !== "true" && (await countOf(page, S.mediaAttached)) > 0) {
      logTiming("video uploaded", { upload_ms: since(t0), ok: true });
      return null;
    }
    await x.wait(page, 1, 2);
  }
  logTiming("video uploaded", { upload_ms: since(t0), ok: false });
  x.diag = { why: `the upload did not finish in ${Math.round(timeoutMs / 1000)} s`, counts: await mediaCounts(page),
    post_disabled: await page.locator(S.submit).first().getAttribute("aria-disabled").catch(() => null) };
  return "media_upload_failed";
}

/*
 * The manual tab (routes/admin-manual.js): the admin, not the server, clicks
 * Post, so nothing awaits Facebook's upload there. This watches it in the
 * background and logs when the preview appeared and when the progress bar
 * went away. Never throws, never blocks, never keeps the process alive.
 */
const WATCH_MAX_MS = 30 * 60 * 1000;
const WATCH_EVERY_MS = 2000;
function watchUpload(page, { maxMs = WATCH_MAX_MS, everyMs = WATCH_EVERY_MS } = {}) {
  const t0 = Date.now();
  let previewMs = null;
  const done = (fields) => { logTiming("manual video upload", fields); return fields; };
  // → the logged fields (for tests); the route does not wait for it.
  return new Promise((resolve) => {
    const later = () => { const t = setTimeout(tick, everyMs); if (t.unref) t.unref(); };
    const tick = async () => {
      try {
        if (!page || (page.isClosed && page.isClosed())) return resolve(done({ ok: false, why: "page closed", preview_ms: previewMs, elapsed_ms: since(t0) }));
        if (previewMs === null && (await countOf(page, S.mediaAttached)) > 0) previewMs = since(t0);
        if (previewMs !== null && (await countOf(page, S.mediaProgress)) === 0) return resolve(done({ ok: true, preview_ms: previewMs, upload_ms: since(t0) }));
        if (since(t0) >= maxMs) return resolve(done({ ok: false, why: previewMs === null ? "no preview seen" : "still uploading", preview_ms: previewMs, elapsed_ms: since(t0) }));
      } catch (e) { return resolve(null); }
      later();
    };
    later();
  });
}

module.exports = { fetchVideo, attach, waitUploaded, watchUpload, MAX_BYTES };
