/* posting-attribution.js — R4 end to end through the real routes: the click
   doc written with the reservation, GET /p/:id?c= (fabricated / expired /
   wrong-page → nothing; valid → one event, the exact cookie, a 302 without
   `c`; a refresh stays one event), and lead creation resolving fly_ref
   server-side (a body claiming a campaign is ignored). No raw IP stored. */
process.env.PROFILE_KEY = "test-profile-key-22";
process.env.FORLY_ENV = "local";
const assert = require("assert");
const path = require("path");
const http = require("http");
const express = require("express");
const db = require("./db");
const store = require("./posting-store");
const AT = require("./posting-attribution");
const createPagesRouter = require("./routes/pages");

const PH = "972500000001";
const DAY = 86400000;
const T0 = new Date("2026-09-23T10:00:00+03:00");
const IP = "203.0.113.77";
const HEX = /^[0-9a-f]{32}$/;
const COOKIE_RE = /^fly_ref=([0-9a-f]{32}); HttpOnly; Secure; SameSite=Lax; Max-Age=604800; Path=\/$/;

const page = (id, o = {}) => Object.assign({
  page_id: id, status: "active", business_phone: PH, created_at: new Date(T0.getTime() - DAY), theme: { template: "original" },
  property: { title: "דירה", address: "הרצל 1", city: "חיפה", listing_type: "sale" }, agent: { name: "דנה", phone: "0500000000" },
}, o);

async function reserve(target_id, click_id, now = T0, page_id = "pg1") {
  const r = await store.reserveAttempt({
    phone: PH, page_id, target_type: "group", target_id, target_url: `https://www.facebook.com/groups/${target_id}`,
    publisher: "browser", campaign_id: "camp1", post_id: `p${target_id}`, click_id, now,
    limits: { daily_cap: 10, group_global_daily_cap: 10 },
  });
  assert.ok(r.ok, r.reason);
  return r.attempt;
}

function app() {
  const a = express();
  a.set("trust proxy", true);
  a.use(express.json());
  a.use(createPagesRouter({
    templatesDir: path.join(__dirname, "../public-nadlan/templates"), pageBaseUrl: "https://f.ly", baseUrl: "https://f.ly",
    requireAuth: () => (_q, _r, n) => n(), normalizeAuthPhone: (v) => v, adminPhones: [], authSecret: "test-auth",
  }));
  return a;
}
function call(a, method, p, { body, cookie, ip = IP } = {}) {
  return new Promise((resolve, reject) => {
    const server = a.listen(0, () => {
      const headers = { "content-type": "application/json", "x-forwarded-for": ip };
      if (cookie) headers.cookie = cookie;
      const req = http.request({ port: server.address().port, path: p, method, headers }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => { server.close(); resolve({ status: res.statusCode, headers: res.headers, raw: d }); });
      });
      req.on("error", (e) => { server.close(); reject(e); });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  });
}
const visits = () => db.mem.portalEvents.filter((e) => e.type === "group_visit" && e.attempt_key);
const setCookie = (r) => r.headers["set-cookie"] || [];

(async () => {
  store._test.reset(); AT._test.reset();
  db.mem.pages.clear(); db.mem.portalEvents.length = 0; db.mem.leadSubmissions.length = 0; db.mem.throttle.clear();
  await db.savePage(page("pg1"));
  await db.savePage(page("pg2"));

  // ── the click doc is written with the reservation (R4) ──
  const C1 = "c".repeat(32), C_OLD = "d".repeat(32), C_PG2 = "e".repeat(32);
  const a1 = await reserve("111", C1);
  assert.deepEqual(await store.getClick(C1), {
    campaign_id: "camp1", attempt_key: a1.key, page_id: "pg1", group_id: "111",
    issued_at: T0.toISOString(), expires_at: new Date(T0.getTime() + 30 * DAY).toISOString(),
  });
  assert.equal(await store.getClick("f".repeat(32)), null);
  assert.equal(await store.getClick("../x"), null);
  await reserve("222", C_OLD, new Date(Date.now() - 31 * DAY)); // expired by now
  await reserve("333", C_PG2, T0, "pg2");

  const A = app();
  // ── fabricated, malformed, expired, wrong-page c= → a normal page view, nothing recorded, no cookie ──
  for (const q of ["f".repeat(32), "nothex", C_OLD]) {
    const r = await call(A, "GET", `/p/pg1?c=${q}`);
    assert.equal(r.status, 200, q);
    assert.equal(setCookie(r).length, 0, q);
  }
  const wrong = await call(A, "GET", `/p/pg1?c=${C_PG2}`);
  assert.equal(wrong.status, 200); assert.equal(setCookie(wrong).length, 0, "a click for another page is not this page's");
  assert.equal(visits().length, 0);
  assert.equal(AT._test.maps.attribution_refs.size, 0);

  // ── a valid c= → one event, the exact cookie, a 302 to the page without c ──
  const r1 = await call(A, "GET", `/p/pg1?c=${C1}&utm_source=x`);
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.location, "/p/pg1?utm_source=x", "c is consumed, never forwarded");
  assert.equal(setCookie(r1).length, 1);
  const m = setCookie(r1)[0].match(COOKIE_RE);
  assert.ok(m, `cookie flags exact: ${setCookie(r1)[0]}`);
  const ref = m[1];
  assert.ok(HEX.test(ref) && ref !== C1, "fly_ref is its own random ref, never the click id");
  assert.equal(visits().length, 1);
  const ev = visits()[0];
  assert.deepEqual(Object.keys(ev).sort(), ["at", "attempt_key", "campaign_id", "group_id", "type"]);
  assert.deepEqual({ ...ev, at: undefined }, { type: "group_visit", attempt_key: a1.key, campaign_id: "camp1", group_id: "111", at: undefined });
  const refDoc = AT._test.maps.attribution_refs.get(ref);
  assert.equal(refDoc.click_id, C1);
  assert.equal(Date.parse(refDoc.expires_at) - Date.parse(refDoc.created_at), 7 * DAY);

  // ── a refresh (same visitor, within 30 min) → still one event; the same ref is kept ──
  const r2 = await call(A, "GET", `/p/pg1?c=${C1}`, { cookie: `fly_ref=${ref}` });
  assert.equal(r2.status, 302); assert.equal(r2.headers.location, "/p/pg1");
  assert.equal(setCookie(r2)[0].match(COOKIE_RE)[1], ref);
  const r3 = await call(A, "GET", `/p/pg1?c=${C1}`);
  assert.equal(r3.status, 302);
  assert.equal(visits().length, 1, "a refresh loop does not inflate the count");
  // another visitor counts
  await call(A, "GET", `/p/pg1?c=${C1}`, { ip: "198.51.100.5" });
  assert.equal(visits().length, 2);

  // ── a portfolio page: the 302 goes to the nested URL, without c ──
  await db.savePage(page("pg3", { public_slug: "herzl-1" }));
  const a3 = await reserve("444", "b".repeat(32), T0, "pg3");
  const origBiz = db.getBusiness;
  db.getBusiness = async () => ({ portfolio: { slug: "dana" } });
  try {
    const n = await call(A, "GET", `/p/pg3?c=${"b".repeat(32)}&x=1`);
    assert.equal(n.status, 302); assert.equal(n.headers.location, "/dana/herzl-1?x=1");
    assert.ok(COOKIE_RE.test(setCookie(n)[0]));
    const bad = await call(A, "GET", `/p/pg3?c=${"f".repeat(32)}&x=1`);
    assert.equal(bad.status, 301); assert.equal(bad.headers.location, "/dana/herzl-1?x=1"); assert.equal(setCookie(bad).length, 0);
  } finally { db.getBusiness = origBiz; }

  // ── no raw IP anywhere we store ──
  const stored = JSON.stringify([[...AT._test.maps.click_visits.entries()], [...AT._test.maps.attribution_refs.entries()], db.mem.portalEvents, [...store._test.maps.click_ids.entries()]]);
  assert.ok(!stored.includes(IP) && !stored.includes("198.51.100.5"), "the raw IP is never stored");

  // ── lead creation: fly_ref → attribution, server-side ──
  const lead = (phone, extra = {}, cookie) => call(A, "POST", "/api/property-lead", { body: Object.assign({ page_id: "pg1", name: "ישראל", phone }, extra), cookie });
  let r = await lead("0521111111", {}, `other=1; fly_ref=${ref}`);
  assert.equal(r.status, 200, r.raw);
  let sub = db.mem.leadSubmissions.at(-1);
  assert.deepEqual(sub.attribution, { campaign_id: "camp1", attempt_key: a1.key, group_id: "111" });
  assert.equal(sub.source, "landing_page", "the source enum is unchanged");

  // a body (or query) claiming a campaign is ignored
  r = await call(A, "POST", `/api/property-lead?campaign_id=camp1&attempt_key=${a1.key}`, { body: { page_id: "pg1", name: "משה", phone: "0522222222", attribution: { campaign_id: "camp1", attempt_key: a1.key, group_id: "111" }, campaign_id: "camp1", source: "campaign" } });
  assert.equal(r.status, 200);
  sub = db.mem.leadSubmissions.at(-1);
  assert.equal(sub.attribution, undefined); assert.equal(sub.source, "landing_page");
  // a fabricated ref, and a real ref on another page's lead, attribute nothing
  await lead("0523333333", {}, `fly_ref=${"9".repeat(32)}`);
  assert.equal(db.mem.leadSubmissions.at(-1).attribution, undefined);
  await lead("0524444444", { page_id: "pg2" }, `fly_ref=${ref}`);
  assert.equal(db.mem.leadSubmissions.at(-1).attribution, undefined, "a click for pg1 does not attribute a pg2 lead");
  // an expired ref attributes nothing
  const later = { clock: () => new Date(Date.now() + 8 * DAY) };
  assert.equal(await AT.attributionFor({ headers: { cookie: `fly_ref=${ref}` } }, "pg1", later), null);
  assert.ok(await AT.attributionFor({ headers: { cookie: `fly_ref=${ref}` } }, "pg1"));

  // ── the counts posting-metrics reads ──
  assert.deepEqual(await AT.countGroupVisits("camp1"), { [a1.key]: 2, [a3.key]: 1 });
  assert.deepEqual(await AT.countLeadsByAttribution("camp1"), { [a1.key]: 1 });
  assert.deepEqual(await AT.countGroupVisits("other"), {});

  console.log("posting-attribution.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
