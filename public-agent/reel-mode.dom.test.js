/*
 * reel-mode.dom.test.js — /reel (create.html in reel mode, reel-mode.js) in a real
 * Chromium against a stub API (no network): the OTP login card, then the same
 * wizard as create.html?key=demo with only the allowed differences, no admin call,
 * no x-demo-key, no added <style> or class name, and a later 401 shows the login
 * card instead of redirecting. Skipped, saying so, when no Chromium binary is found.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const serverRequire = require("module").createRequire(path.join(__dirname, "..", "server", "package.json"));
const express = serverRequire("express");

function findChromium() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  const mac = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers", mac].filter(Boolean)) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse(); } catch { continue; }
    for (const d of dirs) {
      for (const exe of [path.join(root, d, "chrome-linux", "chrome"),
        path.join(root, d, "chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
        path.join(root, d, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")]) {
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

const PUB = __dirname;
const createHtml = fs.readFileSync(path.join(PUB, "create.html"), "utf8");

(async () => {
  const exe = findChromium();
  if (!exe) { console.log("reel-mode.dom.test.js skipped (no Chromium binary)"); return; }
  const { chromium } = serverRequire("patchright");
  let browser;
  try { browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] }); }
  catch { console.log("reel-mode.dom.test.js skipped (launch failed)"); return; }

  const state = { loggedIn: false, calls: [] };
  const app = express(); app.use(express.json());
  app.use("/api", (q, r, next) => { state.calls.push({ method: q.method, path: q.path, body: q.body, demoKey: q.get("x-demo-key") || null }); next(); });
  app.get(/^\/reel\/?$/, (q, r) => r.sendFile(path.join(PUB, "create.html")));
  app.post("/api/promo/quote", (q, r) => (state.loggedIn ? r.json({ tier: "promo", price: 59, phone: "972501234567" }) : r.status(401).json({ error: "unauthenticated" })));
  app.post("/api/promo/lead/start", (q, r) => r.json({ ok: true }));
  app.post("/api/auth/otp", (q, r) => r.json({ ok: true }));
  app.post("/api/auth/otp/verify", (q, r) => {
    if (q.body.code !== "123456") return r.status(400).json({ error: "invalid_code" });
    state.loggedIn = true; r.json({ ok: true, scope: "promo" });
  });
  app.post("/api/promo/lead", (q, r) => r.json({ ok: true }));
  app.get("/api/admin/me", (q, r) => r.json({ ok: true })); // the demo page's admin check
  app.use("/api", (q, r) => r.status(401).json({ error: "unauthenticated" }));
  app.use(express.static(PUB));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const open = async (url) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route("**/*", (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    await page.goto(base + url);
    await page.waitForLoadState("load");
    return page;
  };
  const visible = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length); }, sel);
  const classes = (page) => page.evaluate(() => [...new Set([...document.querySelectorAll("[class]")].flatMap((e) => [...e.classList]))]);

  try {
    // ── the demo page, for comparison ──
    const demo = await open("/create.html?key=demo");
    const demoClasses = new Set(await classes(demo));
    await demo.close();
    state.calls = [];

    // ── /reel, logged out: the login card, not the wizard ──
    const page = await open("/reel");
    await page.waitForSelector("#reelLogin:not(.hidden)");
    assert.ok(!(await visible(page, "#viewForm")), "wizard hidden until logged in");
    assert.ok(await page.$eval("#rlGo", (b) => b.disabled), "terms box gates the code");
    await page.fill("#rlPhone", "050-1234567");
    await page.check("#rlTerms");
    await page.check("#rlMarketing");
    await page.click("#rlGo");
    await page.waitForSelector("#rlCodeWrap:not(.hidden)");
    await page.fill("#rlCode", "000000");
    await page.click("#rlGo");
    await page.waitForFunction(() => document.querySelector("#rlErr").textContent === "הקוד שגוי");
    await page.fill("#rlCode", "123456");
    await page.click("#rlGo");
    await page.waitForSelector("#viewForm:not(.hidden)");
    assert.ok(!(await visible(page, "#reelLogin")), "login card gone");

    const start = state.calls.find((c) => c.path === "/promo/lead/start");
    assert.deepStrictEqual(start.body, { phone: "050-1234567", terms_accepted: true });
    assert.deepStrictEqual(state.calls.find((c) => c.path === "/auth/otp").body, { phone: "050-1234567", purpose: "reel" });
    assert.deepStrictEqual(state.calls.find((c) => c.path === "/promo/lead").body, { stage: "verified", marketing_consent: true });

    // ── the demo look: agent block, DEMO note (reel text), session phone read-only ──
    // the agent block sits in #manualFields (opened by an extract or "fill by hand"), as in the demo
    assert.ok(!(await page.$eval("#agentBlock", (e) => e.classList.contains("hidden"))), "agent block on");
    assert.ok(await visible(page, "#demoWorkspaceNote"), "DEMO note shown");
    assert.strictEqual(await page.$eval("#demoWorkspaceNote .demo-index", (e) => e.textContent), "REEL / 01");
    assert.strictEqual(await page.$eval("#demoWorkspaceNote strong", (e) => e.textContent), "בונים סרטון רילס ודף נכס.");
    assert.ok(!(await visible(page, "#navMyProps")), "no 'my properties'");
    assert.deepStrictEqual(await page.$eval("#agPhone", (e) => [e.value, e.readOnly, e.disabled]), ["0501234567", true, false]);
    assert.deepStrictEqual(await page.$eval("#agCC", (e) => [e.value, e.disabled, e.options.length]), ["+972", false, 1]);

    // ── the hidden list ──
    for (const s of [".video-card", "#thFontFileWrap", "#addPhone2", "#addAgent2"]) assert.ok(!(await visible(page, s)), s + " hidden");
    assert.strictEqual(await page.$$eval('#thFontTitle option[value="custom"], #thFontBody option[value="custom"]', (o) => o.length), 0, "no custom font");

    // ── no admin endpoint, no demo key, no upload delete ──
    await page.evaluate(() => FLY.deleteUpload("https://x/1.jpg"), undefined, {}, false); // the page's own world (patchright isolates by default)
    assert.ok(!state.calls.some((c) => /^\/(admin|demo-save-agent|profile)/.test(c.path)), "no admin endpoint: " + state.calls.map((c) => c.path));
    assert.ok(!state.calls.some((c) => c.demoKey), "no x-demo-key");
    assert.ok(!state.calls.some((c) => c.method === "DELETE"), "no DELETE /upload");

    // ── no new CSS, no new class names ──
    assert.strictEqual(await page.$$eval("style", (s) => s.length), (createHtml.match(/<style[\s>]/g) || []).length, "no <style> added");
    const declared = new Set([...createHtml.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)));
    const extra = (await classes(page)).filter((c) => !demoClasses.has(c) && !declared.has(c));
    assert.deepStrictEqual(extra, [], "class names absent from create.html");

    // ── a later 401 shows the login card; never /?next= ──
    await page.evaluate(() => FLY.req("/api/something").catch(() => {}), undefined, {}, false); // the page's own world (patchright isolates by default)
    await page.waitForSelector("#reelLogin:not(.hidden)");
    assert.ok(!(await visible(page, "#viewForm")), "wizard hidden again");
    assert.strictEqual(new URL(page.url()).pathname, "/reel", "no redirect");

    // ── already logged in: straight to the wizard ──
    const again = await open("/reel/");
    await again.waitForSelector("#viewForm:not(.hidden)");
    assert.ok(!(await visible(again, "#reelLogin")));
    assert.strictEqual(await again.$eval("#agPhone", (e) => e.value), "0501234567");
    console.log("reel-mode.dom.test.js OK");
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
