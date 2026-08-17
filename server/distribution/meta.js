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

const DEFAULT_VERSION = "v21.0";
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

const isAuthError = (err) =>
  err instanceof GraphError && (err.code === 190 || err.type === "OAuthException");

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

function oauthStartUrl({ appId, redirectUrl, state, graphVersion = DEFAULT_VERSION }) {
  const q = new URLSearchParams({
    client_id: appId, redirect_uri: redirectUrl, state,
    scope: SCOPES.join(","), response_type: "code",
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

// Facebook redirects /{id} to the canonical post/video URL — good enough for
// the WhatsApp summary link without another Graph read.
const postUrl = (postId) => `https://www.facebook.com/${postId}`;

module.exports = {
  DEFAULT_VERSION, SCOPES, GraphError, isAuthError,
  makeState, readState, oauthStartUrl, graphCall,
  exchangeCode, longLivedToken, listPages, publishVideo, publishPhotos, postUrl,
};
