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
      impressions: 512, video_views: 87, insights: "ok",
      node: "post", node_id: "P_1" });
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

    /*
     * Both candidates refused, but for DIFFERENT reasons: the composite id
     * lacks pages_read_engagement (#10), the bare video gives the generic
     * "does not exist" (100/33). The permission error is the one an agent can
     * act on, so it must be what surfaces — otherwise the card blames a
     * deleted post for a missing scope.
     */
    {
      const fetchFn = async (url) => (String(url).includes("/P9_V9")
        ? { ok: false, status: 400, json: async () => ({ error: {
            message: "(#10) … requires the 'pages_read_engagement' permission",
            code: 10 } }) }
        : { ok: false, status: 400, json: async () => ({ error: {
            message: "Unsupported get request.", code: 100, error_subcode: 33 } }) });
      await assert.rejects(() => meta.fetchPostMetrics({ postId: "V9", pageId: "P9",
        pageToken: "PT", fetchFn }), (e) => {
        assert.equal(e.code, 10, "the permission refusal wins over the generic 100");
        assert.equal(e.tried.length, 2, "both attempts still logged");
        return true;
      });
    }

    // A dead token is NOT a degraded read — it propagates so the caller stops.
    const dead = twoCall(() => ({ ok: false, status: 401,
      json: async () => ({ error: { message: "expired", code: 190 } }) }));
    await assert.rejects(() => meta.fetchPostMetrics({ postId: "P_1", pageToken: "PT",
      fetchFn: dead.fetchFn }), (e) => meta.isAuthError(e), "auth errors propagate");

    /*
     * A Page VIDEO publish returns a BARE id, and Graph refuses a plain
     * GET /{video-id}: "Object with ID '…' does not exist, cannot be loaded due
     * to missing permissions, or does not support this operation" (code 100).
     * These are real responses observed from a running instance. Video is the
     * primary Forly flow, so this path matters more than the feed-post one.
     */
    const UNSUPPORTED = { ok: false, status: 400, json: async () => ({ error: {
      message: "Unsupported get request. Object with ID 'V1' does not exist",
      code: 100, error_subcode: 33 } }) };

    // The Page post wrapping an uploaded video is "{page}_{video}".
    {
      const seen = [];
      const fetchFn = async (url) => {
        const u = String(url); seen.push(u);
        if (u.includes("/V1?") ) return UNSUPPORTED;             // bare video: refused
        if (u.includes("/insights")) return { ok: true, json: async () => INSIGHTS };
        if (u.includes("fields=shares")) return { ok: true, json: async () => ({ shares: { count: 2 } }) };
        return { ok: true, json: async () => COUNTS };
      };
      const m = await meta.fetchPostMetrics({ postId: "V1", pageId: "P9",
        pageToken: "PT", graphVersion: "v21.0", fetchFn });
      assert.equal(m.node_id, "P9_V1", "addressed as the Page post, not the raw video");
      assert.deepEqual([m.likes, m.comments, m.shares, m.reach], [12, 3, 2, 340]);
      assert.ok(!seen.some((u) => u.includes("/V1?")), "never wastes a call on the bare id");
    }

    // If even the composite is refused, fall back to the video node: likes and
    // comments still land, with video-shaped insights and no shares.
    {
      const seen = [];
      const fetchFn = async (url) => {
        const u = String(url); seen.push(u);
        if (u.includes("/P9_V2")) return UNSUPPORTED;
        if (u.includes("/video_insights")) {
          return { ok: true, json: async () => ({ data: [
            { name: "blue_reels_play_count", values: [{ value: 512 }] }] }) };
        }
        return { ok: true, json: async () => COUNTS };
      };
      const m = await meta.fetchPostMetrics({ postId: "V2", pageId: "P9", pageToken: "PT", fetchFn });
      assert.equal(m.node, "video");
      assert.equal(m.likes, 12, "counts survive a node that refuses the post form");
      assert.equal(m.video_views, 512, "reads /video_insights, not /insights");
      assert.ok(seen.some((u) => u.includes("/V2/video_insights")),
        "the video edge is the one asked");
      assert.strictEqual(m.shares, null, "unreadable shares stay null, never a fake 0");
      assert.ok(!seen.some((u) => u.includes("fields=shares")), "does not ask a Video for shares");
    }

    /*
     * "(#100) Tried accessing nonexisting field (shares)" — also observed live.
     * Shares get their own call precisely so this cannot cost us the counts.
     */
    {
      const fetchFn = async (url) => {
        const u = String(url);
        if (u.includes("fields=shares")) {
          return { ok: false, status: 400, json: async () => ({ error: {
            message: "(#100) Tried accessing nonexisting field (shares)", code: 100 } }) };
        }
        if (u.includes("/insights")) return { ok: true, json: async () => INSIGHTS };
        return { ok: true, json: async () => COUNTS };
      };
      const m = await meta.fetchPostMetrics({ postId: "P9_V3", pageToken: "PT", fetchFn });
      assert.equal(m.likes, 12, "a shares failure never costs the counts");
      assert.strictEqual(m.shares, null);
      assert.equal(m.reach, 340);
    }

    // Every candidate refused ⇒ the error carries EVERY id it tried. Graph names
    // only the last one, which reads as if the composite was never attempted.
    await assert.rejects(() => meta.fetchPostMetrics({ postId: "V4", pageId: "P9",
      pageToken: "PT", fetchFn: async () => UNSUPPORTED }),
      (e) => {
        assert.equal(e.code, 100, "surfaces Graph's code");
        assert.equal(e.tried.length, 2, "both candidates reported");
        assert.match(e.tried[0], /^P9_V4\(post\):/, "composite attempted first");
        assert.match(e.tried[1], /^V4\(video\):/, "raw video attempted second");
        return true;
      });

    assert.equal(meta.isFeedPost("123_456"), true);
    assert.equal(meta.isFeedPost("1558976638553912"), false);


    /*
     * A Page video is served as a REEL, and Reels answer /video_insights with
     * fb_reels_* / blue_reels_* metrics — not /insights with post_impressions_*.
     * This payload is the verbatim response from a live Page.
     */
    {
      const REELS = { data: [
        { name: "post_video_likes_by_reaction_type", values: [{ value: {} }] },
        { name: "post_video_avg_time_watched", values: [{ value: 55077 }] },
        { name: "post_video_social_actions", values: [{ value: {} }] },
        { name: "post_video_view_time", values: [{ value: 220310 }] },
        { name: "post_impressions_unique", values: [{ value: 2 }] },
        { name: "blue_reels_play_count", values: [{ value: 4 }] },
        { name: "fb_reels_total_plays", values: [{ value: 12 }] },
        { name: "fb_reels_replay_count", values: [{ value: 8 }] },
        { name: "post_video_retention_graph", values: [{ value: { 0: 0.25, 1: 0 } }] },
        { name: "post_video_followers", values: [{ value: 0 }] },
      ] };
      const seen = [];
      const fetchFn = async (url) => {
        const u = String(url); seen.push(u);
        if (u.includes("/video_insights")) return { ok: true, json: async () => REELS };
        if (u.includes("/insights")) return { ok: true, json: async () => ({ data: [] }) };
        if (u.includes("fields=shares")) return { ok: true, json: async () => ({ shares: { count: 1 } }) };
        return { ok: true, json: async () => COUNTS };
      };
      const m = await meta.fetchPostMetrics({ postId: "VREEL", pageId: "P9",
        pageToken: "PT", fetchFn });
      assert.equal(m.reach, 2, "reach comes from post_impressions_unique");
      assert.equal(m.video_views, 4,
        "views = blue_reels_play_count — fb_reels_total_plays counts REPLAYS and would overstate it");
      assert.equal(m.likes, 12, "counts still come from the post node");
      assert.equal(m.insights, "ok");
      assert.ok(seen.some((u) => u.includes("/VREEL/video_insights")),
        "falls through to video_insights when /insights answers empty");

      // Object-valued metrics (reaction breakdown, retention curve) must not be
      // coerced: Number({}) is NaN, which a bare `|| 0` turns into a real zero.
      assert.notStrictEqual(m.impressions, 0, "an absent metric is null, not 0");
      assert.strictEqual(m.impressions, null);
    }

    // An insights call that succeeds but returns nothing is labelled honestly —
    // "ok" would claim we read it and it was empty.
    {
      const fetchFn = async (url) => {
        const u = String(url);
        if (u.includes("insights")) return { ok: true, json: async () => ({ data: [] }) };
        if (u.includes("fields=shares")) return { ok: true, json: async () => ({ shares: { count: 0 } }) };
        return { ok: true, json: async () => COUNTS };
      };
      const m = await meta.fetchPostMetrics({ postId: "P9_V9", pageToken: "PT", fetchFn });
      assert.equal(m.insights, "empty");
      assert.strictEqual(m.reach, null);
    }

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
