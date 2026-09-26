/* posting-media.js in real Chromium, driven over CDP the way the Driver
   browser is (connectOverCDP): the video reaches our composer through its
   file input, its Photo/video button, or the file chooser; the Post click
   waits for the upload. fetchVideo against a local server. No network.
   Skipped, saying so, when no Chromium binary is found. */
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const M = require("./posting-media");

function findChromium() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers"].filter(Boolean)) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse(); } catch { continue; }
    for (const d of dirs) { const exe = path.join(root, d, "chrome-linux", "chrome"); if (fs.existsSync(exe)) return exe; }
  }
  return null;
}

// A composer like ours: the editor and Post inside one dialog. `wire` makes an
// input show a preview and a progress bar, then enable Post (or never, stuck).
const WIRE = `<script>
function wire(inp, stuck) {
  inp.addEventListener("change", () => {
    const f = inp.files[0]; document.body.dataset.got = JSON.stringify({ name: f.name, type: f.type, size: f.size });
    document.getElementById("prev").innerHTML = '<video></video><div role="progressbar"></div>';
    if (!stuck) setTimeout(() => { document.querySelector('[role="progressbar"]').remove(); document.getElementById("post").removeAttribute("aria-disabled"); }, 300);
  });
}
</script>`;
const dialog = (inner) => `${WIRE}<div role="dialog"><div contenteditable="true" role="textbox"></div>${inner}<div id="prev"></div>` +
  `<div id="post" aria-label="Post" role="button" aria-disabled="true">Post</div></div>`;
const FIXTURES = {
  input: dialog(`<input type="file" accept="video/*" style="display:none">`) + `<script>wire(document.querySelector("input"))</script>`,
  button: dialog(`<div aria-label="Photo/video" role="button" id="pv">Photo/video</div>`) +
    `<script>pv.onclick = () => { const i = document.createElement("input"); i.type = "file"; i.style.display = "none"; pv.after(i); wire(i); };</script>`,
  chooser: `<input type="file" id="hid" style="display:none">` + dialog(`<div aria-label="Photo/video" role="button" id="pv">Photo/video</div>`) +
    `<script>wire(hid); pv.onclick = () => { const d = document.createElement("div"); d.setAttribute("role", "button"); d.textContent = "Add photos/videos"; d.onclick = () => hid.click(); pv.after(d); };</script>`,
  stuck: dialog(`<input type="file" style="display:none">`) + `<script>wire(document.querySelector("input"), true)</script>`,
  none: dialog(""),
};

(async () => {
  // ── fetchVideo: a video, and every way it is not one ──
  const srv = http.createServer((q, r) => {
    if (q.url === "/v.mp4") { r.writeHead(200, { "Content-Type": "video/mp4" }); return r.end(Buffer.from("fake-mp4")); }
    if (q.url === "/page") { r.writeHead(200, { "Content-Type": "text/html" }); return r.end("<html>"); }
    if (q.url === "/big") { r.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(M.MAX_BYTES + 1) }); r.write("x"); return setTimeout(() => r.destroy(), 50); }
    r.writeHead(404); r.end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const v = await M.fetchVideo(`${base}/v.mp4`);
  assert.deepEqual([v.name, v.mimeType, v.buffer.toString()], ["property.mp4", "video/mp4", "fake-mp4"]);
  const codeOf = (p) => p.then(() => "ok", (e) => e.code);
  assert.equal(await codeOf(M.fetchVideo(`${base}/page`)), "media_unavailable", "not a video");
  assert.equal(await codeOf(M.fetchVideo(`${base}/gone`)), "media_unavailable", "404");
  assert.equal(await codeOf(M.fetchVideo(`${base}/big`)), "media_too_large");
  assert.equal(await codeOf(M.fetchVideo("file:///etc/passwd")), "media_unavailable", "http(s) only");
  srv.close();

  const exe = findChromium();
  if (!exe) { console.log("posting-media.dom.test.js skipped (no Chromium binary)"); return; }
  const { chromium } = require("patchright");
  const port = 9300 + Math.floor(Math.random() * 500);
  let local, browser;
  try {
    local = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", `--remote-debugging-port=${port}`] });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  } catch { if (local) await local.close(); console.log("posting-media.dom.test.js skipped (launch failed)"); return; }
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    const page = await ctx.newPage();
    const x = { wait: (p) => p.waitForTimeout(100) };
    const file = { name: "property.mp4", mimeType: "video/mp4", buffer: Buffer.from("fake-mp4") };
    for (const how of ["input", "button", "chooser"]) {
      await page.setContent(`<html><body>${FIXTURES[how]}</body></html>`);
      assert.equal(await M.attach(page, x, file), null, how);
      assert.deepEqual(JSON.parse(await page.getAttribute("body", "data-got")), { name: "property.mp4", type: "video/mp4", size: 8 }, `${how}: the file arrived in the page`);
      assert.equal(await page.getAttribute("#post", "aria-disabled"), "true", `${how}: still uploading`);
      assert.equal(await M.waitUploaded(page, x, 5000), null, `${how}: uploaded`);
      assert.equal(await page.getAttribute("#post", "aria-disabled"), null);
    }
    await page.setContent(`<html><body>${FIXTURES.stuck}</body></html>`);
    assert.equal(await M.attach(page, x, file), null);
    assert.equal(await M.waitUploaded(page, x, 1500), "media_upload_failed", "an upload that never finishes");
    await page.setContent(`<html><body>${FIXTURES.none}</body></html>`);
    assert.equal(await M.attach(page, x, file), "media_not_found");
    console.log("posting-media.dom.test.js ok");
  } finally { await browser.close().catch(() => {}); await local.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
