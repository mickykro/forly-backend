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
    r.status(mode.start).json(mode.body);
  });
  app.use(express.static(path.join(__dirname, "..", "public-agent")));
  const srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
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
    console.log("distribution-connect.dom.test.js ok");
  } finally { await browser.close(); srv.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
