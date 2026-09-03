/*
 * Unit tests for og.js — Open Graph meta tags for /p/:id.
 * Run: node server/og.test.js
 */
const assert = require("assert");
const { buildOgTags, inject } = require("./og");

const page = {
  property: { title: "4 חד׳ בבבלי", neighborhood: "בבלי", city: "תל אביב",
    rooms: 4, size_sqm: 105, price: 4200000 },
  agent: { name: "דנה לוי" },
  hero: { poster_url: "https://x.test/poster.jpg", video_url: "https://x.test/v.mp4" },
  gallery: { images: [{ url: "https://x.test/g1.jpg" }, { url: "https://x.test/g2.jpg" }] },
};
const url = "https://forly.example/p/dana-abc12";
const tags = buildOgTags(page, url);

// title is BUILT from the facts (rooms + area + city + deal type), not the raw page title
assert.ok(tags.includes('property="og:title" content="4 חדרים בבבלי, תל אביב · למכירה"'));
assert.ok(tags.includes('property="og:url" content="' + url + '"'));
// image comes from the GALLERY, not the video poster
assert.ok(tags.includes('property="og:image" content="https://x.test/g1.jpg"'));
assert.ok(!tags.includes("poster.jpg"), "poster not used when a gallery photo exists");
assert.ok(tags.includes('property="og:video" content="https://x.test/v.mp4"'));
assert.ok(tags.includes('property="og:video:type" content="video/mp4"'));
assert.ok(tags.includes('name="twitter:card" content="summary_large_image"'));
assert.ok(tags.includes("og:description"), "description tag present");
assert.ok(tags.includes("4 חדרים"), "description carries the facts");

// hardening tags: locale, secure urls, canonical, and fb:app_id when given
assert.ok(tags.includes('property="og:locale" content="he_IL"'));
assert.ok(tags.includes('property="og:image:secure_url" content="https://x.test/g1.jpg"'));
assert.ok(tags.includes('property="og:video:secure_url" content="https://x.test/v.mp4"'));
assert.ok(tags.includes('<link rel="canonical" href="' + url + '">'));
assert.ok(!tags.includes("fb:app_id"), "no app id tag without opts.appId");
const withApp = buildOgTags(page, url, { appId: "123" });
assert.ok(withApp.includes('property="fb:app_id" content="123"'));

// rent listings say להשכרה
const rent = buildOgTags({ property: { rooms: 3, city: "חיפה", listing_type: "rent" } }, url);
assert.ok(rent.includes("3 חדרים בחיפה · להשכרה"));

// no gallery ⇒ poster fallback; no video ⇒ no video tags; bare page ⇒ no image, no empties
const noGallery = buildOgTags({ ...page, gallery: { images: [] } }, url);
assert.ok(noGallery.includes('property="og:image" content="https://x.test/poster.jpg"'));
const noVideo = buildOgTags({ ...page, hero: { poster_url: "https://x.test/p.jpg" } }, url);
assert.ok(!noVideo.includes("og:video"));
const bare = buildOgTags({ property: { title: "t" } }, url);
assert.ok(!bare.includes("og:image"));
assert.ok(!bare.includes('content=""'));
assert.ok(bare.includes('property="og:title" content="t"'), "no facts ⇒ falls back to page title");

// escaping: titles with quotes/angle brackets can't break out of the attribute
const evil = buildOgTags({ property: { title: '"><script>x</script>' } }, url);
assert.ok(!evil.includes("<script>"));
assert.ok(evil.includes("&quot;&gt;&lt;script&gt;"));

// injection is $-safe (a title containing $& must not expand the match)
const html = "<html><head><title>t</title></head><body></body></html>";
const out = inject(html, { property: { title: "price $& up" } }, url);
assert.ok(out.includes("price $&amp; up"), "replacement-pattern chars survive literally");
assert.ok(out.indexOf("og:title") < out.indexOf("</head>"), "injected inside head");
assert.equal(inject("no head here", page, url), "no head here", "no </head> ⇒ unchanged");

console.log("og.test.js OK");
