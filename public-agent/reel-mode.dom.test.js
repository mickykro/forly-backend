/*
 * reel-mode.dom.test.js — /reel (create.html in reel mode, reel-mode.js) in a real
 * Chromium against a stub API (no network): the OTP login card, then the same
 * wizard as create.html?key=demo with only the allowed differences, no admin call,
 * no x-demo-key, no added <style> or class name, and a later 401 shows the login
 * card instead of redirecting; stage 3 → the summary (the only place with a price) →
 * /api/promo/order → the building screen, and the Cardcom return. Demo-mode submit
 * still posts the same body to /api/properties/demo-create. Skipped, saying so, when no Chromium binary is found.
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
// What the pre-refactor create.html (cf85d47) posted for the listing filled by fill().
const DEMO_BODY = {"listing_type":"sale","address":"","city":"חיפה","neighborhood":"","price":1500000,"rooms":4,"size_sqm":90,"size_built":0,"size_balcony":0,"size_garden":0,"floor":0,"parking":0,"storage":false,"elevator":false,"shabbat_elevator":false,"description":"","photos_urls":["https://cdn.test/p-0.jpg","https://cdn.test/p-0.jpg","https://cdn.test/p-0.jpg","https://cdn.test/p-0.jpg"],"own_video_url":null,"theme":{"template":"original","font_title":null,"font_body":null,"font_url":null,"primary":null,"accent":null},"language":"he","agent":{"name":"דנה","brand_name":"","phone":"972501234567","phone2":null,"license":"","logo_url":null}};
const createHtml = fs.readFileSync(path.join(PUB, "create.html"), "utf8");

(async () => {
  const exe = findChromium();
  if (!exe) { console.log("reel-mode.dom.test.js skipped (no Chromium binary)"); return; }
  const { chromium } = serverRequire("patchright");
  let browser;
  try { browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] }); }
  catch { console.log("reel-mode.dom.test.js skipped (launch failed)"); return; }

  const state = { loggedIn: false, calls: [], price: 59, orders: 0 };
  const app = express(); app.use(express.json());
  app.use("/api", (q, r, next) => { state.calls.push({ method: q.method, path: q.path, body: q.body, demoKey: q.get("x-demo-key") || null }); next(); });
  app.get(/^\/reel\/?$/, (q, r) => r.sendFile(path.join(PUB, "create.html")));
  app.post("/api/promo/quote", (q, r) => (state.loggedIn ? r.json({ tier: "promo", price: state.price, phone: "972501234567" }) : r.status(401).json({ error: "unauthenticated" })));
  // 1st order: the free reel was used meanwhile (409); then a free build without a listing id
  app.post("/api/promo/order", (q, r) => (++state.orders === 1
    ? (state.price = 59, r.status(409).json({ error: "already_used", order_id: "o0" }))
    : r.json({ order_id: "o1", status: "building" })));
  app.get("/api/promo/order/:id", (q, r) => r.json({ status: "building", price: 0, listing_id: "L-" + q.params.id }));
  app.get("/api/listing-status", (q, r) => r.json({ status: "building" }));
  app.post("/api/upload-urls", (q, r) => r.json({ files: q.body.files.map((f, i) => ({ method: "PUT", upload_url: "/up/" + i, content_type: f.contentType, public_url: "https://cdn.test/p" + state.calls.length + "-" + i + ".jpg" })) }));
  app.post("/api/demo-save-agent", (q, r) => r.json({ ok: true }));
  app.post("/api/properties/demo-create", (q, r) => r.json({ listing_id: "D1" }));
  app.post("/api/promo/lead/start", (q, r) => r.json({ ok: true }));
  app.post("/api/auth/otp", (q, r) => r.json({ ok: true }));
  app.post("/api/auth/otp/verify", (q, r) => {
    if (q.body.code !== "123456") return r.status(400).json({ error: "invalid_code" });
    state.loggedIn = true; r.json({ ok: true, scope: "promo" });
  });
  app.post("/api/promo/lead", (q, r) => r.json({ ok: true }));
  app.get("/api/admin/me", (q, r) => r.json({ ok: true })); // the demo page's admin check
  app.use("/api", (q, r) => r.status(401).json({ error: "unauthenticated" }));
  app.put("/up/:i", (q, r) => r.sendStatus(200));
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
  const jpg = (n) => Array.from({ length: n }, (_, i) => ({ name: `p${i}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }));
  // the same listing on any page; set directly (some fields sit in closed panels)
  const fill = async (page, agent) => {
    await page.setInputFiles("#fileInput", jpg(4));
    await page.evaluate((agent) => {
      const set = (s, v) => { const e = document.querySelector(s); e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); };
      set("#pCity", "חיפה"); set("#pPrice", "1500000"); set("#pRooms", "4"); set("#pSqm", "90");
      set("#agName", "דנה"); if (agent) set("#agPhone", "0501234567");
    }, agent);
  };
  const submit = (page) => page.evaluate(() => document.querySelector("#submitBtn").click());
  const classes = (page) => page.evaluate(() => [...new Set([...document.querySelectorAll("[class]")].flatMap((e) => [...e.classList]))]);

  try {
    // ── the demo page, for comparison ──
    const demo = await open("/create.html?key=demo");
    const demoClasses = new Set(await classes(demo));

    // ── demo-mode submit is unchanged: same endpoint, same body (recorded from the pre-refactor create.html) ──
    await fill(demo, true);
    state.calls = [];
    await submit(demo);
    await demo.waitForSelector("#viewBuilding:not(.hidden)");
    (await classes(demo)).forEach((c) => demoClasses.add(c)); // photo tiles, steps done (set by script)
    const created = state.calls.find((c) => c.path === "/properties/demo-create");
    assert.ok(created && created.demoKey === "demo", "demo posts to demo-create with x-demo-key");
    created.body.photos_urls = created.body.photos_urls.map((u) => u.replace(/p\d+-/, "p-"));
    assert.deepStrictEqual(created.body, DEMO_BODY);
    assert.ok(!state.calls.some((c) => c.path.startsWith("/promo")), "demo never orders");
    await demo.close();
    state.calls = [];

    // ── /reel, logged out: the login card, not the wizard ──
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route("**/*", (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    await page.goto(base + "/reel");
    await page.waitForLoadState("load");
    await page.waitForSelector("#reelLogin:not(.hidden)");
    await page.evaluate(() => { document.querySelector("#reelLogin").dataset.resendSecs = "2"; }); // a short countdown
    assert.ok(!(await visible(page, "#viewForm")), "wizard hidden until logged in");
    assert.ok(await page.$eval("#rlGo", (b) => b.disabled), "terms box gates the code");
    await page.fill("#rlPhone", "050-1234567");
    await page.check("#rlTerms");
    await page.check("#rlMarketing");
    await page.click("#rlGo");
    await page.waitForSelector("#rlCodeWrap:not(.hidden)");
    // resend: locked during the 30s countdown, then re-POSTs /auth/otp
    assert.ok(await page.$eval("#rlResend", (b) => b.disabled && /שליחה חוזרת בעוד \d+ שנ׳/.test(b.textContent)), "resend locked with countdown");
    await page.waitForFunction(() => !document.querySelector("#rlResend").disabled, null, { timeout: 5000 });
    
    const otpBefore = state.calls.filter((c) => c.path === "/auth/otp").length;
    await page.click("#rlResend");
    await page.waitForFunction(() => document.querySelector("#rlErr").textContent === "שלחנו קוד חדש");
    assert.strictEqual(state.calls.filter((c) => c.path === "/auth/otp").length, otpBefore + 1, "resend calls /auth/otp again");
    assert.ok(await page.$eval("#rlResend", (b) => b.disabled), "locked again after a send");
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

    // ── stage 3 → summary (price only there) → order → building screen ──
    state.price = 0;
    const reel = await open("/reel");
    await reel.waitForSelector("#viewForm:not(.hidden)");
    await fill(reel, false);
    assert.strictEqual(await reel.$eval("#submitBtn", (b) => b.textContent), "המשך", "stage 3 says continue");
    assert.ok(!/₪\s*(0|59)\b|עלינו/.test(await reel.$eval("#viewForm", (e) => e.innerText)), "no reel price on stage 3");
    await submit(reel);
    await reel.waitForSelector("#reelSummary:not(.hidden)");
    assert.ok(!(await visible(reel, "#viewForm")), "summary in place of the form");
    assert.strictEqual(await reel.$eval("#rsPrice", (e) => e.textContent), "עלינו 🎁");
    assert.strictEqual(await reel.$eval("#rsGo", (b) => b.textContent), "המשך");
    assert.ok(await reel.$('#reelSummary a[href="/legal/terms.html#reel"]'), "cancellation/refund terms linked");
    assert.ok(!state.calls.some((c) => c.path === "/properties/demo-create" || c.path === "/properties/create"), "reel never creates directly");
    assert.deepStrictEqual((await classes(reel)).filter((c) => !demoClasses.has(c) && !declared.has(c)), [], "summary: no new class");
    assert.ok(!/לתשלום|pay/i.test(await reel.$$eval("button", (bs) => bs.map((b) => b.textContent).join("|"))), "no button says pay");

    await reel.click("#rsBack");
    await reel.waitForSelector("#viewForm:not(.hidden)");
    assert.ok(!(await visible(reel, "#reelSummary")));
    assert.deepStrictEqual(await reel.$eval("#submitBtn", (b) => [b.disabled, b.textContent]), [false, "המשך"], "back: stage 3, button live");

    await submit(reel);
    await reel.waitForSelector("#reelSummary:not(.hidden)");
    await reel.click("#rsGo");
    await reel.waitForFunction(() => document.querySelector("#rsErr").textContent === "כבר קיבלת סרטון חינם במספר הזה");
    await reel.waitForFunction(() => document.querySelector("#rsPrice").textContent === "₪59");
    assert.ok(!(await reel.$eval("#rsGo", (b) => b.disabled)), "can continue at the new price");
    const ob = state.calls.find((c) => c.path === "/promo/order").body;
    assert.strictEqual(ob.terms_accepted, true);
    assert.strictEqual(ob.photos_urls.length, 4);
    assert.deepStrictEqual([ob.city, ob.price, ob.agent.name, ob.agent.phone], ["חיפה", 1500000, "דנה", "972501234567"]);

    await reel.click("#rsGo");
    await reel.waitForSelector("#viewBuilding:not(.hidden)");
    assert.ok(state.calls.some((c) => c.path === "/promo/order/o1"), "free order: listing id from the order");
    assert.ok(!(await visible(reel, "#reelSummary")) && !(await visible(reel, "#viewForm")));
    assert.strictEqual(await reel.$eval("#groupsFrame", (f) => f.getAttribute("src")), null, "no groups iframe");
    assert.strictEqual(new URL(await reel.$eval("#createAnother", (a) => a.href)).pathname + new URL(await reel.$eval("#createAnother", (a) => a.href)).search, "/reel");
    await reel.close();

    // ── Cardcom return: failed → "לא חויבת" + lead; paid → the building screen ──
    state.calls = [];
    const failed = await open("/reel?order=o2&failed=1");
    await failed.waitForSelector("#reelSummary:not(.hidden)");
    assert.ok((await failed.$eval("#reelSummary", (e) => e.innerText)).includes("לא חויבת"));
    assert.deepStrictEqual(state.calls.find((c) => c.path === "/promo/lead").body, { stage: "payment_failed" });
    await failed.close();
    const paid = await open("/reel?order=o2");
    await paid.waitForSelector("#viewBuilding:not(.hidden)");
    assert.strictEqual(new URL(await paid.$eval("#createAnother", (a) => a.href)).search, "", "create another drops ?order=");
    await paid.close();

    // ── already logged in: straight to the wizard ──
    const again = await open("/reel/");
    await again.waitForSelector("#viewForm:not(.hidden)");
    assert.ok(!(await visible(again, "#reelLogin")));
    assert.strictEqual(await again.$eval("#agPhone", (e) => e.value), "0501234567");
    // ── loose ends: /reel?key=… never turns on the admin demo; box links go to /reel; fail box has no retry promise ──
    state.calls = [];
    const keyed = await open("/reel?key=demo");
    await keyed.waitForSelector("#viewForm:not(.hidden)");
    assert.ok(!state.calls.some((c) => c.demoKey), "no x-demo-key on /reel?key=");
    assert.deepStrictEqual(await keyed.$$eval('#doneBox a.btn-ghost, #waitBox a.btn-ghost, #failBox a.btn-ghost', (a) => a.map((x) => x.getAttribute("href"))), ["/reel", "/reel", "/reel"]);
    const failTxt = await keyed.$eval("#failBox p", (e) => e.textContent);
    assert.ok(/וואטסאפ/.test(failTxt) && !/נסו שוב/.test(failTxt), "fail text: WhatsApp, no retry");
    await keyed.close();
    console.log("reel-mode.dom.test.js OK");
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
