/* The account-connect buttons on distribution.html, in real Chromium against
   a stub API: whatever a connect attempt ends in — 404 (feature off on this
   server), driver_busy, a disabled account, a dropped connection, a busy
   profile — the button comes back enabled with its real label ("חיבור החשבון"
   / "חיבור מחדש"), never stuck on "פותחים דפדפן…", and the agent sees the
   specific reason. Skips cleanly without a Chromium binary. */
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
  if (!exe) { console.log("distribution-connect.dom.test.js skipped (no Chromium binary)"); return; }
  const { chromium } = require("patchright");
  let browser;
  try { browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] }); }
  catch { console.log("distribution-connect.dom.test.js skipped (launch failed)"); return; }

  const mode = {};
  const app = express(); app.use(express.json());
  app.get("/api/distribution/status", (q, r) => r.json({ entitled: true, connected: false, groups: [] }));
  app.get("/api/distribution/group-catalog", (q, r) => r.json({ groups: [] }));
  app.get("/api/connections/browser/:p/status", (q, r) => (mode.status === 200 ? r.json({ state: "connected" }) : r.status(mode.status || 500).json({ error: "internal" })));
  app.post("/api/connections/browser/start", (q, r) => {
    if (mode.start === "network") return q.socket.destroy();
    if (mode.start === 404) return r.status(404).send("<html>Not Found</html>");
    if (mode.start === 200) return r.json({ view_url: `http://127.0.0.1:${srv.address().port}/viewer-stub` });
    r.status(mode.start).json(mode.body);
  });
  app.get("/viewer-stub", (q, r) => r.send("<html><body>viewer</body></html>"));
  app.use(express.static(path.join(__dirname, "..", "public-agent")));
  let srv = null;
  srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  try {
    const page = await browser.newPage();
    await page.route(/fonts\.(googleapis|gstatic)/, (rt) => rt.abort());
    await page.goto(`http://127.0.0.1:${srv.address().port}/distribution.html`);
    await page.waitForSelector("#browserConnectBtn_facebook");
    const cases = [
      [{ start: 404, status: 404 }, "חיבור החשבון", /לא זמין/],
      [{ start: 503, body: { error: "driver_busy" }, status: 500 }, "חיבור החשבון", /תפוסים/],
      [{ start: 409, body: { error: "posting_disabled", reason: "account_disabled" }, status: 500 }, "חיבור החשבון", /מושהה/],
      [{ start: "network", status: 500 }, "חיבור החשבון", /אין חיבור לשרת/],
      [{ start: 409, body: { error: "profile_busy" }, status: 200 }, "חיבור מחדש", /משתמשת בחשבון/],
    ];
    for (const [m, label, msg] of cases) {
      Object.keys(mode).forEach((k) => delete mode[k]); Object.assign(mode, m);
      for (const p of ["facebook", "yad2", "madlan"]) {
        await page.check(`#browserConsent_${p}`);
        await page.click(`#browserConnectBtn_${p}`);
        await page.waitForFunction((id) => !document.getElementById(id).disabled && !/פותחים/.test(document.getElementById(id).textContent), `browserConnectBtn_${p}`, { timeout: 5000 });
        await page.waitForTimeout(150); // the status refresh settles the label
        assert.equal((await page.textContent(`#browserConnectBtn_${p}`)).trim(), label, `${p} ${JSON.stringify(m)}`);
        assert.ok(msg.test(await page.textContent("#msg")), `${p} ${JSON.stringify(m)} shows its reason`);
      }
    }
    // fresh page: the earlier "connected" case taught the page that state
    Object.keys(mode).forEach((k) => delete mode[k]); mode.status = 500;
    await page.reload(); await page.waitForSelector("#browserConnectBtn_madlan");
    // ── a failed start closes the blank login window it opened on the click ──
    {
      Object.keys(mode).forEach((k) => delete mode[k]); Object.assign(mode, { start: 503, body: { error: "driver_busy" }, status: 500 });
      const popup = page.waitForEvent("popup", { timeout: 3000 }).catch(() => null);
      await page.check("#browserConsent_madlan"); await page.click("#browserConnectBtn_madlan");
      const w = await popup;
      if (w) { await w.waitForEvent("close", { timeout: 3000 }).catch(() => null); assert.ok(w.isClosed(), "the blank window is closed again on an error"); }
      assert.equal((await page.textContent("#browserConnectBtn_madlan")).trim(), "חיבור החשבון");
    }
    // ── Madlan: the window opens on the click and lands on the viewer; the
    //    modal names Madlan, gives Madlan's steps, and never says "blocked" ──
    {
      Object.keys(mode).forEach((k) => delete mode[k]); Object.assign(mode, { start: 200, status: 500 });
      const popup = page.waitForEvent("popup", { timeout: 5000 });
      await page.check("#browserConsent_madlan"); await page.click("#browserConnectBtn_madlan");
      const w = await popup;
      await w.waitForURL(/viewer-stub/, { timeout: 5000 });
      await page.waitForSelector("#browserModal:not([hidden])");
      assert.equal((await page.textContent("#browserModalTitle")).trim(), "התחברות למדלן");
      assert.ok((await page.textContent("#browserModalSub")).includes("מדלן"));
      const body = await page.textContent("#browserModalBody");
      assert.ok(body.includes("עמוד הבית של מדלן") && body.includes("כפתור ההתחברות"), "Madlan's own steps");
      assert.ok(!/חסם|לא פתח/.test(body), "no 'blocked' note when the window opened");
      assert.equal(await w.evaluate(() => window.opener), null, "the login window has no opener");
      await w.close(); await page.click("#browserModalClose");
    }
    // ── a blocked popup: the modal says so and offers a button that opens it ──
    {
      Object.keys(mode).forEach((k) => delete mode[k]); Object.assign(mode, { start: 200, status: 500 });
      await page.evaluate(() => { window.__open = window.open; window.open = () => null; }, undefined, {}, false); // main world: the page's own window.open
      await page.check("#browserConsent_yad2"); await page.click("#browserConnectBtn_yad2");
      await page.waitForSelector("#browserModal:not([hidden])");
      assert.equal((await page.textContent("#browserModalTitle")).trim(), "התחברות ליד2");
      const blockedBody = await page.textContent("#browserModalBody"); assert.ok(blockedBody.includes("לא פתח את החלון"), blockedBody);
      assert.ok(/viewer-stub/.test(await page.getAttribute("#browserReopen", "href")), "a button opens the login window");
      await page.evaluate(() => { window.open = window.__open; }, undefined, {}, false);
    }
    console.log("distribution-connect.dom.test.js ok");
  } finally { await browser.close(); srv.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
