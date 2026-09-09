/* listing-sources.js — where an input goes and what comes back. No network:
   fetch, graphCall and getConnection are stubbed. */
const assert = require("assert");
const S = require("./listing-sources");
const { sourceFor, facebookPostId, listingImages, isPrivateIp } = S._test;

// ── routing by host ──
assert.equal(sourceFor({ text: "3 חדרים" }), "text");
assert.equal(sourceFor({ url: "https://www.facebook.com/golan.nadlan/posts/123" }), "facebook");
assert.equal(sourceFor({ url: "https://fb.watch/abc" }), "facebook");
assert.equal(sourceFor({ url: "https://www.yad2.co.il/item/abc" }), "scrape");
assert.equal(sourceFor({ url: "https://www.madlan.co.il/listings/x" }), "scrape");
assert.throws(() => sourceFor({ url: "ftp://x" }), (e) => e.code === "invalid_input");
assert.throws(() => sourceFor({}), (e) => e.code === "invalid_input");

// ── SSRF guard ──
assert.equal(isPrivateIp("127.0.0.1"), true);
assert.equal(isPrivateIp("10.1.2.3"), true);
assert.equal(isPrivateIp("172.20.0.1"), true);
assert.equal(isPrivateIp("192.168.1.1"), true);
assert.equal(isPrivateIp("169.254.169.254"), true);
assert.equal(isPrivateIp("::1"), true);
assert.equal(isPrivateIp("8.8.8.8"), false);

// ── facebook post id from the common URL shapes ──
assert.equal(facebookPostId("https://www.facebook.com/golan/posts/10159"), "10159");
assert.equal(facebookPostId("https://www.facebook.com/golan/posts/pfbid0abcDEF"), "pfbid0abcDEF");
assert.equal(facebookPostId("https://www.facebook.com/permalink.php?story_fbid=555&id=777"), "555");
assert.equal(facebookPostId("https://www.facebook.com/photo/?fbid=999&set=a.1"), "999");
assert.equal(facebookPostId("https://www.facebook.com/photo.php?fbid=888"), "888");
assert.equal(facebookPostId("https://www.facebook.com/golan"), null);

// ── image filtering from scraped markdown ──
const md = `# דירה
![](https://img.yad2.co.il/Pic/1.jpg)
![logo](https://cdn.site/logo.png)
![](https://cdn.site/icons/sprite.svg)
![](https://cdn.site/pixel.gif)
![](https://img.yad2.co.il/Pic/1.jpg)
![](https://img.yad2.co.il/Pic/2.jpeg?w=800)`;
assert.deepEqual(listingImages(md), ["https://img.yad2.co.il/Pic/1.jpg", "https://img.yad2.co.il/Pic/2.jpeg?w=800"]);
assert.equal(listingImages(Array.from({ length: 30 }, (_, i) => `![](https://c/${i}.jpg)`).join("\n")).length, 12);

(async () => {
  // ── plain text ──
  const t = await S.resolve({ text: "  3 חדרים בהרצל  " }, {});
  assert.deepEqual(t, { source: "text", text: "3 חדרים בהרצל", description: "3 חדרים בהרצל", photos: [] });

  // ── firecrawl: happy path ──
  let fcReq;
  const fetchOk = async (url, opts) => {
    fcReq = { url, opts };
    return { ok: true, json: async () => ({ success: true, data: { markdown: "דירת 4 חדרים\n![](https://c/a.jpg)", metadata: { description: "meta desc" } } }) };
  };
  const sc = await S.resolve({ url: "https://www.yad2.co.il/item/1" }, { fetchFn: fetchOk, firecrawlKey: "k", lookup: async () => [{ address: "1.2.3.4" }] });
  assert.equal(sc.source, "scrape");
  assert.equal(sc.text, "דירת 4 חדרים\n![](https://c/a.jpg)");
  assert.equal(sc.description, "meta desc");
  assert.deepEqual(sc.photos, [{ url: "https://c/a.jpg", source: "scrape" }]);
  assert.equal(fcReq.url, "https://api.firecrawl.dev/v1/scrape");
  assert.equal(fcReq.opts.headers.Authorization, "Bearer k");
  assert.equal(JSON.parse(fcReq.opts.body).url, "https://www.yad2.co.il/item/1");

  // ── firecrawl: blocked / empty → page_unreadable; no key → extract_unavailable; private host → invalid_input ──
  const fetchEmpty = async () => ({ ok: true, json: async () => ({ success: true, data: { markdown: "   " } }) });
  await assert.rejects(S.resolve({ url: "https://x.co/1" }, { fetchFn: fetchEmpty, firecrawlKey: "k", lookup: async () => [{ address: "1.2.3.4" }] }), (e) => e.code === "page_unreadable");
  const fetchFail = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(S.resolve({ url: "https://x.co/1" }, { fetchFn: fetchFail, firecrawlKey: "k", lookup: async () => [{ address: "1.2.3.4" }] }), (e) => e.code === "page_unreadable");
  await assert.rejects(S.resolve({ url: "https://x.co/1" }, { fetchFn: fetchOk, firecrawlKey: "", lookup: async () => [{ address: "1.2.3.4" }] }), (e) => e.code === "extract_unavailable");
  await assert.rejects(S.resolve({ url: "http://169.254.169.254/latest" }, { fetchFn: fetchOk, firecrawlKey: "k", lookup: async () => [{ address: "169.254.169.254" }] }), (e) => e.code === "invalid_input");

  // ── facebook: connected page, post with attachments ──
  const graph = [];
  const graphCall = async (pathname, opts) => {
    graph.push({ pathname, opts });
    return {
      message: "למכירה 3 חדרים",
      attachments: { data: [
        { media: { image: { src: "https://scontent/a.jpg" } }, subattachments: { data: [
          { media: { image: { src: "https://scontent/b.jpg" } } },
          { media: { image: { src: "https://scontent/a.jpg" } } },
        ] } },
      ] },
    };
  };
  const fb = await S.resolve({ url: "https://www.facebook.com/golan/posts/123", userId: "0501234567" },
    { graphCall, getConnection: async () => ({ page_id: "777", page_token: "PT" }) });
  assert.equal(fb.source, "facebook");
  assert.equal(fb.text, "למכירה 3 חדרים");
  assert.equal(fb.description, "למכירה 3 חדרים");
  assert.deepEqual(fb.photos.map((p) => p.url), ["https://scontent/a.jpg", "https://scontent/b.jpg"]);
  assert.equal(graph[0].pathname, "/777_123");
  assert.equal(graph[0].opts.token, "PT");
  assert.match(graph[0].opts.params.fields, /attachments\{media,subattachments\{media\}\}/);

  // ── facebook: pfbid slugs are passed through untouched; numeric ids fall back to the bare id ──
  const graph2 = [];
  const graphCall2 = async (pathname) => { graph2.push(pathname); return { message: "x", attachments: { data: [] } }; };
  const fb2 = await S.resolve({ url: "https://www.facebook.com/golan/posts/pfbid0ABC", userId: "u" },
    { graphCall: graphCall2, getConnection: async () => ({ page_id: "777", page_token: "PT" }) });
  assert.deepEqual(graph2, ["/pfbid0ABC"]);           // pfbid is never prefixed
  assert.equal(fb2.text, "x");
  const graph3 = [];
  const graphCall3 = async (pathname) => {
    graph3.push(pathname);
    if (graph3.length === 1) { const e = new Error("no"); e.code = 100; throw e; }
    return { message: "y", attachments: { data: [] } };
  };
  await S.resolve({ url: "https://www.facebook.com/golan/posts/123", userId: "u" },
    { graphCall: graphCall3, getConnection: async () => ({ page_id: "777", page_token: "PT" }) });
  assert.deepEqual(graph3, ["/777_123", "/123"]);

  // ── facebook: not connected / no user / unparseable url / empty post ──
  await assert.rejects(S.resolve({ url: "https://www.facebook.com/golan/posts/123", userId: "u" }, { graphCall, getConnection: async () => null }), (e) => e.code === "facebook_not_connected");
  await assert.rejects(S.resolve({ url: "https://www.facebook.com/golan/posts/123" }, { graphCall, getConnection: async () => ({ page_token: "PT" }) }), (e) => e.code === "facebook_not_connected");
  await assert.rejects(S.resolve({ url: "https://www.facebook.com/golan", userId: "u" }, { graphCall, getConnection: async () => ({ page_id: "1", page_token: "PT" }) }), (e) => e.code === "page_unreadable");
  await assert.rejects(S.resolve({ url: "https://www.facebook.com/golan/posts/5", userId: "u" }, { graphCall: async () => ({}), getConnection: async () => ({ page_id: "1", page_token: "PT" }) }), (e) => e.code === "page_unreadable");
  console.log("listing-sources.test.js ok");
})();
