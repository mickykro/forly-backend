/*
 * distribution/jobs.js — the publish job state machine + sweeper.
 *
 * Lifecycle: awaiting_confirm → queued → running → done | failed |
 * skipped_duplicate (| superseded, set by routes when a dashboard publish
 * replaces a stale confirm offer).
 *
 * Everything here takes a `deps` object (db, meta, shareKit, config,
 * sendWhatsApp, …) so jobs.test.js drives the whole machine with fakes;
 * liveDeps() assembles the real modules for index.js and the routes.
 *
 * Double-post protection (spec §3) in execution order:
 *   1. every execution re-checks the page for ANY sibling carrying a post id,
 *      whatever its status — found + !force ⇒ skipped_duplicate;
 *   2. the Facebook post id is persisted the moment Graph accepts, BEFORE the
 *      audit write or any WhatsApp send;
 *   3. a non-Graph failure (timeout/network) on the visible post is TERMINAL:
 *      Facebook may have accepted it, so retrying risks a duplicate.
 */

const crypto = require("crypto");

const MAX_ATTEMPTS = 3;
const SWEEP_MS = 60 * 1000;

// ── Hebrew strings (user-facing; vendor error text NEVER goes here) ──
const M = {
  confirmOffer: (title, pageUrl, confirmLink) =>
    `🚀 דף הנכס "${title}" מוכן!\n${pageUrl}\n\n` +
    `לפרסום אוטומטי בפייסבוק + ערכת שיתוף לקבוצות, הקישו לאישור:\n${confirmLink}\n\n` +
    `לא מפרסמים בלי האישור שלכם.`,
  duplicate: (title) =>
    `ℹ️ הנכס "${title}" כבר פורסם בעבר — לא פרסמנו שוב.\n` +
    `אפשר לפרסם מחדש בכוונה דרך עמוד ההפצה בדשבורד.`,
  notConnected: (title) =>
    `⚠️ הנכס "${title}" לא פורסם בפייסבוק — החשבון עדיין לא חובר.\n` +
    `מתחברים פעם אחת בעמוד ההפצה בדשבורד, ומהפעם הבאה הפרסום אוטומטי.`,
  reconnect: () =>
    `⚠️ החיבור לפייסבוק פג תוקף. פרסום אוטומטי מושהה עד חיבור מחדש בעמוד ההפצה בדשבורד.`,
  posted: (title, postUrl) =>
    `✅ הנכס "${title}" פורסם בפייסבוק!\n${postUrl}`,
  failed: (title) =>
    `❌ הפרסום של "${title}" בפייסבוק נכשל. ננסה שוב אוטומטית מאוחר יותר.`,
  timeoutCheck: (title) =>
    `⚠️ הפרסום של "${title}" לא אושר על ידי פייסבוק בזמן. ייתכן שהפוסט כן עלה — ` +
    `בדקו בדף הפייסבוק שלכם לפני ניסיון נוסף.`,
  igPosted: (title, link) => `📸 "${title}" פורסם גם באינסטגרם!${link ? `\n${link}` : ""}`,
  igFailedFbOk: (title) =>
    `⚠️ "${title}": הפרסום באינסטגרם נכשל — הפוסט בפייסבוק עלה כרגיל.`,
};

// ── pure helpers ──
const baseTargets = () => ({
  facebook_page: { status: "pending", attempts: 0 },
  instagram: { status: "pending", attempts: 0 },
  share_kit: { status: "pending" },
});
const livePostOf = (d) =>
  (d && d.targets && d.targets.facebook_page && d.targets.facebook_page.post_id) || null;
const hasLivePost = (dists) => (dists || []).some((d) => !!livePostOf(d));
const hasInFlight = (dists) => (dists || []).some((d) =>
  d && (d.status === "awaiting_confirm" || d.status === "queued" || d.status === "running"));

// ── deps assembly for production wiring ──
function liveDeps({ greenInstance, greenToken, pageBaseUrl, authSecret, env = process.env }) {
  const db = require("../db");
  const meta = require("./meta");
  const shareKit = require("./share-kit");
  const config = require("./config");
  const instagram = require("./instagram");
  const businessCache = require("../business-cache");
  const { signActionToken } = require("../auth");
  const { sendWhatsApp } = require("../utils");
  return {
    db, meta, shareKit, config, instagram, env, pageBaseUrl,
    graphVersion: env.META_GRAPH_VERSION || meta.DEFAULT_VERSION,
    signActionToken: (parts) => signActionToken(parts, authSecret),
    sendWhatsApp: (phone, msg) => sendWhatsApp(phone, msg, greenInstance, greenToken),
    now: () => new Date(),
    getBusinessCached: (phone) => businessCache.get(phone),
  };
}

// Best-effort WhatsApp — a messaging failure must never fail a job (spec §7).
async function notify(deps, phone, msg) {
  try { await deps.sendWhatsApp(phone, msg); }
  catch (e) { console.warn("distribution notify failed:", e && e.message); }
}

async function audit(deps, dist, target, action, extra = {}) {
  const snap = dist.snapshot || {};
  const mediaUrls = snap.video_url ? [snap.video_url] : (snap.photo_urls || []);
  await deps.db.addPostAction({
    business_phone: dist.business_phone, page_id: dist.page_id,
    distribution_id: dist.id, target, action,
    at: deps.now(), trigger: dist.trigger,
    post_id: extra.post_id || null, post_url: extra.post_url || null,
    content: {
      copy: snap.copy || "",
      media_type: snap.video_url ? "video" : (snap.photo_urls || []).length ? "photos" : "none",
      media_count: mediaUrls.length, media_urls: mediaUrls,
    },
    error: extra.error || null,
  });
}

// ── creation paths ──
// Page-ready hook body: entitled + nothing posted/in-flight ⇒ offer via
// WhatsApp confirm link. Fire-and-forget from routes/pages.js.
async function maybeOffer(deps, page) {
  const biz = await deps.getBusinessCached(page.business_phone);
  const ent = deps.config.resolve(biz, deps.env);
  if (!ent.enabled) return { offered: false, reason: ent.reason };
  const sibs = await deps.db.listDistributionsByPage(page.page_id);
  if (hasLivePost(sibs) || hasInFlight(sibs)) return { offered: false, reason: "duplicate" };
  const id = crypto.randomUUID();
  const now = deps.now();
  await deps.db.saveDistribution({
    id, page_id: page.page_id, business_phone: page.business_phone,
    status: "awaiting_confirm", trigger: "auto", force: false,
    targets: baseTargets(), snapshot: null,
    created_at: now, updated_at: now, confirmed_at: null,
  });
  const link = `${deps.pageBaseUrl}/api/distribution/confirm?d=${id}&t=${deps.signActionToken([id, "confirm"])}`;
  const title = (page.property && page.property.title) || "";
  await notify(deps, page.business_phone,
    M.confirmOffer(title, `${deps.pageBaseUrl}/p/${page.page_id}`, link));
  return { offered: true, id };
}

// Snapshot at enqueue: what the agent confirmed is what posts, even if the
// page is edited while the job waits (spec §5).
async function snapshotFor(deps, pageId, phone) {
  const page = await deps.db.getPage(pageId);
  if (!page) throw new Error(`snapshot: page ${pageId} not found`);
  const biz = await deps.db.getBusiness(phone);
  const pageUrl = `${deps.pageBaseUrl}/p/${pageId}`;
  return {
    title: (page.property && page.property.title) || "",
    page_url: pageUrl,
    video_url: (page.hero && page.hero.video_url) || null,
    poster_url: (page.hero && page.hero.poster_url) || null,
    photo_urls: ((page.gallery && page.gallery.images) || []).map((i) => i.url).slice(0, 10),
    copy: deps.shareKit.buildPostCopy(page, pageUrl),
    groups: deps.shareKit.sanitizeGroups(
      (biz && biz.distribution && biz.distribution.groups) || []),
  };
}

async function enqueueFromConfirm(deps, dist, trigger) {
  const snapshot = await snapshotFor(deps, dist.page_id, dist.business_phone);
  const now = deps.now();
  await deps.db.updateDistribution(dist.id, {
    status: "queued", trigger, snapshot, confirmed_at: now, updated_at: now,
  });
}

// Dashboard publish: already explicit, so it skips awaiting_confirm entirely.
async function createQueued(deps, { page, business, trigger, force }) {
  const id = crypto.randomUUID();
  const now = deps.now();
  const pageUrl = `${deps.pageBaseUrl}/p/${page.page_id}`;
  const dist = {
    id, page_id: page.page_id, business_phone: page.business_phone,
    status: "queued", trigger, force: !!force,
    targets: baseTargets(),
    snapshot: {
      title: (page.property && page.property.title) || "",
      page_url: pageUrl,
      video_url: (page.hero && page.hero.video_url) || null,
      poster_url: (page.hero && page.hero.poster_url) || null,
      photo_urls: ((page.gallery && page.gallery.images) || []).map((i) => i.url).slice(0, 10),
      copy: deps.shareKit.buildPostCopy(page, pageUrl),
      groups: deps.shareKit.sanitizeGroups(
        (business && business.distribution && business.distribution.groups) || []),
    },
    created_at: now, updated_at: now, confirmed_at: now,
  };
  await deps.db.saveDistribution(dist);
  return dist;
}

// Shared error classification for a publish target — one implementation so
// the facebook_page and instagram branches can't drift apart.
// Returns "auth" | "requeued" | "terminal". On auth errors the local `conn`
// is mutated too: in prod getConnection returned a snapshot, and without
// this the next target in the SAME run would still see needs_reconnect=false
// (stale read ⇒ dead-token publish attempt + a second reconnect nudge).
async function failTarget(deps, dist, conn, targetKey, err, { attempts, canRequeue }) {
  const { db } = deps;
  const vendorText = String((err && err.message) || "unknown").slice(0, 500);
  const base = `targets.${targetKey}`;
  if (deps.meta.isAuthError(err)) {
    const firstNotice = !(conn && conn.needs_reconnect);
    await db.setConnection(dist.business_phone, { needs_reconnect: true });
    if (conn) conn.needs_reconnect = true;
    await db.updateDistribution(dist.id, {
      [`${base}.status`]: "failed", [`${base}.error`]: vendorText,
      [`${base}.attempts`]: attempts, updated_at: deps.now(),
    });
    await audit(deps, dist, targetKey, "publish_failed", { error: vendorText });
    if (firstNotice) await notify(deps, dist.business_phone, M.reconnect());
    return "auth";
  }
  if (err instanceof deps.meta.GraphError && attempts < MAX_ATTEMPTS && canRequeue) {
    await db.updateDistribution(dist.id, {
      status: "queued", [`${base}.attempts`]: attempts,
      [`${base}.error`]: vendorText, updated_at: deps.now(),
    });
    return "requeued";
  }
  await db.updateDistribution(dist.id, {
    [`${base}.status`]: "failed", [`${base}.error`]: vendorText,
    [`${base}.attempts`]: attempts, updated_at: deps.now(),
  });
  await audit(deps, dist, targetKey, "publish_failed", { error: vendorText });
  return "terminal";
}

// ── execution ──
async function executeJob(deps, dist) {
  if (!dist.page_id || !dist.targets || !dist.snapshot) {
    throw new Error(`malformed distribution doc ${dist.id}`);
  }
  const { db } = deps;
  const title = dist.snapshot.title || "";

  // Layer 1: page-wide duplicate check, any sibling, any status.
  const sibs = (await db.listDistributionsByPage(dist.page_id))
    .filter((d) => d.id !== dist.id);
  if (hasLivePost(sibs) && !dist.force) {
    await db.updateDistribution(dist.id,
      { status: "skipped_duplicate", updated_at: deps.now() });
    await notify(deps, dist.business_phone, M.duplicate(title));
    return;
  }

  const conn = await db.getConnection(dist.business_phone);
  const fb = dist.targets.facebook_page;
  let summary = null;

  if (fb.status === "pending") {
    const hasMedia = !!dist.snapshot.video_url || (dist.snapshot.photo_urls || []).length > 0;
    if (!conn || !conn.page_token || conn.needs_reconnect || !hasMedia) {
      const why = !hasMedia ? "no_media"
        : (conn && conn.needs_reconnect) ? "needs_reconnect" : "not_connected";
      await db.updateDistribution(dist.id, {
        "targets.facebook_page.status": "skipped",
        "targets.facebook_page.error": why, updated_at: deps.now(),
      });
      fb.status = "skipped";
      if (why !== "no_media") summary = M.notConnected(title);
    } else {
      try {
        const g = { pageId: conn.page_id, pageToken: conn.page_token,
          graphVersion: deps.graphVersion };
        const res = dist.snapshot.video_url
          ? await deps.meta.publishVideo({ ...g, fileUrl: dist.snapshot.video_url,
              description: dist.snapshot.copy })
          : await deps.meta.publishPhotos({ ...g, photoUrls: dist.snapshot.photo_urls,
              message: dist.snapshot.copy });
        const postUrl = deps.meta.postUrl(res.id);
        // Layer 2: the post id lands in Firestore BEFORE anything else runs.
        await db.updateDistribution(dist.id, {
          "targets.facebook_page.status": "posted",
          "targets.facebook_page.post_id": res.id,
          "targets.facebook_page.post_url": postUrl,
          updated_at: deps.now(),
        });
        fb.status = "posted"; fb.post_id = res.id; fb.post_url = postUrl;
        await audit(deps, dist, "facebook_page",
          dist.force ? "reposted" : "published", { post_id: res.id, post_url: postUrl });
        summary = M.posted(title, postUrl);
      } catch (err) {
        const attempts = (fb.attempts || 0) + 1;
        // Transient Graph errors requeue (≤3 attempts); auth errors flip
        // needs_reconnect; a non-Graph failure (timeout/network) on the
        // visible post is Layer 3: terminal, never retried.
        const outcome = await failTarget(deps, dist, conn, "facebook_page", err,
          { attempts, canRequeue: true });
        if (outcome === "requeued") return;
        fb.status = "failed";
        if (outcome === "terminal") {
          const isTimeout = !(err instanceof deps.meta.GraphError);
          summary = isTimeout ? M.timeoutCheck(title) : M.failed(title);
        }
      }
    }
  }

  // Instagram target (day 5): same rules, one difference — once Facebook has
  // posted, this doc may never return to "queued" (the sweeper would re-run
  // the whole job), so IG transient failures become terminal after an FB post.
  const ig = dist.targets.instagram;
  if (ig && ig.status === "pending") {
    const media = !!dist.snapshot.video_url || (dist.snapshot.photo_urls || []).length > 0;
    if (!conn || !conn.page_token || conn.needs_reconnect || !conn.ig_business_id || !media) {
      await db.updateDistribution(dist.id, {
        "targets.instagram.status": "skipped",
        "targets.instagram.error": (conn && conn.ig_business_id) ? "not_available" : "no_ig_account",
        updated_at: deps.now(),
      });
      ig.status = "skipped";
    } else {
      try {
        const r = await deps.instagram.publishToInstagram({
          igBusinessId: conn.ig_business_id, pageToken: conn.page_token,
          snapshot: dist.snapshot, graphVersion: deps.graphVersion });
        await db.updateDistribution(dist.id, {
          "targets.instagram.status": "posted",
          "targets.instagram.media_id": r.media_id,
          "targets.instagram.permalink": r.permalink, updated_at: deps.now(),
        });
        ig.status = "posted";
        await audit(deps, dist, "instagram", dist.force ? "reposted" : "published",
          { post_id: r.media_id, post_url: r.permalink });
        summary = (summary ? summary + "\n" : "") + M.igPosted(title, r.permalink);
      } catch (err) {
        const attempts = (ig.attempts || 0) + 1;
        // Once Facebook has posted, this doc may never requeue (the sweeper
        // would re-run the whole job) — IG transient failures become terminal.
        const outcome = await failTarget(deps, dist, conn, "instagram", err,
          { attempts, canRequeue: fb.status !== "posted" });
        if (outcome === "requeued") {
          // Don't lose an already-composed FB failure/timeout warning — the
          // next sweep starts with a fresh (null) summary.
          if (summary) await notify(deps, dist.business_phone, summary);
          return;
        }
        ig.status = "failed";
        if (outcome === "terminal" && fb.status === "posted") {
          summary = (summary ? summary + "\n" : "") + M.igFailedFbOk(title);
        }
      }
    }
  }

  // Share kit: always attempted, never able to fail the job.
  if (dist.targets.share_kit.status === "pending") {
    try {
      const kit = deps.shareKit.buildShareKitMessage({
        copy: dist.snapshot.copy, pageUrl: dist.snapshot.page_url,
        groups: dist.snapshot.groups,
      });
      await deps.sendWhatsApp(dist.business_phone, kit);
      await db.updateDistribution(dist.id,
        { "targets.share_kit.status": "sent", updated_at: deps.now() });
      await audit(deps, dist, "share_kit", "share_kit_sent", {});
    } catch (e) {
      await db.updateDistribution(dist.id, {
        "targets.share_kit.status": "skipped",
        "targets.share_kit.error": String(e && e.message).slice(0, 200),
        updated_at: deps.now(),
      });
    }
  }

  await db.updateDistribution(dist.id, {
    status: (fb.status === "failed" || (ig && ig.status === "failed")) ? "failed" : "done",
    updated_at: deps.now(),
  });
  if (summary) await notify(deps, dist.business_phone, summary);
}

// ── the sweeper ──
async function runSweep(deps) {
  const queued = await deps.db.listQueuedDistributions(10);
  for (const dist of queued) {
    try {
      await deps.db.updateDistribution(dist.id,
        { status: "running", updated_at: deps.now() });
      await executeJob(deps, dist);
    } catch (err) {
      // Per-job isolation: a malformed doc is terminal; anything else returns
      // the doc to the queue for the next sweep (spec §7).
      console.error(`distribution job ${dist.id} failed:`, err && err.message);
      const terminal = /malformed/.test(String(err && err.message));
      try {
        await deps.db.updateDistribution(dist.id,
          { status: terminal ? "failed" : "queued", updated_at: deps.now() });
      } catch (e2) { console.error("job status reset failed:", e2 && e2.message); }
    }
  }
}

// In-process latch: overlapping sweeps are prevented per container. This is a
// single-container deployment; a second container would need a Firestore
// claim-with-precondition instead (documented limitation, spec §7).
let sweeping = false;
function startSweeper(deps) {
  const t = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try { await runSweep(deps); }
    catch (e) { console.error("distribution sweep failed:", e && e.message); }
    finally { sweeping = false; }
  }, SWEEP_MS);
  t.unref();
  console.log("distribution sweeper started (60s)");
}

module.exports = {
  MAX_ATTEMPTS, M, baseTargets, hasLivePost, hasInFlight,
  liveDeps, maybeOffer, enqueueFromConfirm, createQueued,
  executeJob, runSweep, startSweeper,
};
