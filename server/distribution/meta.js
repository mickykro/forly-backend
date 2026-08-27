/*
 * distribution/meta.js — Meta Graph API adapter.
 *
 * Pure request builders + one thin form-encoded transport (graphCall) so the
 * flows are testable with an injected fetch. Errors surface as GraphError with
 * Meta's code/subcode/type intact — jobs.js classifies on those (190 /
 * OAuthException ⇒ the agent must reconnect; other Graph codes ⇒ transient,
 * retryable; non-Graph failures on a visible post ⇒ terminal, spec §7).
 *
 * OAuth state tokens live here too: the callback's identity comes ONLY from
 * the HMAC-signed state (10-min TTL) — never from a cookie or query param.
 */

const crypto = require("crypto");

// Graph versions live ~2 years after the NEXT release; keep this near-current
// (v25.0 is current as of 2026-02) and override per deploy with META_GRAPH_VERSION.
const DEFAULT_VERSION = "v25.0";
const STATE_TTL_MS = 10 * 60 * 1000;

// IG scopes requested from day one: adding them later would force every
// already-connected agent through a reconnect when Instagram ships (day 5).
const SCOPES = [
  "pages_show_list", "pages_read_engagement", "pages_manage_posts",
  "instagram_basic", "instagram_content_publish",
];

class GraphError extends Error {
  constructor(message, { status, code, subcode, type, fbtraceId } = {}) {
    super(message);
    this.name = "GraphError";
    this.status = status; this.code = code; this.subcode = subcode;
    this.type = type; this.fbtraceId = fbtraceId;
  }
}

// A dead token — and ONLY that — means "reconnect, it expired": code 190
// (all subcodes) and 102. Permission failures are OAuthException too
// (200/10/3/803) but the token is perfectly valid — the Page just didn't
// grant a scope, so "your connection expired" is a lie that sends the agent
// through a reconnect which changes nothing.
const isAuthError = (err) =>
  err instanceof GraphError && (err.code === 190 || err.code === 102);

const PERMISSION_CODES = [200, 10, 3, 803];
const isPermissionError = (err) =>
  err instanceof GraphError && PERMISSION_CODES.includes(err.code);

// ── OAuth state (HMAC, TTL — the callback's only source of identity) ──
const stateSig = (body, secret) =>
  crypto.createHmac("sha256", secret).update(`fbstate:${body}`).digest("base64url");

function makeState(payload, secret, nowMs = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: nowMs + STATE_TTL_MS }))
    .toString("base64url");
  return `${body}.${stateSig(body, secret)}`;
}

function readState(token, secret, nowMs = Date.now()) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const a = Buffer.from(sig || ""), b = Buffer.from(stateSig(body, secret));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < nowMs) return null;
    return payload;
  } catch { return null; }
}

// `scopes` may narrow the default list: Meta rejects a login dialog that
// requests scopes the app doesn't have enabled ("Invalid Scopes"), so while
// the app's Instagram use case is pending, META_SCOPES can drop the IG pair.
function oauthStartUrl({ appId, redirectUrl, state, graphVersion = DEFAULT_VERSION, scopes }) {
  const list = Array.isArray(scopes) && scopes.length ? scopes : SCOPES;
  const q = new URLSearchParams({
    client_id: appId, redirect_uri: redirectUrl, state,
    scope: list.join(","), response_type: "code",
  });
  return `https://www.facebook.com/${graphVersion}/dialog/oauth?${q}`;
}

// ── transport ──
async function graphCall(pathname, { method = "GET", params = {}, token,
  graphVersion = DEFAULT_VERSION, timeoutMs = 30000, fetchFn = fetch } = {}) {
  const url = new URL(`https://graph.facebook.com/${graphVersion}${pathname}`);
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) form.set(k, String(v));
  }
  if (token) form.set("access_token", token);

  let resp;
  if (method === "GET") {
    url.search = form.toString();
    resp = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  } else {
    resp = await fetchFn(url, {
      method,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  let json = null;
  try { json = await resp.json(); } catch { /* non-JSON body handled below */ }
  if (!resp.ok || (json && json.error)) {
    const e = (json && json.error) || {};
    throw new GraphError(e.message || `graph ${resp.status}`, {
      status: resp.status, code: e.code, subcode: e.error_subcode,
      type: e.type, fbtraceId: e.fbtrace_id,
    });
  }
  return json || {};
}

// ── flows ──
const exchangeCode = ({ code, appId, appSecret, redirectUrl, graphVersion, fetchFn }) =>
  graphCall("/oauth/access_token", { graphVersion, fetchFn, params: {
    client_id: appId, client_secret: appSecret, redirect_uri: redirectUrl, code } });

const longLivedToken = ({ token, appId, appSecret, graphVersion, fetchFn }) =>
  graphCall("/oauth/access_token", { graphVersion, fetchFn, params: {
    grant_type: "fb_exchange_token", client_id: appId,
    client_secret: appSecret, fb_exchange_token: token } });

const listPages = async ({ userToken, graphVersion, fetchFn }) => {
  const r = await graphCall("/me/accounts", { graphVersion, fetchFn, token: userToken,
    params: { fields: "id,name,access_token", limit: 50 } });
  return r.data || [];
};

// A video upload takes as long as Facebook takes to pull the file — give it
// longer than the default before the timeout-is-terminal rule kicks in.
const publishVideo = ({ pageId, pageToken, fileUrl, description, graphVersion, fetchFn }) =>
  graphCall(`/${pageId}/videos`, { method: "POST", graphVersion, fetchFn,
    token: pageToken, timeoutMs: 120000,
    params: { file_url: fileUrl, description } });

async function publishPhotos({ pageId, pageToken, photoUrls, message, graphVersion, fetchFn }) {
  const ids = [];
  for (const url of photoUrls) {
    const r = await graphCall(`/${pageId}/photos`, { method: "POST", graphVersion,
      fetchFn, token: pageToken, timeoutMs: 60000, params: { url, published: "false" } });
    ids.push(r.id);
  }
  return graphCall(`/${pageId}/feed`, { method: "POST", graphVersion, fetchFn,
    token: pageToken, timeoutMs: 60000, params: {
      message, attached_media: JSON.stringify(ids.map((id) => ({ media_fbid: id }))) } });
}

// Attach a photo to an existing post/video as a Page comment. A feed post is
// single-media (video OR photos) — the standard way to get gallery photos
// under a video post is Page comments beneath it.
const commentWithPhoto = ({ objectId, pageToken, message, photoUrl, graphVersion, fetchFn }) =>
  graphCall(`/${objectId}/comments`, { method: "POST", graphVersion, fetchFn,
    token: pageToken, timeoutMs: 60000,
    params: { message: message || undefined, attachment_url: photoUrl } });

// Facebook redirects /{id} to the canonical post/video URL — good enough for
// the WhatsApp summary link without another Graph read.
const postUrl = (postId) => `https://www.facebook.com/${postId}`;

/*
 * Engagement on a published Page post.
 *
 * Split into two calls on purpose, because they need DIFFERENT permissions:
 *
 *  - Counts (likes / comments / shares) need `pages_read_engagement`, which is
 *    in SCOPES and every connected agent has already granted. These work today,
 *    with no App Review and no reconnect.
 *  - Reach and impressions need `read_insights`, which this app has NOT been
 *    reviewed for. That call is therefore allowed to fail: the numbers we CAN
 *    read still land, and `insights` says why the rest is missing rather than
 *    the whole refresh failing.
 *
 * `.summary(true).limit(0)` asks for the count and none of the rows — a like
 * total, not a page of likers, so the response stays small on a popular post.
 */
const summaryCount = (edge) =>
  Number(edge && edge.summary && edge.summary.total_count) || 0;

// Graph returns insights as [{name, values:[{value}]}] — flatten by metric name.
function readInsights(payload) {
  const out = {};
  for (const row of (payload && payload.data) || []) {
    const v = row && Array.isArray(row.values) && row.values[0];
    out[row.name] = Number(v && v.value) || 0;
  }
  return out;
}

/*
 * Which Graph node are we actually measuring?
 *
 * POST /{page}/feed returns "{page}_{post}" — a feed Post.
 * POST /{page}/videos returns a bare video id — a Video, which is a DIFFERENT
 * node type: it has likes and comments, but no `shares` field and no
 * post_impressions_* insights. Asking a Video for `shares` fails the whole
 * call with code 100, which is neither an auth nor a permission error.
 *
 * Video is the primary Forly flow, so resolve it: the Video node carries the
 * id of the feed post it was attached to, and THAT post is what has shares and
 * post-level insights. Falling back to the raw video id still yields likes and
 * comments, just with video-shaped insights.
 */
const isFeedPost = (id) => String(id || "").includes("_");

/*
 * Which id can actually be read, in preference order.
 *
 * POST /{page}/feed returns "{page}_{post}" and is readable as-is. POST
 * /{page}/videos returns a BARE video id, and Graph rejects a plain
 * GET /{video-id} with code 100 ("does not exist, cannot be loaded due to
 * missing permissions, or does not support this operation"). The Page post
 * wrapping an uploaded video is addressed as "{page}_{video}", so try that
 * first and keep the raw video id as a fallback for whatever Graph will serve.
 */
function engagementCandidates(postId, pageId) {
  if (isFeedPost(postId)) return [{ id: postId, kind: "post" }];
  const out = [];
  if (pageId) out.push({ id: `${pageId}_${postId}`, kind: "post" });
  out.push({ id: postId, kind: "video" });
  return out;
}

async function fetchPostMetrics({ postId, pageId, pageToken, graphVersion = DEFAULT_VERSION,
  fetchFn = fetch, timeoutMs = 20000 } = {}) {
  const call = { graphVersion, fetchFn, timeoutMs, token: pageToken };

  /*
   * Likes and comments ONLY. Both edges exist on every node this can land on
   * (Post, Video, Photo); `shares` does not, and bundling it here is what made
   * a whole read fail with "(#100) Tried accessing nonexisting field (shares)"
   * — losing the counts that were perfectly readable. It gets its own call.
   */
  const FIELDS = "likes.summary(true).limit(0),comments.summary(true).limit(0)";
  let counts = null, target = null, lastErr = null;
  const tried = [];
  for (const candidate of engagementCandidates(postId, pageId)) {
    try {
      counts = await graphCall(`/${candidate.id}`, { ...call, params: { fields: FIELDS } });
      target = candidate;
      break;
    } catch (err) {
      if (isAuthError(err)) throw err;   // a dead token is the caller's problem
      tried.push(`${candidate.id}(${candidate.kind}): ${err && err.message}`);
      lastErr = err;
    }
  }
  if (!target) {
    // Graph names only the LAST id it refused, which reads as if the composite
    // form was never attempted. Carry every attempt so the log can prove it was.
    if (lastErr) lastErr.tried = tried;
    throw lastErr;
  }

  const out = {
    likes: summaryCount(counts.likes),
    comments: summaryCount(counts.comments),
    // null, not 0: "we could not read this" is not "nobody shared it".
    shares: null, reach: null, impressions: null, video_views: null,
    node: target.kind, node_id: target.id, insights: "ok",
  };

  // Shares live only on a feed Post, and only sometimes. Best-effort.
  if (target.kind === "post") {
    try {
      const s = await graphCall(`/${target.id}`, { ...call, params: { fields: "shares" } });
      out.shares = Number(s.shares && s.shares.count) || 0;
    } catch (err) { if (isAuthError(err)) throw err; }
  }

  try {
    const metric = target.kind === "post"
      ? "post_impressions_unique,post_impressions,post_video_views"
      : "total_video_views";
    const raw = await graphCall(`/${target.id}/insights`, { ...call, params: { metric } });
    const m = readInsights(raw);
    out.reach = m.post_impressions_unique != null ? m.post_impressions_unique : null;
    out.impressions = m.post_impressions != null ? m.post_impressions : null;
    out.video_views = m.post_video_views != null ? m.post_video_views
      : (m.total_video_views != null ? m.total_video_views : null);
  } catch (err) {
    // Never let a missing scope cost us the counts we already have.
    if (isAuthError(err)) throw err;
    out.insights = isPermissionError(err) ? "not_permitted" : "unavailable";
  }
  return out;
}

module.exports = {
  DEFAULT_VERSION, SCOPES, GraphError, isAuthError, isPermissionError,
  makeState, readState, oauthStartUrl, graphCall,
  exchangeCode, longLivedToken, listPages, publishVideo, publishPhotos,
  commentWithPhoto, postUrl, fetchPostMetrics, isFeedPost,
};
