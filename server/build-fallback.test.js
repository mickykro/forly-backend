/* build-fallback.js — a page-less listing past the failure mark gets one photo-only page request. */
const assert = require("assert");
const db = require("./db");
const { sweepPhotoFallback, due } = require("./build-fallback");
const { BUILD_STUCK_MS } = require("./listing-create");

(async () => {
  const now = Date.now();
  const stuck = new Date(now - BUILD_STUCK_MS - 60000);
  const photos = ["https://f/1.jpg", "https://f/2.jpg", "https://f/3.jpg"];
  await db.saveListing({ listing_id: "F1", business_phone: "P1", status: "active", page_id: null, created_at: stuck, photos_urls: photos, language: "he" });
  await db.saveListing({ listing_id: "F2", business_phone: "P2", status: "failed", page_id: null, created_at: stuck, photos_urls: photos });
  await db.saveListing({ listing_id: "NEW", business_phone: "P3", status: "active", page_id: null, created_at: new Date(now), photos_urls: photos });
  await db.saveListing({ listing_id: "OLD", business_phone: "P4", status: "failed", page_id: null, created_at: new Date(now - 2 * 86400000), photos_urls: photos });
  await db.saveListing({ listing_id: "BUILT", business_phone: "P5", status: "active", page_id: "pg", created_at: stuck, photos_urls: photos });
  await db.saveListing({ listing_id: "NOPICS", business_phone: "P6", status: "failed", page_id: null, created_at: stuck, photos_urls: [] });
  await db.saveListing({ listing_id: "GONE", business_phone: "P7", status: "deleted", page_id: null, created_at: stuck, photos_urls: photos });

  assert.equal(due({ page_id: null, photos_urls: photos, created_at: stuck }, now), true);
  assert.equal(due({ page_id: null, photos_urls: photos, created_at: stuck, retried_at: new Date(now) }, now), false, "a fresh retry is still building");

  const calls = [];
  const fetchFn = async (url, opts) => { calls.push([url, JSON.parse(opts.body)]); return { status: 200 }; };
  assert.deepEqual(await sweepPhotoFallback({ pageBuilderWebhook: "", fetchFn }, now), [], "off without a webhook");

  const sent = await sweepPhotoFallback({ pageBuilderWebhook: "https://n8n/webhook/property-page-builder", baseUrl: "https://srv", fetchFn }, now);
  assert.deepEqual(sent.sort(), ["F1", "F2"], "only page-less, past-the-mark, under-a-day listings with photos");
  assert.deepEqual(calls.map((c) => c[1].listing_id).sort(), ["F1", "F2"]);
  const f1 = calls.find((c) => c[1].listing_id === "F1")[1];
  assert.deepEqual([f1.business_phone, f1.video_url, f1.photo_only, f1.language], ["P1", null, true, "he"]);
  assert.ok((await db.getListing("F1")).photo_fallback_at, "claimed");

  calls.length = 0;
  assert.deepEqual(await sweepPhotoFallback({ pageBuilderWebhook: "https://n8n/x", fetchFn }, now), [], "once per listing");
  assert.equal(calls.length, 0);

  // a retry clears the claim, so a second failure can fall back again
  const { retryListing } = require("./listing-create");
  await retryListing(await db.getListing("F2"), { fetchFn: async () => ({ status: 200 }) }, new Date(now - BUILD_STUCK_MS - 1000));
  assert.equal((await db.getListing("F2")).photo_fallback_at, null);
  assert.deepEqual(await sweepPhotoFallback({ pageBuilderWebhook: "https://n8n/x", fetchFn }, now), ["F2"]);

  console.log("build-fallback.test.js ok");
})().catch((err) => { console.error(err); process.exit(1); });
