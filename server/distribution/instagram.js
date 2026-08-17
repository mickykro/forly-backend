/*
 * distribution/instagram.js — IG publish via the connection's Business account.
 *
 * Flow (Content Publishing API): create a media container (REELS for video,
 * IMAGE for one photo, CAROUSEL of children for several), poll status_code
 * until FINISHED, then media_publish, then read the permalink. The container
 * wait uses an injectable sleep so tests run instantly.
 */

const meta = require("./meta");

const MAX_POLLS = 10;
const POLL_MS = 5000;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady({ containerId, pageToken, graphVersion, fetchFn, sleep }) {
  for (let i = 0; i < MAX_POLLS; i++) {
    const r = await meta.graphCall(`/${containerId}`, { graphVersion, fetchFn,
      token: pageToken, params: { fields: "status_code" } });
    if (r.status_code === "FINISHED") return;
    if (r.status_code === "ERROR") {
      throw new meta.GraphError("ig container ERROR", { code: 9007 });
    }
    await sleep(POLL_MS);
  }
  throw new meta.GraphError("ig container not ready in time", { code: 9007 });
}

async function publishToInstagram({ igBusinessId, pageToken, snapshot,
  graphVersion, fetchFn, sleep = defaultSleep }) {
  const g = { graphVersion, fetchFn, token: pageToken, timeoutMs: 60000 };
  let containerId;
  if (snapshot.video_url) {
    containerId = (await meta.graphCall(`/${igBusinessId}/media`, { ...g,
      method: "POST", params: { media_type: "REELS",
        video_url: snapshot.video_url, caption: snapshot.copy } })).id;
  } else if ((snapshot.photo_urls || []).length === 1) {
    containerId = (await meta.graphCall(`/${igBusinessId}/media`, { ...g,
      method: "POST", params: { image_url: snapshot.photo_urls[0],
        caption: snapshot.copy } })).id;
  } else {
    const children = [];
    for (const url of snapshot.photo_urls.slice(0, 10)) {
      children.push((await meta.graphCall(`/${igBusinessId}/media`, { ...g,
        method: "POST", params: { image_url: url, is_carousel_item: "true" } })).id);
    }
    containerId = (await meta.graphCall(`/${igBusinessId}/media`, { ...g,
      method: "POST", params: { media_type: "CAROUSEL",
        children: children.join(","), caption: snapshot.copy } })).id;
  }
  await waitReady({ containerId, pageToken, graphVersion, fetchFn, sleep });
  const pub = await meta.graphCall(`/${igBusinessId}/media_publish`, { ...g,
    method: "POST", params: { creation_id: containerId } });
  let permalink = null;
  try {
    permalink = (await meta.graphCall(`/${pub.id}`, { ...g,
      params: { fields: "permalink" } })).permalink || null;
  } catch (e) { /* permalink is cosmetic — the publish already succeeded */ }
  return { media_id: pub.id, permalink };
}

module.exports = { publishToInstagram, MAX_POLLS, POLL_MS };
