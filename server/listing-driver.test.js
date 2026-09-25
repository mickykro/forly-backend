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

  console.log("listing-driver.test.js ok");
})();
