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
const { SELECTORS: S } = require("./posting-driver-proof");

// Playwright's cap on an in-memory file is 50 MB; stay under it.
const MAX_BYTES = 48 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60 * 1000;
const UPLOAD_TIMEOUT_MS = 4 * 60 * 1000;

const fail = (code) => Object.assign(new Error(code), { code });

// → { name, mimeType, buffer }. Throws { code } on anything short of a video.
async function fetchVideo(url, deps = {}) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw fail("media_unavailable");
  if (typeof deps.fetchMedia === "function") return deps.fetchMedia(url);
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" }); }
  catch { throw fail("media_unavailable"); }
  if (!res.ok) throw fail("media_unavailable");
  const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type && !type.startsWith("video/") && type !== "application/octet-stream") throw fail("media_unavailable");
  if (Number(res.headers.get("content-length")) > MAX_BYTES) throw fail("media_too_large");
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw fail("media_unavailable");
  if (buffer.length > MAX_BYTES) throw fail("media_too_large");
  const mimeType = type.startsWith("video/") ? type : "video/mp4";
  return { name: `property.${mimeType === "video/quicktime" ? "mov" : "mp4"}`, mimeType, buffer };
}

const countOf = (page, sel) => page.locator(sel).count().catch(() => 0);

// → null when the file is in the composer, else an error code.
async function attach(page, x, file) {
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
    if (!done) return "media_not_found";
  } catch { return "media_not_found"; }
  const seen = await page.locator(S.mediaAttached).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
  return seen ? null : "media_upload_failed";
}

// → null once the upload is done (no progress bar, Post enabled), else a code.
async function waitUploaded(page, x, timeoutMs = UPLOAD_TIMEOUT_MS) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const busy = await countOf(page, S.mediaProgress);
    const disabled = await page.locator(S.submit).first().getAttribute("aria-disabled").catch(() => null);
    if (busy === 0 && disabled !== "true" && (await countOf(page, S.mediaAttached)) > 0) return null;
    await x.wait(page, 1, 2);
  }
  return "media_upload_failed";
}

module.exports = { fetchVideo, attach, waitUploaded, MAX_BYTES };
