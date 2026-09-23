/* routes/extract.js — request validation, error → status mapping, the daily
   cap and the image import guard. Express is not exercised; the handlers'
   pure parts are. */
const assert = require("assert");
const { _test } = require("./extract");
const { validateBody, statusFor, DailyLimit, importImage, IMAGE_TYPES } = _test;

// ── body: exactly one of text/url, trimmed, capped ──
assert.deepEqual(validateBody({ text: "  שלום  " }), { text: "שלום" });
assert.deepEqual(validateBody({ url: " https://x.co/1 " }), { url: "https://x.co/1" });
assert.equal(validateBody({}), null);
assert.equal(validateBody({ text: "a", url: "https://x" }), null);
assert.equal(validateBody({ text: "   " }), null);
assert.equal(validateBody({ url: "not a url" }), null);
assert.equal(validateBody({ text: "x".repeat(20000) }).text.length, require("../listing-extract").MAX_INPUT);
assert.equal(validateBody(null), null);

// ── error codes → http status ──
assert.equal(statusFor("invalid_input"), 400);
assert.equal(statusFor("facebook_not_connected"), 409);
assert.equal(statusFor("page_unreadable"), 422);
assert.equal(statusFor("extract_limit"), 429);
assert.equal(statusFor("extract_unavailable"), 503);
assert.equal(statusFor("anything_else"), 500);

// ── daily cap: per key, per UTC day ──
const lim = new DailyLimit(2);
const day1 = new Date("2026-09-08T10:00:00Z");
assert.equal(lim.take("a", day1), true);
assert.equal(lim.take("a", day1), true);
assert.equal(lim.take("a", day1), false);
assert.equal(lim.take("b", day1), true);
assert.equal(lim.take("a", new Date("2026-09-09T00:00:01Z")), true);

// ── image import: public url, image type, size cap ──
(async () => {
  const png = Buffer.from("89504e47", "hex");
  const fetchOk = async () => ({ ok: true, headers: new Map([["content-type", "image/png"]]), arrayBuffer: async () => png });
  const img = await importImage("https://c/a.png", { fetchFn: fetchOk, lookup: async () => [{ address: "1.2.3.4" }] });
  assert.match(img.fname, /^[0-9a-f-]{36}\.png$/);
  assert.equal(img.contentType, "image/png");
  assert.equal(img.buffer.length, png.length);

  await assert.rejects(importImage("http://127.0.0.1/x.png", { fetchFn: fetchOk }), (e) => e.code === "invalid_input");
  const fetchHtml = async () => ({ ok: true, headers: new Map([["content-type", "text/html"]]), arrayBuffer: async () => png });
  await assert.rejects(importImage("https://c/a", { fetchFn: fetchHtml, lookup: async () => [{ address: "1.2.3.4" }] }), (e) => e.code === "page_unreadable");
  const big = Buffer.alloc(10 * 1024 * 1024 + 1);
  const fetchBig = async () => ({ ok: true, headers: new Map([["content-type", "image/jpeg"]]), arrayBuffer: async () => big });
  await assert.rejects(importImage("https://c/a.jpg", { fetchFn: fetchBig, lookup: async () => [{ address: "1.2.3.4" }] }), (e) => e.code === "page_unreadable");
  const fetch404 = async () => ({ ok: false, status: 404, headers: new Map() });
  await assert.rejects(importImage("https://c/a.jpg", { fetchFn: fetch404, lookup: async () => [{ address: "1.2.3.4" }] }), (e) => e.code === "page_unreadable");
  assert.deepEqual(Object.keys(IMAGE_TYPES), ["image/jpeg", "image/png", "image/webp"]);
  // WhatsApp media arrives as octet-stream: the bytes decide
  const jpg = Buffer.from("ffd8ffe0", "hex");
  const fetchOctet = (buf) => async () => ({ ok: true, headers: new Map([["content-type", "application/octet-stream"]]), arrayBuffer: async () => buf });
  const wa = await importImage("https://c/x", { fetchFn: fetchOctet(jpg), lookup: async () => [{ address: "1.2.3.4" }] });
  assert.deepEqual([wa.contentType, wa.fname.endsWith(".jpg")], ["image/jpeg", true]);
  await assert.rejects(importImage("https://c/x", { fetchFn: fetchOctet(Buffer.from("%PDF")), lookup: async () => [{ address: "1.2.3.4" }] }), (e) => e.code === "page_unreadable");
  // videos only when asked for, and never as a "photo"
  const mp4 = Buffer.concat([Buffer.from("00000018", "hex"), Buffer.from("ftypmp42")]);
  const vid = await importImage("https://c/v", { fetchFn: fetchOctet(mp4), lookup: async () => [{ address: "1.2.3.4" }], video: true });
  assert.deepEqual([vid.contentType, vid.fname.endsWith(".mp4")], ["video/mp4", true]);
  await assert.rejects(importImage("https://c/v", { fetchFn: fetchOctet(mp4), lookup: async () => [{ address: "1.2.3.4" }] }), (e) => e.code === "page_unreadable");
  await assert.rejects(importImage("https://c/x", { fetchFn: fetchOctet(jpg), lookup: async () => [{ address: "1.2.3.4" }], video: true }), (e) => e.code === "page_unreadable");
  console.log("routes/extract.test.js ok");
})();
