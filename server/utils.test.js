/*
 * utils.test.js — pure unit tests, no network, no npm install needed.
 *   node utils.test.js
 *
 * Covers the media-URL plumbing that lets a page built on a laptop carry URLs
 * which outlive the laptop: rehost() flattening + relaying, INFRA_HOST, and the
 * PAGE_BASE_URL rule.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { INFRA_HOST, resolvePageBaseUrl, rehost, guessImageExt } = require("./utils");

// ── INFRA_HOST ────────────────────────────────────────────────────────────
// Moved out of index.js so scripts can require it; these pin the behaviour so
// the move cannot quietly change what counts as an infra host.
for (const bad of [
  "https://scenarios-cables.trycloudflare.com/p/1",
  "https://forly.srv1173890.hstgr.cloud",
  "https://x.ngrok.io", "https://x.ngrok-free.app", "https://x.ngrok.dev",
  "https://demo.loca.lt", "http://31.97.216.242:8787",
]) assert.ok(INFRA_HOST.test(bad), `expected infra host: ${bad}`);

for (const ok of ["https://nadlan.call4li.com", "https://call4li.com/p/1"]) {
  assert.ok(!INFRA_HOST.test(ok), `expected NOT infra host: ${ok}`);
}

// ── resolvePageBaseUrl ────────────────────────────────────────────────────
const PUB = "https://nadlan.call4li.com";

// Production: an infra PAGE_BASE_URL is rewritten to the branded domain. This
// is the pre-existing behaviour and must not change when the opt-in is absent.
assert.strictEqual(resolvePageBaseUrl({
  pageBaseUrl: "https://staging.srv1173890.hstgr.cloud",
  baseUrl: "https://forly.srv1173890.hstgr.cloud", publicBaseUrl: PUB,
}), PUB);

// ...and is still rewritten for every falsy spelling of the opt-in.
for (const off of [undefined, "", "0", "false", "no"]) {
  assert.strictEqual(resolvePageBaseUrl({
    pageBaseUrl: "https://staging.srv1173890.hstgr.cloud",
    baseUrl: "https://forly.srv1173890.hstgr.cloud", publicBaseUrl: PUB, allowInfra: off,
  }), PUB, `allowInfra=${JSON.stringify(off)} must keep the guard on`);
}

// dev/staging opt in and keep their own host, so their links come back to them.
for (const on of ["1", "true", "yes", "YES"]) {
  assert.strictEqual(resolvePageBaseUrl({
    pageBaseUrl: "https://staging.srv1173890.hstgr.cloud/",
    baseUrl: "https://staging.srv1173890.hstgr.cloud", publicBaseUrl: PUB, allowInfra: on,
  }), "https://staging.srv1173890.hstgr.cloud", `allowInfra=${on} must be honoured`);
}

// Long-standing quirk, pinned deliberately: INFRA_HOST also matches a bare IP,
// so a 127.0.0.1 base IS rewritten to the branded domain while a localhost base
// is not. Both predate this helper; these assertions exist so the extraction
// from index.js cannot have changed them.
assert.strictEqual(resolvePageBaseUrl({
  baseUrl: "http://127.0.0.1:8787", publicBaseUrl: PUB,
}), PUB);
assert.strictEqual(resolvePageBaseUrl({
  baseUrl: "http://localhost:8787", publicBaseUrl: PUB,
}), "http://localhost:8787");
assert.strictEqual(resolvePageBaseUrl({
  baseUrl: "https://forly.srv1173890.hstgr.cloud", publicBaseUrl: PUB,
}), PUB);

// ── rehost ────────────────────────────────────────────────────────────────
// The remote upload route only accepts a flat uuid name; anything else is
// rejected before the bytes are written, so relaying depends on this shape.
const REMOTE_FNAME = /^[0-9a-f-]{36}\.(jpg|png|webp|mp4|woff2|woff|ttf|otf)$/;

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const fakeFetch = (body) => async () => ({
  ok: true, status: 200,
  headers: { get: () => String(body.length) },
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
});

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rehost-"));
  const realFetch = global.fetch;
  global.fetch = fakeFetch(PNG);
  try {
    // Local branch: no relay configured, URL carries baseUrl, bytes on disk.
    const local = await rehost("https://example.com/a.png", "pages/p1/photo-01.png", dir,
      "https://dev.example.com");
    assert.ok(REMOTE_FNAME.test(local.fname), `not a relayable name: ${local.fname}`);
    assert.strictEqual(local.url, `https://dev.example.com/files/${local.fname}`);
    assert.ok(fs.existsSync(local.localPath), "local copy must exist");
    assert.deepStrictEqual(fs.readFileSync(local.localPath), PNG);
    // The caller's path is NOT the stored name — only its extension survives.
    assert.ok(!local.fname.includes("/"), "stored name must be flat");
    assert.ok(local.fname.endsWith(".png"), "extension must come from destRel");

    // Relay branch: URL carries uploadPublicBase, token is scoped to the name,
    // and the bytes are STILL written locally (captioning reads them back).
    const seen = [];
    const relayFetch = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200 }; };
    const relayed = await rehost("https://example.com/a.png", "pages/p1/walkthrough.mp4", dir,
      "https://dev.example.com", {
        uploadPublicBase: "https://staging.example.com",
        remoteUploadBase: "https://staging.example.com",
        signUpload: (f) => `tok-for-${f}`,
        fetchFn: relayFetch,
      });
    assert.strictEqual(relayed.url, `https://staging.example.com/files/${relayed.fname}`,
      "a relayed file must be advertised on the relay host, not the laptop");
    assert.ok(fs.existsSync(relayed.localPath), "relay must still leave a local copy");
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].url, `https://staging.example.com/api/upload/${relayed.fname}`);
    assert.strictEqual(seen[0].init.headers["x-upload-token"], `tok-for-${relayed.fname}`,
      "token must be bound to the filename actually uploaded");
    assert.strictEqual(seen[0].init.headers["Content-Type"], "video/mp4");

    // A failed relay must not hand back a URL on a host that lacks the bytes.
    await assert.rejects(
      rehost("https://example.com/a.png", "x.png", dir, "https://dev.example.com", {
        uploadPublicBase: "https://staging.example.com",
        remoteUploadBase: "https://staging.example.com",
        fetchFn: async () => ({ ok: false, status: 500 }),
      }),
      /rehost relay/,
      "a failed relay must throw rather than return a remote URL");

    // Every extension guessImageExt can produce stays relayable.
    for (const u of ["a.png", "a.webp", "a.jpeg", "a.JPG", "a"]) {
      const r = await rehost("https://example.com/x", `d/f.${guessImageExt(u)}`, dir, "https://b");
      assert.ok(REMOTE_FNAME.test(r.fname), `guessImageExt(${u}) → unrelayable ${r.fname}`);
    }
  } finally {
    global.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── publicUrl: a loopback origin becomes the public one; anything else is untouched ──
  {
    const { publicUrl } = require("./utils");
    assert.strictEqual(publicUrl("http://127.0.0.1:8787/files/a.mp4"), "https://nadlan.call4li.com/files/a.mp4");
    assert.strictEqual(publicUrl("http://localhost:8787/p/x?c=1"), "https://nadlan.call4li.com/p/x?c=1");
    assert.strictEqual(publicUrl("https://cdn.example.com/files/a.mp4"), "https://cdn.example.com/files/a.mp4");
    assert.strictEqual(publicUrl("http://127.0.0.1.evil.com/x"), "http://127.0.0.1.evil.com/x");
    assert.strictEqual(publicUrl(null), null);
  }

  // ── buttons: links behind buttons; a rejected interactive send falls back to text with the links ──
  {
    const { textOfButtons, sendWhatsAppRich } = require("./utils");
    const payload = { header: "כותרת", body: "גוף", footer: "תחתית", buttons: [{ type: "url", buttonText: "לאישור", url: "https://x.test/a?t=1" }] };
    assert.strictEqual(textOfButtons(payload), "כותרת\n\nגוף\n\nלאישור: https://x.test/a?t=1\n\nתחתית");
    const realFetch = global.fetch, realLog = console.log, realWarn = console.warn;
    const sent = [], logs = [];
    console.log = (...a) => logs.push(a.join(" ")); console.warn = () => {};
    try {
      global.fetch = async (url, o) => { sent.push([url, JSON.parse(o.body)]); return { ok: true, json: async () => ({}) }; };
      await sendWhatsAppRich("972500000001", payload, "7105422200", "tok");
      assert.ok(sent[0][0].endsWith("/waInstance7105422200/sendInteractiveButtons/tok"));
      assert.deepEqual(sent[0][1].buttons, [{ type: "url", buttonText: "לאישור", url: "https://x.test/a?t=1", buttonId: "1" }]);
      assert.strictEqual(sent[0][1].chatId, "972500000001@c.us");
      assert.ok(!logs.join("\n").includes("972500000001") && !logs.join("\n").includes("t=1"), "no phone or link logged");
      sent.length = 0;
      global.fetch = async (url, o) => { sent.push([url, JSON.parse(o.body)]); return url.includes("sendInteractiveButtons") ? { ok: false, status: 400 } : { ok: true }; };
      await sendWhatsAppRich("972500000001", payload, "7105422200", "tok");
      assert.ok(sent[1][0].includes("/sendMessage/"));
      assert.strictEqual(sent[1][1].message, textOfButtons(payload), "the text fallback keeps the link");
    } finally { global.fetch = realFetch; console.log = realLog; console.warn = realWarn; }
  }

  console.log("all utils tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
