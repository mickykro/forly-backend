/*
 * Unit tests for distribution/instagram.js — container → poll → publish.
 * Run: node server/distribution/instagram.test.js
 */
const assert = require("assert");
const { publishToInstagram } = require("./instagram");

function driver(responses) {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body ? new URLSearchParams(opts.body) : null });
    return { ok: true, json: async () => responses.shift() };
  };
  return { calls, fetchFn, sleep: async () => {} };
}

(async () => {
  // ── video ⇒ REELS container, poll to FINISHED, publish, permalink ──
  {
    const d = driver([
      { id: "C1" },                                  // create container
      { status_code: "IN_PROGRESS" },                // poll 1
      { status_code: "FINISHED" },                   // poll 2
      { id: "MEDIA1" },                              // media_publish
      { permalink: "https://www.instagram.com/p/x/" } // permalink read
    ]);
    const r = await publishToInstagram({ igBusinessId: "IG1", pageToken: "PT",
      snapshot: { video_url: "https://x.test/v.mp4", photo_urls: [], copy: "טקסט" },
      graphVersion: "v21.0", fetchFn: d.fetchFn, sleep: d.sleep });
    assert.equal(r.media_id, "MEDIA1");
    assert.equal(r.permalink, "https://www.instagram.com/p/x/");
    assert.ok(d.calls[0].url.endsWith("/IG1/media"));
    assert.equal(d.calls[0].body.get("media_type"), "REELS");
    assert.equal(d.calls[0].body.get("video_url"), "https://x.test/v.mp4");
    assert.equal(d.calls[0].body.get("caption"), "טקסט");
    assert.ok(d.calls[3].url.endsWith("/IG1/media_publish"));
    assert.equal(d.calls[3].body.get("creation_id"), "C1");
  }

  // ── single photo ⇒ IMAGE container (no carousel) ──
  {
    const d = driver([{ id: "C1" }, { status_code: "FINISHED" }, { id: "M1" }, { permalink: "p" }]);
    await publishToInstagram({ igBusinessId: "IG1", pageToken: "PT",
      snapshot: { video_url: null, photo_urls: ["https://x.test/1.jpg"], copy: "c" },
      graphVersion: "v21.0", fetchFn: d.fetchFn, sleep: d.sleep });
    assert.equal(d.calls[0].body.get("image_url"), "https://x.test/1.jpg");
    assert.equal(d.calls[0].body.get("media_type"), null, "plain image has no media_type");
  }

  // ── 2+ photos ⇒ carousel children + CAROUSEL container ──
  {
    const d = driver([
      { id: "CH1" }, { id: "CH2" },                  // children
      { id: "CAR" }, { status_code: "FINISHED" },    // carousel container + poll
      { id: "M1" }, { permalink: "p" },
    ]);
    await publishToInstagram({ igBusinessId: "IG1", pageToken: "PT",
      snapshot: { video_url: null,
        photo_urls: ["https://x.test/1.jpg", "https://x.test/2.jpg"], copy: "c" },
      graphVersion: "v21.0", fetchFn: d.fetchFn, sleep: d.sleep });
    assert.equal(d.calls[0].body.get("is_carousel_item"), "true");
    assert.equal(d.calls[2].body.get("media_type"), "CAROUSEL");
    assert.equal(d.calls[2].body.get("children"), "CH1,CH2");
  }

  // ── container stuck (never FINISHED) ⇒ throws after max polls ──
  {
    const rs = [{ id: "C1" }];
    for (let i = 0; i < 10; i++) rs.push({ status_code: "IN_PROGRESS" });
    const d = driver(rs);
    await assert.rejects(() => publishToInstagram({ igBusinessId: "IG1", pageToken: "PT",
      snapshot: { video_url: "https://x.test/v.mp4", photo_urls: [], copy: "c" },
      graphVersion: "v21.0", fetchFn: d.fetchFn, sleep: d.sleep }),
      /container not ready/);
  }

  console.log("instagram.test.js OK");
})().catch((e) => { console.error(e); process.exit(1); });
