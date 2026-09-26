/*
 * dev-driver.dom.test.js — the local Driver monitor in a real Chromium
 * against a stub API (no network): every live browser gets a tile showing
 * it, input goes to that browser's own route, an ended one leaves the grid.
 * Skipped, saying so, when no Chromium binary is found.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const express = require("express");

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
  if (!exe) { console.log("dev-driver.dom.test.js skipped (no Chromium binary)"); return; }
  const { chromium } = require("patchright");
  let browser;
  try { browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] }); }
  catch { console.log("dev-driver.dom.test.js skipped (launch failed)"); return; }

  const p0 = await browser.newPage();
  const JPEG = (await p0.evaluate(() => { const c = document.createElement("canvas"); c.width = 800; c.height = 600; c.getContext("2d").fillRect(0, 0, 800, 600); return c.toDataURL("image/jpeg"); })).split(",")[1];
  await p0.close();

  let sessions = [
    { sessionId: "sA", note: "forly-local-extract:job1", platform: "job1", startedAt: new Date().toISOString(), viewer_available: true },
    { sessionId: "sB", note: "forly-local-post:facebook", platform: "facebook", startedAt: new Date().toISOString(), viewer_available: true },
  ];
  const inputs = [];
  const app = express(); app.use(express.json());
  app.get("/api/dev/driver/sessions", (q, r) => r.json({ sessions }));
  app.get("/api/dev/driver/sessions/:id/view", (q, r) => {
    r.writeHead(200, { "Content-Type": "text/event-stream" });
    r.write(`data: ${JSON.stringify({ t: "frame", d: JPEG, w: 800, h: 600, u: `https://example.com/${q.params.id}` })}\n\n`);
  });
  app.post("/api/dev/driver/sessions/:id/view/input", (q, r) => { inputs.push([q.params.id, q.body]); r.json({}); });
  app.use(express.static(path.join(__dirname, "..", "public-agent")));
  const srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${srv.address().port}/dev-driver.html`);
    await page.waitForFunction(() => document.querySelectorAll(".tile .cv-img:not([hidden])").length === 2, null, { timeout: 8000 });
    const heads = await page.locator(".tile header b").allTextContents();
    assert.deepEqual(heads, ["forly-local-extract:job1", "forly-local-post:facebook"]);
    assert.deepEqual(await page.locator(".tile .cv-url").allTextContents(), ["https://example.com/sA", "https://example.com/sB"]);

    // A click in the second tile goes to the second browser.
    const box = await page.locator(".tile").nth(1).locator(".cv-img").boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 20 && !inputs.length; i++) await page.waitForTimeout(50);
    assert.equal(inputs[0][0], "sB"); assert.equal(inputs[0][1].t, "click");

    // Enlarge, and "Open externally" is there.
    await page.locator(".tile").nth(0).locator("button", { hasText: "Enlarge" }).click();
    assert.ok(await page.locator(".tile.big").count() === 1);
    assert.equal(await page.locator("button", { hasText: "Open externally" }).count(), 2);

    // An ended browser leaves the grid at the next poll.
    sessions = sessions.slice(1);
    await page.waitForFunction(() => document.querySelectorAll(".tile").length === 1, null, { timeout: 8000 });
    assert.deepEqual(await page.locator(".tile header b").allTextContents(), ["forly-local-post:facebook"]);
    console.log("dev-driver.dom.test.js ok");
  } finally { await browser.close(); srv.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
