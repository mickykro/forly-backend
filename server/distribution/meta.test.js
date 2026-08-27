/*
 * Unit tests for distribution/meta.js — builders, state tokens, error
 * classification, publish flows against an injected fake fetch.
 * Run: node server/distribution/meta.test.js
 */
const assert = require("assert");
const meta = require("./meta");

(async () => {
  // ── oauth start URL carries app id, redirect, state and the scopes ──
  const u = new URL(meta.oauthStartUrl({
    appId: "123", redirectUrl: "https://x.test/cb", state: "S1", graphVersion: "v21.0" }));
  assert.equal(u.origin + u.pathname, "https://www.facebook.com/v21.0/dialog/oauth");
  assert.equal(u.searchParams.get("client_id"), "123");
  assert.equal(u.searchParams.get("redirect_uri"), "https://x.test/cb");
  assert.equal(u.searchParams.get("state"), "S1");
  assert.equal(u.searchParams.get("scope"), meta.SCOPES.join(","));
  // explicit scopes narrow the request (used while the app lacks IG perms)
  const u2 = new URL(meta.oauthStartUrl({ appId: "123", redirectUrl: "https://x.test/cb",
    state: "S1", scopes: ["pages_show_list", "pages_manage_posts"] }));
  assert.equal(u2.searchParams.get("scope"), "pages_show_list,pages_manage_posts");

  // ── state tokens: round-trip, tamper-proof, 10-minute TTL ──
  const t0 = 1_000_000_000_000;
  const tok = meta.makeState({ phone: "972501234567" }, "sec", t0);
  assert.equal(meta.readState(tok, "sec", t0 + 9 * 60 * 1000).phone, "972501234567");
  assert.equal(meta.readState(tok, "sec", t0 + 11 * 60 * 1000), null, "expired after 10 min");
  assert.equal(meta.readState(tok, "other", t0), null, "wrong secret");
  assert.equal(meta.readState(tok.slice(0, -2) + "xx", "sec", t0), null, "tampered sig");
  assert.equal(meta.readState("garbage", "sec", t0), null);

  // ── graphCall: form-encoded POST, token appended, JSON out ──
  const calls = [];
  const okFetch = (body) => async (url, opts) => {
    calls.push({ url: String(url), opts });
    return { ok: true, json: async () => body };
  };
  const r = await meta.graphCall("/me", { method: "POST", params: { a: "1" },
    token: "TOK", graphVersion: "v21.0", fetchFn: okFetch({ id: "9" }) });
  assert.equal(r.id, "9");
  assert.equal(calls[0].url, "https://graph.facebook.com/v21.0/me");
  assert.equal(calls[0].opts.headers["content-type"], "application/x-www-form-urlencoded");
  assert.ok(calls[0].opts.body.includes("access_token=TOK"));
  assert.ok(calls[0].opts.signal instanceof AbortSignal, "explicit timeout signal");

  // ── Graph errors become GraphError with code/subcode/type surfaced ──
  const errFetch = async () => ({ ok: false, status: 400, json: async () => ({
    error: { message: "bad token", type: "OAuthException", code: 190, error_subcode: 463 } }) });
  await assert.rejects(
    () => meta.graphCall("/me", { fetchFn: errFetch }),
    (e) => e instanceof meta.GraphError && e.code === 190 && e.subcode === 463
      && e.type === "OAuthException" && meta.isAuthError(e));

  // A missing scope is OAuthException too, but the token is alive: it must
  // NOT be reported to the agent as an expired connection.
  const permErr = new meta.GraphError("(#200) requires pages_manage_posts",
    { code: 200, type: "OAuthException" });
  assert.equal(meta.isAuthError(permErr), false);
  assert.equal(meta.isPermissionError(permErr), true);
  assert.equal(meta.isAuthError(new Error("network down")), false);
  assert.equal(meta.isAuthError(new meta.GraphError("x", { code: 1 })), false);

  // ── publishVideo posts file_url + description to /{page}/videos ──
  const vcalls = [];
  const vFetch = async (url, opts) => { vcalls.push({ url: String(url), opts });
    return { ok: true, json: async () => ({ id: "VID1" }) }; };
  const v = await meta.publishVideo({ pageId: "P1", pageToken: "PT",
    fileUrl: "https://x.test/v.mp4", description: "תיאור", graphVersion: "v21.0", fetchFn: vFetch });
  assert.equal(v.id, "VID1");
  assert.equal(vcalls[0].url, "https://graph.facebook.com/v21.0/P1/videos");
  const vBody = new URLSearchParams(vcalls[0].opts.body);
  assert.equal(vBody.get("file_url"), "https://x.test/v.mp4");
  assert.equal(vBody.get("description"), "תיאור");
  assert.equal(vBody.get("access_token"), "PT");

  // ── publishPhotos: N unpublished photo uploads, then one feed post ──
  const pcalls = [];
  const pFetch = async (url, opts) => {
    pcalls.push({ url: String(url), body: new URLSearchParams(opts.body) });
    const isPhoto = String(url).endsWith("/photos");
    return { ok: true, json: async () => (isPhoto ? { id: `PH${pcalls.length}` } : { id: "FEED1" }) };
  };
  const p = await meta.publishPhotos({ pageId: "P1", pageToken: "PT",
    photoUrls: ["https://x.test/1.jpg", "https://x.test/2.jpg"],
    message: "טקסט", graphVersion: "v21.0", fetchFn: pFetch });
  assert.equal(p.id, "FEED1");
  assert.equal(pcalls.length, 3, "2 photo uploads + 1 feed post");
  assert.equal(pcalls[0].body.get("published"), "false");
  assert.equal(pcalls[0].body.get("url"), "https://x.test/1.jpg");
  const feed = pcalls[2];
  assert.ok(feed.url.endsWith("/P1/feed"));
  assert.equal(feed.body.get("message"), "טקסט");
  assert.deepEqual(JSON.parse(feed.body.get("attached_media")),
    [{ media_fbid: "PH1" }, { media_fbid: "PH2" }]);

  // ── commentWithPhoto: photo attached to an existing post via comment ──
  const ccalls = [];
  const cFetch = async (url, opts) => { ccalls.push({ url: String(url),
    body: new URLSearchParams(opts.body) }); return { ok: true, json: async () => ({ id: "CM1" }) }; };
  await meta.commentWithPhoto({ objectId: "VID1", pageToken: "PT",
    message: "עוד תמונות", photoUrl: "https://x.test/1.jpg",
    graphVersion: "v21.0", fetchFn: cFetch });
  assert.ok(ccalls[0].url.endsWith("/VID1/comments"));
  assert.equal(ccalls[0].body.get("attachment_url"), "https://x.test/1.jpg");
  assert.equal(ccalls[0].body.get("message"), "עוד תמונות");

  assert.equal(meta.postUrl("123_456"), "https://www.facebook.com/123_456");

  // ── fetchPostMetrics: counts always, insights best-effort ──
  {
    const COUNTS = { likes: { summary: { total_count: 12 } },
      comments: { summary: { total_count: 3 } }, shares: { count: 2 } };
    const INSIGHTS = { data: [
      { name: "post_impressions_unique", values: [{ value: 340 }] },
      { name: "post_impressions", values: [{ value: 512 }] },
      { name: "post_video_views", values: [{ value: 87 }] },
    ] };
    // Route by path so the two calls can answer differently.
    const twoCall = (insightsResponder) => {
      const seen = [];
      const fetchFn = async (url) => {
        const u = String(url);
        seen.push(u);
        if (u.includes("/insights")) return insightsResponder();
        return { ok: true, json: async () => COUNTS };
      };
      return { fetchFn, seen };
    };

    const ok = twoCall(() => ({ ok: true, json: async () => INSIGHTS }));
    const m = await meta.fetchPostMetrics({ postId: "P_1", pageToken: "PT",
      graphVersion: "v21.0", fetchFn: ok.fetchFn });
    assert.deepEqual(m, { likes: 12, comments: 3, shares: 2, reach: 340,
      impressions: 512, video_views: 87, insights: "ok" });
    // .summary(true).limit(0) — the total, not a page of likers.
    assert.ok(ok.seen[0].includes("likes.summary%28true%29.limit%280%29"),
      "asks for counts only");

    // read_insights is not granted (App Review pending) ⇒ reach is null, but
    // the counts we CAN read must still come back.
    const denied = twoCall(() => ({ ok: false, status: 403,
      json: async () => ({ error: { message: "(#200) requires read_insights", code: 200 } }) }));
    const m2 = await meta.fetchPostMetrics({ postId: "P_1", pageToken: "PT",
      fetchFn: denied.fetchFn });
    assert.equal(m2.insights, "not_permitted");
    assert.equal(m2.reach, null);
    assert.equal(m2.likes, 12, "counts survive a missing insights scope");

    // Any other insights failure degrades the same way, labelled differently.
    const broke = twoCall(() => { throw new Error("network"); });
    const m3 = await meta.fetchPostMetrics({ postId: "P_1", pageToken: "PT",
      fetchFn: broke.fetchFn });
    assert.equal(m3.insights, "unavailable");
    assert.equal(m3.comments, 3);

    // A dead token is NOT a degraded read — it propagates so the caller stops.
    const dead = twoCall(() => ({ ok: false, status: 401,
      json: async () => ({ error: { message: "expired", code: 190 } }) }));
    await assert.rejects(() => meta.fetchPostMetrics({ postId: "P_1", pageToken: "PT",
      fetchFn: dead.fetchFn }), (e) => meta.isAuthError(e), "auth errors propagate");

    /*
     * A Page VIDEO publish returns a bare id — a Video node, not a feed Post.
     * It has no `shares` field, and asking for one fails the whole read with
     * code 100 (not auth, not permission), which would take likes and comments
     * down with it. Video is the primary Forly flow, so this path matters most.
     */
    {
      const seen = [];
      const fetchFn = async (url) => {
        const u = String(url); seen.push(u);
        if (/\/VID1\?|\/VID1$/.test(u.split("?")[0] + (u.includes("?") ? "?" : ""))
            && u.includes("fields=post_id")) {
          return { ok: true, json: async () => ({ post_id: "PAGE_POST" }) };
        }
        if (u.includes("/insights")) return { ok: true, json: async () => INSIGHTS };
        if (u.includes("fields=")) return { ok: true, json: async () => COUNTS };
        return { ok: true, json: async () => ({}) };
      };
      const m = await meta.fetchPostMetrics({ postId: "VID1", pageToken: "PT",
        graphVersion: "v21.0", fetchFn });
      assert.equal(m.shares, 2, "resolved to the feed post, so shares are readable");
      assert.equal(m.reach, 340);
      assert.ok(seen.some((u) => u.includes("fields=post_id")), "asked the video for its post");
      assert.ok(seen.some((u) => u.includes("/PAGE_POST")), "measured the post, not the video");
    }

    // A video with no attached post still yields likes and comments — it just
    // must not ask for `shares`, and its insights are video-shaped.
    {
      const seen = [];
      const fetchFn = async (url) => {
        const u = String(url); seen.push(u);
        if (u.includes("fields=post_id")) {
          return { ok: false, status: 400,
            json: async () => ({ error: { message: "nonexisting field", code: 100 } }) };
        }
        if (u.includes("/insights")) {
          return { ok: true, json: async () => ({ data: [
            { name: "total_video_views", values: [{ value: 512 }] }] }) };
        }
        return { ok: true, json: async () => COUNTS };
      };
      const m = await meta.fetchPostMetrics({ postId: "VID2", pageToken: "PT", fetchFn });
      assert.equal(m.likes, 12, "counts survive an unresolvable video");
      assert.equal(m.video_views, 512, "video-shaped insights still land");
      const countsCall = seen.find((u) => u.includes("likes.summary"));
      assert.ok(!countsCall.includes("shares"), "never asks a Video node for shares");
      assert.ok(seen.some((u) => u.includes("metric=total_video_views")),
        "uses video metrics, not post_impressions_*");
    }

    // A feed post id is used as-is — no extra resolve call.
    {
      const seen = [];
      const fetchFn = async (url) => {
        const u = String(url); seen.push(u);
        if (u.includes("/insights")) return { ok: true, json: async () => INSIGHTS };
        return { ok: true, json: async () => COUNTS };
      };
      await meta.fetchPostMetrics({ postId: "PAGE_123", pageToken: "PT", fetchFn });
      assert.ok(!seen.some((u) => u.includes("fields=post_id")),
        "a feed post needs no resolution");
      assert.ok(seen[0].includes("shares"), "and does carry shares");
    }
    assert.equal(meta.isFeedPost("123_456"), true);
    assert.equal(meta.isFeedPost("1558976638553912"), false);

    // Absent edges (a post with no likes at all) read as 0, never NaN.
    const empty = { fetchFn: async (url) => String(url).includes("/insights")
      ? { ok: true, json: async () => ({ data: [] }) }
      : { ok: true, json: async () => ({}) } };
    const m4 = await meta.fetchPostMetrics({ postId: "P_1", pageToken: "PT",
      fetchFn: empty.fetchFn });
    assert.deepEqual([m4.likes, m4.comments, m4.shares], [0, 0, 0]);
  }

  console.log("meta.test.js OK");
})().catch((e) => { console.error(e); process.exit(1); });
