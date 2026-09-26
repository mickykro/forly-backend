/*
 * connect-viewer.js — the agent's login browser, shown inside Forly.
 *
 * Driver's own viewer is a separate site that takes the raw cdpUrl in its
 * address, and it will not be framed. So the login browser is relayed through
 * Forly instead: the server holds the CDP connection, streams the page as a
 * JPEG screencast (Page.startScreencast — frames only when the page changes)
 * and replays the agent's clicks, scrolls and typing into it. The cdpUrl never
 * leaves this process.
 *
 * One hub per phone|platform, created by the first viewer and closed when the
 * last one has been gone IDLE_MS, when the Driver session ends, or when the
 * connect routes say so (finish, disconnect, a new login browser). A hub is a
 * CDP connection to an existing session, not a new Driver session, so it does
 * not take a slot of the session budget; MAX_HUBS bounds them instead.
 *
 * Keystrokes pass through here in memory on their way to the browser. Nothing
 * in this file logs, stores or returns them, or the page's URL beyond its
 * origin and path.
 */
const driverLive = require("./driver-browser");

const MAX_HUBS = Number(process.env.CONNECT_VIEWER_MAX || 20);
const IDLE_MS = 20000;
const SCREENCAST = { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 };
const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
const MAX_TEXT = 256;
const RATE_PER_S = 40;
// A press is released by itself when its "up" never comes (the viewer left).
const HOLD_MAX_MS = 30000;

const hubs = new Map();

function err(code) { const e = new Error(code); e.code = code; return e; }

// Origin + path only: a login page's query can carry one-time codes.
function shortUrl(u) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.origin + x.pathname : ""; } catch (e) { return ""; }
}

// A validated input event, or null. Coordinates are fractions of the frame.
function parseInput(b) {
  if (!b || typeof b !== "object") return null;
  const frac = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  switch (b.t) {
    case "click": return frac(b.x) && frac(b.y) ? { t: "click", x: b.x, y: b.y } : null;
    // A held press (a "press and hold" bot check): down, moves, up.
    case "down": case "move": case "up": return frac(b.x) && frac(b.y) ? { t: b.t, x: b.x, y: b.y } : null;
    case "wheel": {
      const d = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 5000;
      return frac(b.x) && frac(b.y) && d(b.dx) && d(b.dy) ? { t: "wheel", x: b.x, y: b.y, dx: b.dx, dy: b.dy } : null;
    }
    case "key": return KEYS.has(b.key) ? { t: "key", key: b.shift === true && b.key === "Tab" ? "Shift+Tab" : b.key } : null;
    // Printable text only; line breaks and other keys go as "key" events.
    case "text": return typeof b.text === "string" && b.text.length > 0 && b.text.length <= MAX_TEXT && !/[\u0000-\u001f\u007f]/.test(b.text) ? { t: "text", text: b.text } : null;
    case "back": case "reload": return { t: b.t };
    default: return null;
  }
}

function emit(hub, evt) {
  for (const fn of [...hub.subs]) { try { fn(evt); } catch (e) { /* a dead viewer never stops the rest */ } }
}

async function close(key, reason = "closed") {
  const hub = hubs.get(key);
  if (!hub) return;
  hubs.delete(key);
  hub.closed = true;
  clearTimeout(hub.idle);
  clearTimeout(hub.holdTimer);
  if (hub.holding && hub.page) { try { await hub.page.mouse.up(); } catch (e) { /* page gone */ } }
  emit(hub, { t: "end", reason });
  hub.subs.clear();
  if (hub.cdp) { try { await hub.cdp.detach(); } catch (e) { /* page gone */ } }
  // An adopted hub rides the automation's own connection: never close it.
  if (hub.browser && !hub.adopted) { try { await hub.browser.close(); } catch (e) { /* our connection only */ } }
}

// Stop the screencast of an adopted hub nobody watches; the next viewer wakes it.
async function sleep(hub) {
  const cdp = hub.cdp;
  hub.cdp = null; hub.page = null;
  if (cdp) { try { await cdp.detach(); } catch (e) { /* page gone */ } }
}
const lastPage = (hub) => { const ps = hub.context ? hub.context.pages() : []; return ps[ps.length - 1] || null; };

// Popups take the screen; when one closes, the tab before it gets it back.
function followPages(hub) {
  hub.context.on("page", (p) => {
    if (hub.adopted && !hub.subs.size) return; // asleep: the next viewer picks the last page
    watch(hub, p).catch(() => {});
    p.on("close", () => {
      if (hub.page !== p || hub.closed) return;
      const rest = hub.context.pages().filter((x) => x !== p);
      if (rest.length) watch(hub, rest[rest.length - 1]).catch(() => {});
    });
  });
}

/*
 * A browser the server is driving itself (driver-browser.withPage, on a local
 * box): the monitor watches it over the SAME connection instead of opening a
 * second one — Driver may not take a second client while automation holds
 * one [Inference]. The screencast runs only while someone watches.
 */
function adopt(key, sessionId, browser, context) {
  const prev = hubs.get(key);
  if (prev) close(key, "replaced").catch(() => {});
  const hub = { key, sessionId, browser, context, adopted: true, page: null, cdp: null, subs: new Set(), last: null,
    size: { w: 1280, h: 800 }, closed: false, idle: null, sent: [], idleMs: IDLE_MS };
  browser.on("disconnected", () => { if (hubs.get(key) === hub) close(key, "session_ended"); });
  followPages(hub);
  hubs.set(key, hub);
  return hub;
}

// Point the screencast at `page` (the login tab, or a sign-in popup it opened).
async function watch(hub, page) {
  if (hub.closed || hub.page === page) return;
  const old = hub.cdp;
  hub.page = page; hub.cdp = null;
  if (old) { try { await old.detach(); } catch (e) { /* closed with its page */ } }
  const cdp = await hub.context.newCDPSession(page);
  if (hub.closed || hub.page !== page) { try { await cdp.detach(); } catch (e) { /* ignore */ } return; }
  hub.cdp = cdp;
  cdp.on("Page.screencastFrame", (f) => {
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    if (hub.page !== page) return;
    const m = f.metadata || {};
    if (m.deviceWidth > 0 && m.deviceHeight > 0) hub.size = { w: m.deviceWidth, h: m.deviceHeight };
    hub.last = { t: "frame", d: f.data, w: hub.size.w, h: hub.size.h, u: shortUrl(page.url()) };
    emit(hub, hub.last);
  });
  try { await page.bringToFront(); } catch (e) { /* a background tab only stops frames */ }
  await cdp.send("Page.startScreencast", SCREENCAST);
}

async function open(key, sessionId, deps) {
  const driver = deps.driver || driverLive;
  const connect = deps.connectOverCDP || ((u) => require("patchright").chromium.connectOverCDP(u));
  let session;
  try { session = await driver.waitForActive(await driver.getSession(sessionId, deps.driverDeps), deps.driverDeps); }
  catch (e) { throw err("session_expired"); }
  // Why a viewer could not open, for the server log and the local monitor:
  // the error's own words with every browser address removed.
  const unavailable = (stage, e) => {
    const detail = driverLive.redact(`${stage}: ${(e && e.name) || "Error"}: ${(e && e.message) || ""}`).slice(0, 300);
    console.error(`connect-viewer: ${detail}`);
    return Object.assign(err("viewer_unavailable"), { detail });
  };
  let browser;
  try { browser = await connect(session.cdpUrl); }
  catch (e) { throw unavailable("connect", e); }
  const hub = { key, sessionId, browser, context: null, page: null, cdp: null, subs: new Set(), last: null,
    size: { w: 1280, h: 800 }, closed: false, idle: null, sent: [], idleMs: deps.idleMs || IDLE_MS };
  try {
    hub.context = browser.contexts()[0] || (await browser.newContext());
    browser.on("disconnected", () => { if (hubs.get(key) === hub) close(key, "session_ended"); });
    followPages(hub);
    await watch(hub, hub.context.pages()[0] || (await hub.context.newPage()));
  } catch (e) {
    hub.closed = true;
    try { await browser.close(); } catch (x) { /* ignore */ }
    throw unavailable("screencast", e);
  }
  return hub;
}

/*
 * The hub for this phone|platform on this session, opened if needed. A hub
 * left from an earlier session of the same key is closed first.
 */
async function attach(key, sessionId, deps = {}) {
  const have = hubs.get(key);
  if (have && have.sessionId === sessionId && !have.closed) return have.ready || have;
  if (have) await close(key, "replaced");
  if (hubs.size >= (deps.maxHubs || MAX_HUBS)) throw err("driver_busy");
  const placeholder = { sessionId, closed: false, subs: new Set() };
  placeholder.ready = open(key, sessionId, deps).then((hub) => {
    if (hubs.get(key) !== placeholder) { hub.closed = true; hub.browser.close().catch(() => {}); throw err("replaced"); }
    hubs.set(key, hub);
    return hub;
  }, (e) => { if (hubs.get(key) === placeholder) hubs.delete(key); throw e; });
  hubs.set(key, placeholder);
  return placeholder.ready;
}

// fn(evt) gets {t:"frame",…} and a final {t:"end",reason}. Returns the unsubscribe.
function subscribe(hub, fn) {
  clearTimeout(hub.idle);
  hub.subs.add(fn);
  if (hub.last) fn(hub.last);
  if (hub.adopted && !hub.cdp && !hub.page && lastPage(hub)) watch(hub, lastPage(hub)).catch(() => {});
  return () => {
    hub.subs.delete(fn);
    if (!hub.subs.size && !hub.closed) {
      hub.idle = setTimeout(() => {
        if (hub.subs.size || hubs.get(hub.key) !== hub) return;
        if (hub.adopted) sleep(hub); else close(hub.key, "idle");
      }, hub.idleMs);
    }
  };
}

// Replays one validated event into the page. Returns { editable } after a
// click — whether a text field took the focus, so a phone opens its keyboard.
async function input(key, raw) {
  const hub = hubs.get(key);
  if (!hub || hub.closed || !hub.page) throw err("no_viewer");
  const ev = parseInput(raw);
  if (!ev) throw err("invalid_input");
  const now = Date.now();
  hub.sent = hub.sent.filter((t) => now - t < 1000);
  if (hub.sent.length >= RATE_PER_S) throw err("slow_down");
  hub.sent.push(now);
  const page = hub.page;
  const px = (f, total) => Math.round(f * total);
  try {
    if (ev.t === "click") {
      await page.mouse.click(px(ev.x, hub.size.w), px(ev.y, hub.size.h));
      let editable = false;
      try {
        editable = await page.evaluate(() => {
          const a = document.activeElement;
          return !!a && (a.isContentEditable || a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && !/^(button|submit|checkbox|radio|file|image|reset|range|color)$/i.test(a.type)));
        });
      } catch (e) { editable = false; }
      return { editable };
    }
    if (ev.t === "down") {
      clearTimeout(hub.holdTimer);
      await page.mouse.move(px(ev.x, hub.size.w), px(ev.y, hub.size.h));
      await page.mouse.down();
      hub.holding = true;
      hub.holdTimer = setTimeout(() => { hub.holding = false; page.mouse.up().catch(() => {}); }, HOLD_MAX_MS);
    } else if (ev.t === "move") await page.mouse.move(px(ev.x, hub.size.w), px(ev.y, hub.size.h));
    else if (ev.t === "up") {
      clearTimeout(hub.holdTimer);
      hub.holding = false;
      await page.mouse.move(px(ev.x, hub.size.w), px(ev.y, hub.size.h));
      await page.mouse.up();
    } else if (ev.t === "wheel") { await page.mouse.move(px(ev.x, hub.size.w), px(ev.y, hub.size.h)); await page.mouse.wheel(ev.dx, ev.dy); }
    else if (ev.t === "key") await page.keyboard.press(ev.key);
    else if (ev.t === "text") await page.keyboard.insertText(ev.text);
    else if (ev.t === "back") await page.goBack({ timeout: 15000 }).catch(() => null);
    else if (ev.t === "reload") await page.reload({ timeout: 30000 }).catch(() => null);
  } catch (e) {
    if (hub.closed) throw err("no_viewer");
    throw err("input_failed");
  }
  return {};
}

// The hub as a server-sent-events response: frames ({t:"frame",d,w,h,u}),
// ending with {t:"end",reason}. A slow connection skips frames and gets the
// newest one when it drains; a heartbeat keeps proxies from closing it.
function pipe(req, res, hub, sub = subscribe) {
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" });
  res.write(": open\n\n");
  let behind = false;
  const off = sub(hub, (evt) => {
    if (res.writableEnded) return;
    if (evt.t === "frame" && res.writableNeedDrain) {
      if (!behind) { behind = true; res.once("drain", () => { behind = false; if (hub.last && !res.writableEnded) res.write(`data: ${JSON.stringify(hub.last)}\n\n`); }); }
      return;
    }
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
    if (evt.t === "end") res.end();
  });
  const beat = setInterval(() => { if (!res.writableEnded) res.write(": k\n\n"); }, 15000);
  const done = () => { clearInterval(beat); off(); };
  req.on("close", done);
  if (req.destroyed) done();
}

module.exports = { attach, adopt, subscribe, pipe, input, close, parseInput, shortUrl, _hubs: hubs, MAX_TEXT };
