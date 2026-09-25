/* listing-driver.js — a rendered page in, the firecrawl-shaped result out.
   No browser: withPage and the page object are stubbed. */
const assert = require("assert");
const LD = require("./listing-driver");
const { pickImages, isLoginWall } = LD._test;

// ── image picking: same rules as the markdown path, applied to <img> srcs ──
assert.deepEqual(
  pickImages([
    "https://img.yad2.co.il/Pic/1.jpg",
    "https://img.yad2.co.il/Pic/1.jpg",          // duplicate
    "https://cdn.yad2.co.il/assets/logo.png",    // NOT_LISTING
    "https://img.yad2.co.il/Pic/2.webp",
    "data:image/png;base64,AAAA",                // not http(s)
    "https://img.yad2.co.il/Pic/3.svg",          // wrong extension
  ]),
  ["https://img.yad2.co.il/Pic/1.jpg", "https://img.yad2.co.il/Pic/2.webp"],
);

// ── login walls, by landing URL and by page text ──
assert.equal(isLoginWall("https://www.facebook.com/login/?next=%2Fgroups%2F1", "התחברות"), true);
assert.equal(isLoginWall("https://www.instagram.com/accounts/login/", "Log in"), true);
assert.equal(isLoginWall("https://www.yad2.co.il/item/abc", "דירה 4 חדרים"), false);

(async () => {
  // ── happy path: text + photos, firecrawl-compatible shape ──
  const page = {
    goto: async () => {},
    url: () => "https://www.yad2.co.il/item/abc",
    innerText: async () => "דירה 4 חדרים\nמחיר:2,200,000 ₪\nקומה:2",
    imageSrcs: async () => ["https://img.yad2.co.il/Pic/1.jpg"],
  };
  const withPage = async (opts, fn) => fn(page, { sessionId: "s1", cdpUrl: "ws://x" });
  const out = await LD.fromDriver({ url: "https://www.yad2.co.il/item/abc" }, { withPage });
  assert.equal(out.source, "driver");
  assert.ok(out.text.includes("2,200,000"));
  assert.equal(out.description, out.text);
  assert.deepEqual(out.photos, [{ url: "https://img.yad2.co.il/Pic/1.jpg", source: "driver" }]);

  // ── an empty page is an error, not an empty success ──
  const blank = { goto: async () => {}, url: () => "https://www.madlan.co.il/x", innerText: async () => "   ", imageSrcs: async () => [] };
  await assert.rejects(
    LD.fromDriver({ url: "https://www.madlan.co.il/x" }, { withPage: async (o, fn) => fn(blank, {}) }),
    (e) => e.code === "page_unreadable",
  );

  // ── a login wall is its own code, so the route can point at the connect flow ──
  const wall = {
    goto: async () => {}, url: () => "https://www.facebook.com/login/?next=x",
    innerText: async () => "התחברות לפייסבוק", imageSrcs: async () => [],
  };
  await assert.rejects(
    LD.fromDriver({ url: "https://www.facebook.com/groups/1/posts/2", profileName: "facebook-0500000000" },
      { withPage: async (o, fn) => fn(wall, {}) }),
    (e) => e.code === "social_login_required",
  );

  // ── the profile and browser type reach the session options ──
  let seen = null;
  await LD.fromDriver(
    { url: "https://www.facebook.com/groups/1/posts/2", profileName: "facebook-0500000000", browserType: "hosted_stealth" },
    { withPage: async (opts, fn) => { seen = opts; return fn(page, {}); } },
  );
  assert.deepEqual(seen.profile, { name: "facebook-0500000000", persist: true });
  assert.equal(seen.type, "hosted_stealth");
  assert.equal(seen.country, "IL");
  assert.ok(String(seen.note || "").startsWith("forly-extract:"));

  // ── whose profile it is rides through to withPage, so it can assert ownership ──
  let third = null;
  await LD.fromDriver(
    { url: "https://www.facebook.com/groups/1/posts/2", profileName: "facebook-0500000000" },
    { withPage: async (opts, fn, d) => { third = d; return fn(page, {}); }, phone: "0500000000", platform: "facebook", lockHeld: true, forceSource: "driver" },
  );
  assert.deepEqual(third, { phone: "0500000000", platform: "facebook", lockHeld: true, conn: null });

  // ── I2: the connection rides through too, and the real withPage checks the
  //    generation against it: gen 1 opens; a quarantined gen-0 profile is refused ──
  {
    process.env.FORLY_ENV = process.env.FORLY_ENV || "local";
    const D = require("./driver-browser");
    const { profileName } = require("./profile-name");
    const calls = [];
    const fake = {
      apiKey: "k", sleep: async () => {},
      fetchFn: async (url, init) => { calls.push(init.method); return { ok: true, headers: { get: () => null }, json: async () => (init.method === "DELETE" ? { success: true } : { sessionId: "s1", status: "active", cdpUrl: "wss://x/y" }) }; },
      connectOverCDP: async () => ({ contexts: () => [{ pages: () => [page] }], close: async () => {} }),
    };
    const real = (o, fn, d) => D.withPage(o, fn, Object.assign({}, d, fake));
    const PH = "0500000002";
    const gen1 = { facebook_profile_gen: 1 };
    const ok = await LD.fromDriver({ url: "https://www.facebook.com/groups/1/posts/2", profileName: profileName("facebook", PH, 1) },
      { withPage: real, phone: PH, platform: "facebook", conn: gen1 });
    assert.equal(ok.source, "driver");
    assert.deepEqual(calls, ["POST", "DELETE"]);
    calls.length = 0;
    await assert.rejects(() => LD.fromDriver({ url: "https://www.facebook.com/groups/1/posts/2", profileName: profileName("facebook", PH, 0) },
      { withPage: real, phone: PH, platform: "facebook", conn: { facebook_profile_state: "quarantined" } }), (e) => e.code === "profile_ownership");
    await assert.rejects(() => LD.fromDriver({ url: "https://www.facebook.com/groups/1/posts/2", profileName: profileName("facebook", PH, 0) },
      { withPage: real, phone: PH, platform: "facebook", conn: gen1 }), (e) => e.code === "profile_ownership", "the old generation's name");
    assert.deepEqual(calls, [], "no Driver session for a refused profile");
  }

  console.log("listing-driver.test.js ok");
})();
