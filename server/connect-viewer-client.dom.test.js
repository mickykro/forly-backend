/* public-agent/connect-viewer.js in a real Chromium: text typed while an
   earlier request is still in flight waits in the box — and must still reach
   the browser before a click that follows it (PR #145 review: "a", "bc",
   click went out as text(a), click, text(bc)). Skipped (exit 0) when no
   Chromium is found (CHROMIUM_PATH, or PLAYWRIGHT_BROWSERS_PATH / /opt/pw-browsers). */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

function findChromium() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers"].filter(Boolean)) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse(); } catch { continue; }
    for (const d of dirs) { const exe = path.join(root, d, "chrome-linux", "chrome"); if (fs.existsSync(exe)) return exe; }
  }
  return null;
}

(async () => {
  const exe = findChromium();
  if (!exe) { console.log("connect-viewer-client.dom.test.js skipped (no Chromium binary)"); return; }
  const { chromium } = require("patchright");
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const script = fs.readFileSync(path.join(__dirname, "..", "public-agent", "connect-viewer.js"), "utf8");
    // The scenario runs in the page itself (patchright evaluates in an isolated world); the result is a DOM attribute.
    await page.setContent(`<html><body><div id="box"></div><script>
      // The input endpoint answers only when released; the frame stream never answers.
      const sent = [], release = [];
      window.fetch = (url, o) => {
        if (!/\\/input$/.test(url)) return new Promise(() => {});
        sent.push(JSON.parse(o.body));
        return new Promise((ok) => release.push(() => ok({ ok: true, status: 200, json: async () => ({}) })));
      };
    </script><script>${script}</script><script>
      (async () => {
        const tick = () => new Promise((ok) => setTimeout(ok, 20));
        ForlyViewer.create(document.getElementById("box"), "/v");
        const ta = document.querySelector(".cv-keys");
        const type = (t) => { ta.value += t; ta.dispatchEvent(new Event("input")); };
        type("a"); await tick(); // goes at once and stays in flight
        type("bc"); await tick(); // waits in the box behind it
        const img = document.querySelector(".cv-img"); img.hidden = false; img.style.cssText = "width:100px;height:100px;display:block";
        for (const t of ["pointerdown", "pointerup"]) img.dispatchEvent(new PointerEvent(t, { clientX: 10, clientY: 10, pointerType: "mouse", bubbles: true }));
        for (let i = 0; i < 6; i++) { const r = release.shift(); if (r) r(); await tick(); }
        document.body.dataset.order = sent.map((e) => (e.t === "text" ? "text:" + e.text : e.t)).join(",");
      })();
    </script></body></html>`);
    await page.waitForSelector("body[data-order]", { timeout: 10000 });
    const order = (await page.getAttribute("body", "data-order")).split(",");
    assert.deepEqual(order.slice(0, 3), ["text:a", "text:bc", "click"], `typed text before the click: ${order}`);
    console.log("connect-viewer-client.dom.test.js ok");
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
