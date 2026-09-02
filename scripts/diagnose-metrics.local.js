#!/usr/bin/env node
/*
 * Why is post engagement not showing on the dashboard?
 *
 * Runs LOCALLY against your own database and your own Meta connection. It asks
 * Graph the same questions the dashboard does, for every id shape, and prints
 * what came back.
 *
 * It never prints a token, and it never writes anything — read-only.
 *
 *   cd server && GOOGLE_APPLICATION_CREDENTIALS=... node ../scripts/diagnose-metrics.local.js [phone]
 *
 * With no phone it reports every agent that has a Facebook connection.
 */
process.chdir(require("path").join(__dirname, "..", "server"));

const db = require("../server/db");
const meta = require("../server/distribution/meta");

const GV = process.env.META_GRAPH_VERSION || meta.DEFAULT_VERSION;
const mask = (t) => (t ? `present (${String(t).length} chars)` : "MISSING");
const line = (s) => console.log(s);

// One raw Graph GET, reporting the outcome rather than throwing.
async function probe(label, path, params, token) {
  try {
    const r = await meta.graphCall(path, { graphVersion: GV, token, params, timeoutMs: 20000 });
    return { label, ok: true, keys: Object.keys(r || {}), body: r };
  } catch (err) {
    return { label, ok: false, code: err && err.code, subcode: err && err.subcode,
      type: err && err.type, message: (err && err.message || "").slice(0, 200) };
  }
}

function show(r) {
  if (r.ok) {
    line(`    ✓ ${r.label}  →  ${JSON.stringify(r.body).slice(0, 220)}`);
  } else {
    line(`    ✗ ${r.label}  →  code=${r.code} subcode=${r.subcode} ${r.message}`);
  }
}

(async () => {
  db.init();
  line(`graph version: ${GV}`);
  line(`firestore:     ${db.db ? "connected" : "IN-MEMORY (no GOOGLE_APPLICATION_CREDENTIALS — nothing persisted)"}`);
  line(`META_TOKEN_KEY: ${process.env.META_TOKEN_KEY ? "set" : "not set (tokens stored before it was set still read as plaintext)"}`);
  line("");

  const wanted = process.argv[2];
  const businesses = wanted
    ? [await db.getBusiness(wanted).then((b) => b && { ...b, phone: wanted })].filter(Boolean)
    : await db.listAllBusinesses();
  if (!businesses.length) return line("no businesses found — is this the right database?");

  for (const biz of businesses) {
    const phone = biz.phone || biz.id;
    const conn = await db.getConnection(phone).catch(() => null);
    if (!conn || !conn.page_id) continue;

    line(`═══ agent ${phone}`);
    line(`  entitled:       ${!!(biz.features && biz.features.distribution)}`);
    line(`  page_id:        ${conn.page_id}   (${conn.page_name || "?"})`);
    line(`  page_token:     ${mask(conn.page_token)}`);
    line(`  needs_reconnect:${!!conn.needs_reconnect}`);
    line(`  scopes stored:  ${JSON.stringify(conn.scopes || null)}`);

    if (!conn.page_token) {
      line("  ⚠ no usable page token — if META_TOKEN_KEY changed, the stored token cannot be decrypted.");
      line("");
      continue;
    }

    // The stored `scopes` array is only what we ASKED for at connect time.
    // This is what Meta actually granted — the difference is the usual cause of
    // "does not exist, cannot be loaded due to missing permissions".
    show(await probe("page node readable", `/${conn.page_id}`,
      { fields: "id,name" }, conn.page_token));
    show(await probe("granted permissions", "/me/permissions", {}, conn.page_token));

    // Every distribution this agent has with a recorded post.
    const pages = await db.listAllPages().catch(() => []);
    const mine = pages.filter((p) => p.business_phone === phone);
    let checked = 0;
    for (const page of mine) {
      const dists = await db.listDistributionsByPage(page.page_id).catch(() => []);
      for (const d of dists) {
        const postId = d.targets && d.targets.facebook_page && d.targets.facebook_page.post_id;
        if (!postId) continue;
        checked++;
        const composite = `${conn.page_id}_${postId}`;
        line(`  ── ${page.page_id}  post_id=${postId}`);
        line(`     stored metrics: ${JSON.stringify((d.targets.facebook_page || {}).metrics || null)}`);
        show(await probe(`GET /${composite} likes+comments`, `/${composite}`,
          { fields: "likes.summary(true).limit(0),comments.summary(true).limit(0)" }, conn.page_token));
        show(await probe(`GET /${composite} shares`, `/${composite}`,
          { fields: "shares" }, conn.page_token));
        show(await probe(`GET /${postId} (bare) likes+comments`, `/${postId}`,
          { fields: "likes.summary(true).limit(0),comments.summary(true).limit(0)" }, conn.page_token));
        show(await probe(`GET /${composite}/insights`, `/${composite}/insights`,
          { metric: "post_impressions_unique,post_impressions,post_video_views" }, conn.page_token));
        show(await probe(`GET /${postId}/insights (video)`, `/${postId}/insights`,
          { metric: "total_video_views" }, conn.page_token));

        // And the real thing, exactly as the dashboard calls it.
        try {
          const m = await meta.fetchPostMetrics({ postId, pageId: conn.page_id,
            pageToken: conn.page_token, graphVersion: GV });
          line(`     ⇒ fetchPostMetrics: ${JSON.stringify(m)}`);
        } catch (err) {
          line(`     ⇒ fetchPostMetrics THREW: code=${err.code} subcode=${err.subcode} ` +
            `tried=${JSON.stringify(err.tried || null)} ${err.message}`);
        }
      }
    }
    if (!checked) line("  (no distributions with a recorded post_id — nothing published yet)");
    line("");
  }
  line("done. Nothing was written and no token was printed.");
})().catch((e) => { console.error("diagnose failed:", e); process.exit(1); });
