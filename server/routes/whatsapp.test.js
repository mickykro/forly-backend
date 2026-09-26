/* routes/whatsapp.js — voice transcription, the stuck-build sweep, and the review-link scope. */
const assert = require("assert");
const db = require("../db");
const auth = require("../auth");
const createWhatsappRouter = require("./whatsapp");
const { transcribe } = createWhatsappRouter;

(async () => {
  // ── transcribe: fal wizper, Hebrew, text out ──
  let sent;
  const fetchFn = async (url, opts) => { sent = { url, opts }; return { ok: true, json: async () => ({ text: " שלום " }) }; };
  assert.equal(await transcribe("https://g/v.ogg", { fetchFn, key: "K" }), "שלום");
  assert.equal(sent.url, "https://fal.run/fal-ai/wizper");
  assert.equal(sent.opts.headers.Authorization, "Key K");
  assert.deepEqual(JSON.parse(sent.opts.body), { audio_url: "https://g/v.ogg", task: "transcribe", language: "he" });
  await assert.rejects(transcribe("https://g/v.ogg", { fetchFn, key: "" }));
  await assert.rejects(transcribe("https://g/v.ogg", { fetchFn: async () => ({ ok: false, status: 500 }), key: "K" }));

  // ── review token: 7-day scope that only opted-in routes accept ──
  const review = auth.signSession("s", "972500000000", { scope: "review", ttlS: 60 });
  assert.equal(auth.verifySession("s", review), null, "plain session checks refuse a review token");
  assert.equal(auth.verifySession("s", review, auth.REVIEW_SCOPES).userId, "972500000000");
  assert.equal(auth.verifySession("s", auth.signSession("s", "972500000000"), auth.REVIEW_SCOPES).scope, "session");

  // ── sweep: a chat listing with no page after 20 min → failed, agent told, draft back to the choice ──
  const msgs = [];
  const router = createWhatsappRouter({ authSecret: "s", sendWhatsApp: async (p, m) => msgs.push([p, m]), sweep: false,
    normalizeAuthPhone: (p) => p, signSession: auth.signSession });
  const now = Date.now();
  const old = new Date(now - 25 * 60 * 1000);
  await db.saveListing({ listing_id: "A", source: "whatsapp", status: "active", page_id: null, business_phone: "P1", created_at: old });
  await db.saveListing({ listing_id: "B", source: "whatsapp", status: "active", page_id: null, business_phone: "P2", created_at: old,
    city: "באר שבע", rooms: 3, price: 1250000 });
  await db.saveListing({ listing_id: "C", source: "whatsapp", status: "active", page_id: null, business_phone: "P3", created_at: new Date(now) });
  await db.saveDraft({ phone: "P1", status: "building", mode: "create", listing_id: "A", fields: {}, skipped: [], photos: [] });
  await router.sweepStuckBuilds(now);
  assert.deepEqual([(await db.getListing("A")).status, (await db.getListing("B")).status, (await db.getListing("C")).status],
    ["failed", "failed", "active"], "only listings past the timeout fail");
  const d1 = await db.getDraft("P1");
  assert.deepEqual([d1.status, d1.mode, d1.listing_id], ["active", null, null], "the draft that built it can retry");
  assert.match(msgs.find(([p]) => p === "P1")[1], /ליצור/);
  assert.match(msgs.find(([p]) => p === "P2")[1], /בניית הדף \(3 חד׳ בבאר שבע, ₪1,250,000\) נכשלה/, "names the property");
  msgs.length = 0;
  await router.sweepStuckBuilds(now);
  assert.equal(msgs.length, 0, "a failed listing is reported once");

  // ── a reply's links go as URL buttons; the plain fallback spells them out ──
  {
    const rich = [], plain = [];
    const r2 = createWhatsappRouter({ authSecret: "s", sweep: false, normalizeAuthPhone: (p) => p, signSession: auth.signSession,
      sendWhatsApp: async (p, m) => plain.push(m), sendButtons: async (p, payload) => rich.push(payload) });
    await r2.sendReply("P9", { text: "מלאו ידנית.", links: [{ text: "למילוי ידני", url: "https://a/create.html" }] });
    assert.equal(plain.length, 0);
    assert.equal(rich[0].body, "מלאו ידנית.");
    assert.deepEqual(rich[0].buttons, [{ type: "url", buttonText: "למילוי ידני", url: "https://a/create.html", buttonId: "1" }]);
    const r3 = createWhatsappRouter({ authSecret: "s", sweep: false, normalizeAuthPhone: (p) => p, signSession: auth.signSession,
      sendWhatsApp: async (p, m) => plain.push(m), sendButtons: async () => { throw new Error("rejected"); } });
    const warn = console.warn; console.warn = () => {};
    try { await r3.sendReply("P9", { text: "מלאו ידנית.", links: [{ text: "למילוי ידני", url: "https://a/create.html" }] }); }
    finally { console.warn = warn; }
    assert.equal(plain[0], "מלאו ידנית.\nלמילוי ידני: https://a/create.html", "the link is never lost");
  }

  // ── dev-only test video: production chat listings still get a generated walkthrough ──
  const { createListing } = require("../listing-create");
  const hooks = [];
  const base = { n8nWw1Webhook: "https://n8n/ww1", n8nPipelineWebhook: "https://n8n/pipe", baseUrl: "https://srv", source: "whatsapp",
    fetchFn: async (url) => { hooks.push(url); return { status: 200 }; } };
  const listing = { city: "חיפה", price: 1500000, rooms: 4, photos_urls: ["a", "b", "c", "d"] };
  const prod = await createListing("P9", listing, null, base);
  const dev = await createListing("P9", listing, null, { ...base, isDevRun: true });
  await new Promise((r) => setImmediate(r));
  assert.equal((await db.getListing(prod.listing_id)).own_video_url, null, "production never uses the test video");
  assert.match((await db.getListing(dev.listing_id)).own_video_url, /^https:\/\/srv\/files\/pages\/.+\/walkthrough\.mp4$/);
  assert.deepEqual(hooks, ["https://n8n/ww1", "https://n8n/pipe"], "prod generates (WW1), dev reuses the video (page pipeline)");

  console.log("routes/whatsapp.test.js ok");
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
