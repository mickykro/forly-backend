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

  let JPEG = "";
  {
    const p0 = await browser.newPage();
    JPEG = (await p0.evaluate(() => { const c = document.createElement("canvas"); c.width = 800; c.height = 600; const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, 800, 600); return c.toDataURL("image/jpeg"); })).split(",")[1];
    await p0.close();
  }
  const mode = {};
  const app = express(); app.use(express.json());
  app.get("/api/distribution/status", (q, r) => r.json({ entitled: true, connected: false, groups: [] }));
  app.get("/api/distribution/group-catalog", (q, r) => r.json({ groups: [] }));
  app.get("/api/connections/browser/:p/status", (q, r) => (mode.status === 200 ? r.json({ state: "connected" }) : mode.status === "open" ? r.json({ state: "open" }) : r.status(mode.status || 500).json({ error: "internal" })));
  const seen = { starts: 0, inputs: [], views: 0 };
  let streams = [];
  app.post("/api/connections/browser/start", (q, r) => {
    seen.starts++;
    if (mode.start === "network") return q.socket.destroy();
    if (mode.start === 404) return r.status(404).send("<html>Not Found</html>");
    if (mode.start === 200) { if (mode.afterStart) Object.assign(mode, mode.afterStart); return r.json({ platform: q.body.platform, expires_in: 1500 }); }
    r.status(mode.start).json(mode.body);
  });
  app.get("/api/connections/browser/:p/view", (q, r) => {
    seen.views++;
    if (mode.view === "expired") return r.status(409).json({ error: "session_expired" });
    r.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    r.write(": open\n\n");
    r.write(`data: ${JSON.stringify({ t: "frame", d: JPEG, w: 800, h: 600, u: "https://www.madlan.co.il/" })}\n\n`);
    streams.push(r);
    q.on("close", () => { streams = streams.filter((x) => x !== r); });
  });
  app.post("/api/connections/browser/:p/view/input", (q, r) => { seen.inputs.push(q.body); r.json(q.body.t === "click" ? { editable: true } : {}); });
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
    // No window is ever opened: the login browser shows inside the modal.
    await page.evaluate(() => { window.__opens = 0; const o = window.open; window.open = (...a) => { window.__opens++; return o.apply(window, a); }; }, undefined, {}, false);
    const reset = (m) => { Object.keys(mode).forEach((k) => delete mode[k]); Object.assign(mode, m); seen.inputs.length = 0; seen.starts = 0; seen.views = 0; };
    // ── a failed start: the label is back, nothing opened ──
    reset({ start: 503, body: { error: "driver_busy" }, status: 500 });
    await page.check("#browserConsent_madlan"); await page.click("#browserConnectBtn_madlan");
    await page.waitForFunction(() => !/פותחים/.test(document.getElementById("browserConnectBtn_madlan").textContent));
    assert.equal((await page.textContent("#browserConnectBtn_madlan")).trim(), "חיבור החשבון");
    assert.ok(await page.isHidden("#browserModal"));

    // ── Madlan: the browser shows in the modal, with Madlan's steps ──
    reset({ start: 200, status: 500, afterStart: { status: "open" } });
    await page.click("#browserConnectBtn_madlan");
    await page.waitForSelector("#browserModal:not([hidden])");
    await page.waitForSelector(".cv-img:not([hidden])", { timeout: 5000 });
    assert.equal((await page.textContent("#browserModalTitle")).trim(), "התחברות למדלן");
    assert.ok((await page.textContent("#browserModalSub")).includes("מדלן"));
    const body = await page.textContent("#browserModalBody");
    assert.ok(body.includes("עמוד הבית של מדלן") && body.includes("הרשמה/התחברות"), "Madlan's own steps name its sign-in button");
    assert.ok((await page.getAttribute(".cv-img", "src")).startsWith("data:image/jpeg;base64,"));
    assert.equal(await page.textContent(".cv-url"), "https://www.madlan.co.il/");
    const box = await page.locator(".cv-img").boundingBox();
    assert.ok(box.width > 300 && box.height > 200, `the page is shown at a usable size (${box.width}x${box.height})`);

    // A click is sent as fractions of the frame; typing follows it.
    await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.5);
    await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains("cv-keys"));
    await page.keyboard.type("שלום a");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const click = seen.inputs.find((i) => i.t === "click");
    assert.ok(click && Math.abs(click.x - 0.25) < 0.02 && Math.abs(click.y - 0.5) < 0.02, JSON.stringify(click));
    assert.equal(seen.inputs.filter((i) => i.t === "text").map((i) => i.text).join(""), "שלום a");
    const keys = seen.inputs.filter((i) => i.t === "key").map((i) => i.key);
    assert.deepEqual(keys, ["Backspace", "Enter"]);
    // Press and hold (a bot check's "לחץ והחזק"): down, moves, up — no click.
    seen.inputs.length = 0;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(600);
    await page.mouse.move(box.x + box.width / 2 + 3, box.y + box.height / 2);
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(200);
    const holdSeq = seen.inputs.map((i) => i.t);
    assert.equal(holdSeq[0], "down"); assert.equal(holdSeq[holdSeq.length - 1], "up");
    assert.ok(!holdSeq.includes("click"), JSON.stringify(holdSeq));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(200);
    const wheel = seen.inputs.find((i) => i.t === "wheel");
    assert.ok(wheel && wheel.dy === 400, JSON.stringify(wheel));
    assert.equal(await page.evaluate(() => window.__opens, undefined, {}, false), 0, "no window opened");

    // ── the session ends at Driver while watching: the modal says so ──
    streams.forEach((r) => r.end(`data: ${JSON.stringify({ t: "end", reason: "session_ended" })}\n\n`));
    await page.waitForFunction(() => /עבר יותר מדי זמן/.test(document.getElementById("browserModalMsg").textContent));
    await page.click("#browserModalClose");
    await page.waitForTimeout(150);
    assert.equal(streams.length, 0, "closing the modal stops the stream");

    // ── an open login is resumed, not replaced: no second /start ──
    reset({ status: "open" });
    await page.waitForFunction(() => document.getElementById("browserConnectBtn_madlan").textContent === "המשך ההתחברות");
    await page.click("#browserConnectBtn_madlan");
    await page.waitForSelector(".cv-img:not([hidden])", { timeout: 5000 });
    assert.equal(seen.starts, 0, "resumed without a new browser");
    await page.click("#browserModalClose");

    // ── a recorded login that already expired opens a fresh one by itself ──
    reset({ status: "open", view: "expired", start: 200, afterStart: { view: "ok" } });
    await page.click("#browserConnectBtn_madlan");
    await page.waitForSelector(".cv-img:not([hidden])", { timeout: 5000 });
    assert.equal(seen.starts, 1, "one fresh browser");
    await page.click("#browserModalClose");
    console.log("distribution-connect.dom.test.js ok");
  } finally { await browser.close(); srv.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
