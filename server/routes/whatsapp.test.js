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
  assert.match(msgs.find(([p]) => p === "P2")[1], /הדף \(3 חד׳ בבאר שבע, ₪1,250,000\) עדיין לא מוכן[\s\S]*צוות Forly בודק/, "names the property; the team takes it");
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

  // ── intake: one numbered message per turn; unclaimed turns carry edit_photos + context; stop flag ──
  {
    const express = require("express");
    db.getBusiness = async () => ({ phone: "P9" });
    const out = [];
    const app = express().use(express.json()).use("/w", createWhatsappRouter({
      authSecret: "s", n8nSecret: "k", sweep: false, normalizeAuthPhone: (p) => p, signSession: auth.signSession,
      sendWhatsApp: async (p, m) => out.push(m), baseUrl: "https://agent" }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/w`;
    const post = (body) => fetch(`${base}/intake`, { method: "POST", headers: { "content-type": "application/json", "x-forly-secret": "k" },
      body: JSON.stringify({ phone: "P9", ...body }) }).then((r) => r.json());
    await db.saveDraft({ phone: "P9", status: "offered", source: "photos", fields: {}, skipped: [], photos: ["a", "b", "c", "d"],
      offer_sent: true, last_buttons: ["כן", "לא"], updated_at: new Date(), created_at: new Date() });
    let r = await post({ message: "1" });
    assert.equal(r.handled, true, "'1' answers the first option");
    assert.equal(out.length, 1, "one WhatsApp message for the whole turn");
    await db.saveDraft({ phone: "P9", status: "photo_choice", photos: ["https://g/1.jpg", "https://g/2.jpg"], updated_at: new Date(), created_at: new Date() });
    r = await post({ message: "3" });
    assert.deepEqual([r.handled, r.edit_photos, r.edit_instruction], [false, ["https://g/1.jpg", "https://g/2.jpg"], ""]);
    assert.match(r.context, /דפי הנכס של הסוכן: אין/);
    assert.equal(await db.getDraft("P9"), null, "the held photos are released to n8n");
    const since = new Date(Date.now() - 1000).toISOString();
    r = await post({ message: "עצור" });
    assert.equal(r.status, "stopped");
    const c = await fetch(`${base}/edit-cancel?phone=P9&since=${encodeURIComponent(since)}`, { headers: { "x-forly-secret": "k" } }).then((x) => x.json());
    assert.equal(c.cancel, true);
    server.close();
  }

  // ── staging (LINK_BASE_URL = production): agents get production links, never staging's ──
  {
    const express = require("express");
    const D = require("../property-draft");
    db.getBusiness = async () => ({ phone: "P8" });
    const out = [];
    const app = express().use(express.json()).use("/w", createWhatsappRouter({
      authSecret: "s", n8nSecret: "k", sweep: false, normalizeAuthPhone: (p) => p, signSession: auth.signSession,
      sendWhatsApp: async (p, m) => out.push(m), baseUrl: "https://staging.example", linkBaseUrl: "https://prod.example" }));
    const server = app.listen(0);
    const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/w/intake`, { method: "POST",
      headers: { "content-type": "application/json", "x-forly-secret": "k" }, body: JSON.stringify({ phone: "P8", ...body }) }).then((r) => r.json());
    const ready = D.newDraft("P8", "text");
    Object.assign(ready.fields, { city: "חיפה", price: 2000000, rooms: 3, deal: "sale", size_sqm: 80, floor: 2, parking: 1, neighborhood: "כרמל", description: "d" });
    ready.photos = ["a", "b", "c", "d"];
    await db.saveDraft(ready);
    const r = await post({ message: "תצוגה מקדימה" });
    assert.match(r.reply, /https:\/\/prod\.example\/create\.html\?whatsapp=1/, "different signing key: the create form");
    assert.doesNotMatch(r.reply + out.join(" "), /staging\.example/, "no staging link reaches the agent");
    server.close();
    // same NADLAN_JWT_SECRET on both (LINK_SHARES_SESSION=1): the one-tap review link, on production
    const app2 = express().use(express.json()).use("/w", createWhatsappRouter({
      authSecret: "s", n8nSecret: "k", sweep: false, normalizeAuthPhone: (p) => p, signSession: auth.signSession,
      sendWhatsApp: async () => {}, baseUrl: "https://staging.example", linkBaseUrl: "https://prod.example", linkSharesSession: true }));
    const server2 = app2.listen(0);
    await db.saveDraft(ready);
    const r2 = await fetch(`http://127.0.0.1:${server2.address().port}/w/intake`, { method: "POST",
      headers: { "content-type": "application/json", "x-forly-secret": "k" }, body: JSON.stringify({ phone: "P8", message: "תצוגה מקדימה" }) }).then((x) => x.json());
    assert.match(r2.reply, /https:\/\/prod\.example\/api\/whatsapp\/review\?t=/);
    server2.close();
  }

  // ── staging + production sweep the same Firestore: a stuck build is reported once ──
  {
    const heard = [];
    const mk = () => createWhatsappRouter({ authSecret: "s", sendWhatsApp: async (p, m) => heard.push(p), sweep: false,
      normalizeAuthPhone: (p) => p, signSession: auth.signSession });
    await db.saveListing({ listing_id: "DUP", source: "whatsapp", status: "active", page_id: null, business_phone: "P7",
      created_at: new Date(Date.now() - 25 * 60 * 1000) });
    await Promise.all([mk().sweepStuckBuilds(), mk().sweepStuckBuilds()]);
    assert.equal(heard.filter((p) => p === "P7").length, 1, "two servers, one message");
  }

  // ── the review link signs in and stays on the host it was opened on (nadlan.call4li.com) ──
  {
    const express = require("express");
    const app = express().use("/w", createWhatsappRouter({ authSecret: "s", sweep: false, normalizeAuthPhone: (p) => p,
      signSession: auth.signSession, baseUrl: "https://forly.example" }));
    const server = app.listen(0);
    const t = auth.signSession("s", "972500000001", { scope: "review", ttlS: 60 });
    const r = await fetch(`http://127.0.0.1:${server.address().port}/w/review?t=${encodeURIComponent(t)}`, { redirect: "manual" });
    assert.deepEqual([r.status, r.headers.get("location")], [302, "/create.html?whatsapp=1"]);
    assert.match(r.headers.get("set-cookie") || "", /forly_session=/);
    server.close();
  }

  console.log("routes/whatsapp.test.js ok");
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
