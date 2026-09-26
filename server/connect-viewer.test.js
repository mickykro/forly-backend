/*
 * connect-viewer.test.js — the in-Forly login browser relay.
 * Fakes first (frames, mapping, validation, lifecycle), then — when a
 * Chromium binary exists — the same hub against a real browser over CDP.
 */
const assert = require("assert");
const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const V = require("./connect-viewer");

function fakeBrowser() {
  const calls = [];
  const cdp = new EventEmitter();
  cdp.send = async (m, p) => { calls.push([m, p]); };
  cdp.detach = async () => { calls.push(["detach"]); };
  const page = new EventEmitter();
  Object.assign(page, {
    url: () => "https://www.madlan.co.il/some/path?code=secret",
    bringToFront: async () => {},
    mouse: { click: async (x, y) => calls.push(["click", x, y]), move: async (x, y) => calls.push(["move", x, y]), wheel: async (dx, dy) => calls.push(["wheel", dx, dy]), down: async () => calls.push(["down"]), up: async () => calls.push(["up"]) },
    keyboard: { press: async (k) => calls.push(["press", k]), insertText: async (t) => calls.push(["text", t]) },
    evaluate: async () => true,
    goBack: async () => calls.push(["back"]),
    reload: async () => calls.push(["reload"]),
  });
  const context = new EventEmitter();
  context.pages = () => [page];
  context.newCDPSession = async () => cdp;
  const browser = new EventEmitter();
  browser.contexts = () => [context];
  browser.close = async () => { calls.push(["close"]); };
  return { browser, context, page, cdp, calls };
}
const driverOk = { getSession: async (id) => ({ sessionId: id, status: "active", cdpUrl: "wss://node/secret" }), waitForActive: async (s) => s };

(async () => {
  // ── validation ──
  assert.deepEqual(V.parseInput({ t: "click", x: 0.5, y: 1 }), { t: "click", x: 0.5, y: 1 });
  assert.equal(V.parseInput({ t: "click", x: 1.2, y: 0 }), null);
  assert.equal(V.parseInput({ t: "click", x: "0.2", y: 0 }), null);
  assert.equal(V.parseInput({ t: "key", key: "F12" }), null, "keys outside the allow-list are refused");
  assert.equal(V.parseInput({ t: "key", key: "Control+A" }), null);
  assert.deepEqual(V.parseInput({ t: "key", key: "Tab", shift: true }), { t: "key", key: "Shift+Tab" });
  assert.equal(V.parseInput({ t: "text", text: "a\nb" }), null, "control characters are refused");
  assert.equal(V.parseInput({ t: "text", text: "x".repeat(V.MAX_TEXT + 1) }), null);
  assert.deepEqual(V.parseInput({ t: "text", text: "שלום 123" }), { t: "text", text: "שלום 123" });
  assert.equal(V.parseInput({ t: "wheel", x: 0, y: 0, dx: 0, dy: 99999 }), null);
  assert.equal(V.parseInput({ t: "eval" }), null);
  assert.deepEqual(V.parseInput({ t: "down", x: 0.1, y: 0.2 }), { t: "down", x: 0.1, y: 0.2 });
  assert.equal(V.parseInput({ t: "up", x: 2, y: 0 }), null);
  assert.equal(V.parseInput(null), null);
  assert.equal(V.shortUrl("https://www.madlan.co.il/a/b?code=1#x"), "https://www.madlan.co.il/a/b");
  assert.equal(V.shortUrl("javascript:alert(1)"), "");

  // ── attach: one hub per key, screencast started, frames fan out and are acked ──
  {
    const f = fakeBrowser();
    let connects = 0, gotUrl = null;
    const deps = { driver: driverOk, connectOverCDP: async (u) => { connects++; gotUrl = u; return f.browser; }, idleMs: 30 };
    const [h1, h2] = await Promise.all([V.attach("p1|madlan", "s1", deps), V.attach("p1|madlan", "s1", deps)]);
    assert.equal(h1, h2, "concurrent viewers share one hub");
    assert.equal(connects, 1);
    assert.equal(gotUrl, "wss://node/secret");
    assert.ok(f.calls.some(([m, p]) => m === "Page.startScreencast" && p.format === "jpeg"));

    const got = [];
    const off = V.subscribe(h1, (e) => got.push(e));
    f.cdp.emit("Page.screencastFrame", { data: "AAAA", sessionId: 7, metadata: { deviceWidth: 1000, deviceHeight: 500 } });
    assert.deepEqual(got[0], { t: "frame", d: "AAAA", w: 1000, h: 500, u: "https://www.madlan.co.il/some/path" }, "no query string in the url");
    await new Promise((r) => setImmediate(r));
    assert.ok(f.calls.some(([m, p]) => m === "Page.screencastFrameAck" && p.sessionId === 7));
    assert.ok(!JSON.stringify(got).includes("wss://"), "no cdpUrl in any event");

    // A late viewer gets the last frame at once.
    const late = [];
    const offLate = V.subscribe(h1, (e) => late.push(e));
    assert.equal(late[0].d, "AAAA");
    offLate();

    // ── input: fractions → the page's own pixels ──
    const r = await V.input("p1|madlan", { t: "click", x: 0.25, y: 0.5 });
    assert.deepEqual(f.calls.find((c) => c[0] === "click"), ["click", 250, 250]);
    assert.deepEqual(r, { editable: true });
    await V.input("p1|madlan", { t: "text", text: "שלום" });
    await V.input("p1|madlan", { t: "key", key: "Enter" });
    await V.input("p1|madlan", { t: "wheel", x: 0.5, y: 0.5, dx: 0, dy: 300 });
    assert.ok(f.calls.some((c) => c[0] === "text" && c[1] === "שלום"));
    assert.ok(f.calls.some((c) => c[0] === "press" && c[1] === "Enter"));
    assert.ok(f.calls.some((c) => c[0] === "wheel" && c[2] === 300));
    // A held press: down at the point, moves, up.
    await V.input("p1|madlan", { t: "down", x: 0.5, y: 0.5 });
    await V.input("p1|madlan", { t: "move", x: 0.51, y: 0.5 });
    await V.input("p1|madlan", { t: "up", x: 0.51, y: 0.5 });
    const seq = f.calls.filter((c) => ["down", "up", "move"].includes(c[0])).map((c) => c[0]);
    assert.deepEqual(seq.slice(-5), ["move", "down", "move", "move", "up"]);
    await assert.rejects(V.input("p1|madlan", { t: "key", key: "F5" }), (e) => e.code === "invalid_input");
    await assert.rejects(V.input("p2|madlan", { t: "click", x: 0, y: 0 }), (e) => e.code === "no_viewer", "another phone has no hub here");

    // Rate limit: a flood is refused, not replayed.
    let limited = 0;
    for (let i = 0; i < 60; i++) { try { await V.input("p1|madlan", { t: "key", key: "Tab" }); } catch (e) { if (e.code === "slow_down") limited++; } }
    assert.ok(limited > 0, "input is rate limited");

    // ── the last viewer leaving closes the hub after the idle wait ──
    off();
    await new Promise((res) => setTimeout(res, 60));
    assert.ok(!V._hubs.has("p1|madlan"), "idle hub closed");
    assert.ok(f.calls.some((c) => c[0] === "close"), "our CDP connection closed");
  }

  // ── close() ends every viewer; a Driver-side end does too; replace closes the old hub ──
  {
    const f = fakeBrowser();
    const deps = { driver: driverOk, connectOverCDP: async () => f.browser };
    const h = await V.attach("p3|facebook", "sA", deps);
    const got = [];
    V.subscribe(h, (e) => got.push(e));
    await V.close("p3|facebook", "connected");
    assert.deepEqual(got.pop(), { t: "end", reason: "connected" });
    await assert.rejects(V.input("p3|facebook", { t: "back" }), (e) => e.code === "no_viewer");

    const g = fakeBrowser();
    const h2 = await V.attach("p3|facebook", "sB", { driver: driverOk, connectOverCDP: async () => g.browser });
    const got2 = [];
    V.subscribe(h2, (e) => got2.push(e));
    g.browser.emit("disconnected");
    assert.deepEqual(got2.pop(), { t: "end", reason: "session_ended" });
    assert.ok(!V._hubs.has("p3|facebook"));

    const k = fakeBrowser(), k2 = fakeBrowser();
    const a = await V.attach("p4|yad2", "s1", { driver: driverOk, connectOverCDP: async () => k.browser });
    const got3 = [];
    V.subscribe(a, (e) => got3.push(e));
    const b = await V.attach("p4|yad2", "s2", { driver: driverOk, connectOverCDP: async () => k2.browser });
    assert.notEqual(a, b);
    assert.deepEqual(got3.pop(), { t: "end", reason: "replaced" });
    await V.close("p4|yad2");
  }

  // ── an ended session, a full house, a popup ──
  {
    const gone = { getSession: async () => ({ status: "completed" }), waitForActive: async () => { throw new Error("session ended"); } };
    await assert.rejects(V.attach("p5|madlan", "sx", { driver: gone, connectOverCDP: async () => { throw new Error("never"); } }), (e) => e.code === "session_expired");
    assert.ok(!V._hubs.has("p5|madlan"));

    const f = fakeBrowser();
    await V.attach("p6|madlan", "s1", { driver: driverOk, connectOverCDP: async () => f.browser });
    await assert.rejects(V.attach("p7|madlan", "s1", { driver: driverOk, connectOverCDP: async () => fakeBrowser().browser, maxHubs: 1 }), (e) => e.code === "driver_busy");

    // A sign-in popup takes the screen; closing it gives the tab back.
    const hub = V._hubs.get("p6|madlan");
    const popup = new EventEmitter();
    Object.assign(popup, { url: () => "https://accounts.google.com/x", bringToFront: async () => {} });
    const pages = [f.page, popup];
    f.context.pages = () => pages;
    f.context.emit("page", popup);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(hub.page, popup);
    pages.pop();
    popup.emit("close");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(hub.page, f.page);
    await V.close("p6|madlan");
  }

  // ── the race: the monitor starts a second connection, then the automation hands over its own ──
  {
    const f = fakeBrowser(), auto = fakeBrowser();
    let letConnect;
    const slow = { driver: driverOk, connectOverCDP: () => new Promise((r) => { letConnect = () => r(f.browser); }) };
    const pending = V.attach("dev|race", "sR", slow);
    await new Promise((r) => setImmediate(r));
    const adopted = V.adopt("dev|race", "sR", auto.browser, auto.context);
    letConnect();
    assert.equal(await pending, adopted, "the viewer gets the automation's hub, not 'replaced'");
    assert.ok(f.calls.some((c) => c[0] === "close"), "the second connection is dropped");
    // …and when the second connection is refused outright, the same.
    const refused = V.attach("dev|race2", "sQ", { driver: driverOk, connectOverCDP: async () => { V.adopt("dev|race2", "sQ", auto.browser, auto.context); throw new Error("one client only"); } });
    assert.equal((await refused).adopted, true);
    await V.close("dev|race"); await V.close("dev|race2");
  }

  await realChromium();
  console.log("connect-viewer.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });

// ── against a real Chromium over CDP: frames arrive, a click and typing land ──
function findChromium() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers"].filter(Boolean)) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse(); } catch { continue; }
    for (const d of dirs) { const exe = path.join(root, d, "chrome-linux", "chrome"); if (fs.existsSync(exe)) return exe; }
  }
  return null;
}
async function realChromium() {
  const exe = findChromium();
  if (!exe) { console.log("connect-viewer.test.js: real-browser part skipped (no Chromium binary)"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-"));
  const html = `<html><body style="margin:0"><input id="q" style="position:absolute;left:0;top:0;width:400px;height:100px;font-size:40px"><div id="h" style="position:absolute;left:0;top:200px;width:300px;height:100px"></div><div style="height:3000px"></div></body></html>`;
  const proc = spawn(exe, ["--headless=new", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--window-size=800,600", `data:text/html,${encodeURIComponent(html)}`], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const wsUrl = await new Promise((ok, no) => {
      let buf = "";
      const t = setTimeout(() => no(new Error("no DevTools url")), 15000);
      proc.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
    });
    const drv = { getSession: async () => ({ status: "active", cdpUrl: wsUrl }), waitForActive: async (s) => s };
    const hub = await V.attach("real|madlan", "r1", { driver: drv });
    const frames = [];
    const off = V.subscribe(hub, (e) => frames.push(e));
    for (let i = 0; i < 50 && !frames.some((f) => f.t === "frame"); i++) await new Promise((r) => setTimeout(r, 100));
    const fr = frames.find((f) => f.t === "frame");
    assert.ok(fr, "a real screencast frame arrived");
    assert.ok(fr.w > 0 && fr.h > 0 && Buffer.from(fr.d, "base64")[0] === 0xff, "a JPEG with the page size");

    const r = await V.input("real|madlan", { t: "click", x: 50 / fr.w, y: 50 / fr.h });
    assert.equal(r.editable, true, "the click focused the text field");
    await V.input("real|madlan", { t: "text", text: "שלום abc" });
    await V.input("real|madlan", { t: "key", key: "Backspace" });
    const value = await hub.page.evaluate(() => document.getElementById("q").value);
    assert.equal(value, "שלום ab");
    // Press and hold: a real, trusted press that lasts as long as it is held.
    await hub.page.evaluate(() => { const h = document.getElementById("h"); h.addEventListener("mousedown", (e) => { window.__d = [Date.now(), e.isTrusted]; }); h.addEventListener("mouseup", () => { window.__held = Date.now() - window.__d[0]; }); });
    await V.input("real|madlan", { t: "down", x: 150 / fr.w, y: 250 / fr.h });
    await new Promise((r) => setTimeout(r, 1200));
    await V.input("real|madlan", { t: "move", x: 152 / fr.w, y: 251 / fr.h });
    await V.input("real|madlan", { t: "up", x: 152 / fr.w, y: 251 / fr.h });
    const held = await hub.page.evaluate(() => [window.__held, window.__d && window.__d[1]]);
    assert.ok(held[0] >= 1100 && held[1] === true, `held ${held[0]} ms, trusted ${held[1]}`);
    await V.input("real|madlan", { t: "wheel", x: 0.5, y: 0.5, dx: 0, dy: 600 });
    let y = 0;
    for (let i = 0; i < 20 && !y; i++) { await new Promise((r) => setTimeout(r, 50)); y = await hub.page.evaluate(() => window.scrollY); }
    assert.ok(y > 0, "the wheel scrolled the page");
    off();
    await V.close("real|madlan");
    // Closing the hub only drops OUR connection: the agent's browser, and what
    // they typed into it, is still there for the next viewer or /finish.
    assert.equal(proc.exitCode, null, "the browser process is still running");
    const again = await require("patchright").chromium.connectOverCDP(wsUrl);
    const kept = await again.contexts()[0].pages()[0].evaluate(() => document.getElementById("q").value);
    assert.equal(kept, "שלום ab");
    await again.close();
    // ── watching a browser the server itself drives: over ITS connection ──
    {
      const auto = await require("patchright").chromium.connectOverCDP(wsUrl);
      const ctx = auto.contexts()[0];
      const hubA = V.adopt("dev|auto1", "auto1", auto, ctx);
      const noSecond = { getSession: async () => { throw new Error("a second connection was opened"); }, waitForActive: async (x) => x };
      assert.equal(await V.attach("dev|auto1", "auto1", { driver: noSecond }), hubA, "the monitor gets the adopted hub, no second connection");
      assert.equal(hubA.cdp, null, "no screencast while nobody watches");
      const seen = [];
      const offA = V.subscribe(hubA, (e) => seen.push(e));
      for (let i = 0; i < 50 && !seen.some((f) => f.t === "frame"); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(seen.some((f) => f.t === "frame"), "frames once watched");
      await V.input("dev|auto1", { t: "click", x: 50 / hubA.size.w, y: 50 / hubA.size.h });
      offA();
      hubA.idleMs = 0;
      V.subscribe(hubA, () => {})(); // leave again, with no idle wait
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(hubA.cdp, null, "asleep again");
      assert.equal(auto.isConnected(), true, "the automation's connection is never closed by the monitor");
      const ended = [];
      V.subscribe(hubA, (e) => ended.push(e));
      await auto.close();
      for (let i = 0; i < 20 && !ended.some((e) => e.t === "end"); i++) await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(ended.filter((e) => e.t === "end"), [{ t: "end", reason: "session_ended" }], "ends with the automation");
      assert.ok(!V._hubs.has("dev|auto1"));
    }
    console.log("connect-viewer.test.js: real Chromium ok");
  } finally {
    proc.kill("SIGKILL");
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}
