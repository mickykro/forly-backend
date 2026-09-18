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

  console.log("routes/whatsapp.test.js ok");
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
