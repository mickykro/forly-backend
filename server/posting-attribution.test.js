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
function call(a, method, p, { body, cookie, ip = IP, ua } = {}) {
  return new Promise((resolve, reject) => {
    const server = a.listen(0, () => {
      const headers = { "content-type": "application/json", "x-forwarded-for": ip };
      if (cookie) headers.cookie = cookie;
      if (ua) headers["user-agent"] = ua;
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
function fakeReq(c, ip, headers = {}) { return { query: { c }, headers: Object.assign({ "x-forwarded-for": ip }, headers), socket: { remoteAddress: "127.0.0.1" } }; }
function fakeRes() { const r = { cookies: [], append(k, v) { if (k === "Set-Cookie") r.cookies.push(v); return r; }, set() { return r; } }; return r; }
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

  // ── fix round 1: the proxy-seen IP, a held cookie, the daily cap, ref reuse, crawlers, a failed event ──
  {
    const C2 = "a1".repeat(16);
    const a2 = await reserve("555", C2);
    const count = (key) => visits().filter((e) => e.attempt_key === key).length;
    // the client-controlled leftmost X-Forwarded-For entry does not make a new visitor
    for (let i = 0; i < 5; i++) await call(A, "GET", `/p/pg1?c=${C2}`, { ip: `10.0.0.${i}, 192.0.2.10` });
    assert.equal(count(a2.key), 1, "varying the leftmost XFF entry records one visit");
    // a curl loop from one visitor reuses its ref: no new attribution_refs docs
    const before = AT._test.maps.attribution_refs.size;
    const refs = new Set();
    for (let i = 0; i < 10; i++) refs.add(setCookie(await call(A, "GET", `/p/pg1?c=${C2}`, { ip: "192.0.2.10" }))[0].match(COOKIE_RE)[1]);
    assert.equal(refs.size, 1); assert.equal(AT._test.maps.attribution_refs.size, before, "no doc per request");
    // a live fly_ref for this click: no visit, whatever the IP
    const held = [...refs][0];
    for (const ip of ["192.0.2.11", "192.0.2.12"]) {
      const r = await call(A, "GET", `/p/pg1?c=${C2}`, { ip, cookie: `fly_ref=${held}` });
      assert.equal(r.status, 302); assert.equal(setCookie(r)[0].match(COOKIE_RE)[1], held);
    }
    assert.equal(count(a2.key), 1, "a request with a live cookie records none");
    assert.equal(AT._test.maps.attribution_refs.size, before);

    // link-preview crawlers: a 302, no cookie, nothing recorded
    const UAS = ["facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "Facebot", "WhatsApp/2.23.20.0 A", "TelegramBot (like TwitterBot)",
      "Twitterbot/1.0", "Slackbot-LinkExpanding 1.0", "LinkedInBot/1.0", "Mozilla/5.0 (compatible; Discordbot/2.0)", "SomeCrawler/1", "my-spider", "Link Preview Fetcher", "Googlebot/2.1"];
    const refsBefore = AT._test.maps.attribution_refs.size, visitsBefore = visits().length;
    for (const ua of UAS) {
      const res = fakeRes();
      assert.equal(await AT.consumeClick(fakeReq(C2, "192.0.2.50", { "user-agent": ua }), res, "pg1"), true, ua);
      assert.equal(res.cookies.length, 0, ua);
    }
    const bot = await call(A, "GET", `/p/pg1?c=${C2}`, { ip: "192.0.2.51", ua: "facebookexternalhit/1.1" });
    assert.equal(bot.status, 302); assert.equal(bot.headers.location, "/p/pg1"); assert.equal(setCookie(bot).length, 0);
    assert.equal(visits().length, visitsBefore); assert.equal(AT._test.maps.attribution_refs.size, refsBefore);
    const human = fakeRes();
    await AT.consumeClick(fakeReq(C2, "192.0.2.52", { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1" }), human, "pg1");
    assert.equal(human.cookies.length, 1, "a phone browser is a visitor");

    // the daily cap: at most DAY_CAP counted visits per click; beyond it, still a cookie
    const C3 = "b2".repeat(16);
    const a3c = await reserve("666", C3);
    let lastRes;
    for (let i = 0; i < AT.DAY_CAP + 5; i++) {
      lastRes = fakeRes();
      assert.equal(await AT.consumeClick(fakeReq(C3, `198.18.${Math.floor(i / 250)}.${i % 250}`), lastRes, "pg1"), true);
    }
    assert.equal(count(a3c.key), AT.DAY_CAP, "the cap holds");
    assert.equal(lastRes.cookies.length, 1, "beyond the cap the visitor still gets a cookie");
    assert.ok(COOKIE_RE.test(lastRes.cookies[0]));

    // a failed event write keeps the cookie
    const C4 = "c3".repeat(16);
    await reserve("777", C4);
    const failing = { logPortalEvent: async () => { throw Object.assign(new Error("unavailable"), { code: "unavailable" }); } };
    const r4 = fakeRes();
    assert.equal(await AT.consumeClick(fakeReq(C4, "192.0.2.60"), r4, "pg1", { db: failing }), true);
    assert.equal(r4.cookies.length, 1, "logPortalEvent failing never loses the cookie");

    // visitorIp: the entry our proxies appended; the socket without XFF
    assert.equal(AT.visitorIp({ headers: { "x-forwarded-for": "6.6.6.6, 1.1.1.1" } }, {}), "1.1.1.1");
    assert.equal(AT.visitorIp({ headers: { "x-forwarded-for": "6.6.6.6, 1.1.1.1, 2.2.2.2" } }, { POSTING_PROXY_HOPS: "2" }), "1.1.1.1");
    assert.equal(AT.visitorIp({ headers: { "x-forwarded-for": " , 1.1.1.1 ,," } }, { POSTING_PROXY_HOPS: "0" }), "1.1.1.1", "empty entries dropped; hops >= 1");
    assert.equal(AT.visitorIp({ headers: { "x-forwarded-for": "1.1.1.1" } }, { POSTING_PROXY_HOPS: "5" }), "1.1.1.1");
    assert.equal(AT.visitorIp({ headers: {}, socket: { remoteAddress: "::1" } }, {}), "::1");
    const stored2 = JSON.stringify([[...AT._test.maps.click_visits.entries()], [...AT._test.maps.attribution_refs.entries()], db.mem.portalEvents]);
    assert.ok(!/192\.0\.2\.|198\.18\.|10\.0\.0\./.test(stored2), "still no raw IP stored");
  }

  console.log("posting-attribution.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
