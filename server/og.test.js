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
};
const url = "https://forly.example/p/dana-abc12";
const tags = buildOgTags(page, url);

assert.ok(tags.includes('property="og:title" content="4 חד׳ בבבלי"'));
assert.ok(tags.includes('property="og:url" content="' + url + '"'));
assert.ok(tags.includes('property="og:image" content="https://x.test/poster.jpg"'));
assert.ok(tags.includes('property="og:video" content="https://x.test/v.mp4"'));
assert.ok(tags.includes('property="og:video:type" content="video/mp4"'));
assert.ok(tags.includes('name="twitter:card" content="summary_large_image"'));
assert.ok(tags.includes("og:description"), "description tag present");
assert.ok(tags.includes("4 חדרים"), "description carries the facts");

// no video ⇒ no video tags; no poster ⇒ no image tag; never emits empty content
const noVideo = buildOgTags({ ...page, hero: { poster_url: "https://x.test/p.jpg" } }, url);
assert.ok(!noVideo.includes("og:video"));
const bare = buildOgTags({ property: { title: "t" } }, url);
assert.ok(!bare.includes("og:image"));
assert.ok(!bare.includes('content=""'));

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
