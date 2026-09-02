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
const FENCE = "──────────";
const M = {
  // The copy is shown in full: the agent approves EXACTLY what will appear
  // under their name — that is the trust moment of the whole feature.
  confirmOffer: (title, pageUrl, confirmLink, copy) =>
    `🚀 דף הנכס "${title}" מוכן!\n${pageUrl}\n\n` +
    (copy ? `כך ייראה הפוסט:\n${FENCE}\n${copy}\n${FENCE}\n\n` : "") +
    `לפרסום אוטומטי בדף הפייסבוק שלכם + ערכת שיתוף לקבוצות, הקישו לאישור:\n${confirmLink}\n\n` +
    `לא מפרסמים בלי האישור שלכם.`,
  duplicate: (title) =>
    `ℹ️ הנכס "${title}" כבר פורסם בעבר — לא פרסמנו שוב.\n` +
    `אפשר לפרסם מחדש בכוונה דרך עמוד ההפצה בדשבורד.`,
  notConnected: (title, dashUrl) =>
    `⚠️ הנכס "${title}" לא פורסם — דף הפייסבוק עדיין לא חובר.\n` +
    `מתחברים פעם אחת ומהפעם הבאה הפרסום אוטומטי:\n${dashUrl}`,
  reconnect: (dashUrl) =>
    `⚠️ החיבור לפייסבוק פג תוקף. פרסום אוטומטי מושהה עד חיבור מחדש:\n${dashUrl}`,
  noPermission: (title, dashUrl) =>
    `⚠️ "${title}" לא פורסם — פייסבוק לא אישר לנו לפרסם בדף.\n` +
    `חברו מחדש ואשרו את כל ההרשאות שמתבקשות:\n${dashUrl}`,
  posted: (title, postUrl) =>
    `✅ הנכס "${title}" פורסם בדף הפייסבוק שלכם!\n${postUrl}`,
  mediaUnreachable: (title) =>
    `⚠️ "${title}" לא פורסם — קובצי המדיה של הנכס אינם זמינים לפייסבוק.\n` +
    `בנו את דף הנכס מחדש ונסו שוב.`,
  failed: (title) =>
    `❌ הפרסום של "${title}" בדף הפייסבוק נכשל. ננסה שוב אוטומטית מאוחר יותר.`,
  timeoutCheck: (title) =>
    `⚠️ הפרסום של "${title}" לא אושר על ידי פייסבוק בזמן. ייתכן שהפוסט כן עלה — ` +
    `בדקו בדף הפייסבוק שלכם לפני ניסיון נוסף.`,
  igPosted: (title, link) => `📸 "${title}" פורסם גם באינסטגרם!${link ? `\n${link}` : ""}`,
  igFailedFbOk: (title) =>
    `⚠️ "${title}": הפרסום באינסטגרם נכשל — הפוסט בדף הפייסבוק עלה כרגיל.`,
};

/*
 * Interactive variants (Green API sendInteractiveButtons). Each returns the
 * button payload; the matching M.* text is always passed as the fallback, so
 * an instance that can't render buttons still delivers the link.
 * WhatsApp body caps around 1KB — the post preview is clipped, never the CTA.
 */
const clip = (s, n) => {
  const t = String(s || "");
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
};

const BTN = {
  confirmOffer: ({ title, pageUrl, confirmLink, copy }) => ({
    header: "🚀 הנכס מוכן לפרסום",
    body: `"${title}"\n\nכך ייראה הפוסט:\n${FENCE}\n${clip(copy, 650)}\n${FENCE}`,
    footer: "לא מפרסמים בלי האישור שלכם",
    buttons: [
      { type: "url", buttonId: "confirm", buttonText: "✅ אישור ופרסום", url: confirmLink },
      { type: "url", buttonId: "page", buttonText: "👀 לצפייה בדף", url: pageUrl },
    ],
  }),
  // Three buttons, the Green API maximum: copy the link straight to the
  // clipboard, open the live post, and open the sharing queue.
  queue: ({ title, groupCount, queueUrl, postUrl, copyUrl }) => ({
    header: postUrl ? "✅ פורסם בדף הפייסבוק" : "📣 ערכת השיתוף מוכנה",
    body: `"${title}"\n\n` + (groupCount
      ? `${groupCount} קבוצות מחכות לשיתוף — הטקסט כבר מוכן, עוברים קבוצה־קבוצה.`
      : "עדיין לא בחרתם קבוצות — אפשר להוסיף אותן בעמוד ההפצה."),
    footer: "פרסום בקבוצות נעשה על ידכם, בהקשה אחת לכל קבוצה",
    buttons: [
      ...(copyUrl
        ? [{ type: "copy", buttonId: "copy", buttonText: "העתקת הקישור", copyCode: copyUrl }]
        : []),
      ...(postUrl
        ? [{ type: "url", buttonId: "post", buttonText: "לצפייה בפוסט", url: postUrl }]
        : []),
      { type: "url", buttonId: "queue", buttonText: "📣 שיתוף לקבוצות", url: queueUrl },
    ],
  }),
  dashboard: ({ header, body, footer, dashUrl, label }) => ({
    header, body, footer,
    buttons: [{ type: "url", buttonId: "dash", buttonText: label, url: dashUrl }],
  }),
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
  const { sendWhatsApp, sendWhatsAppButtons } = require("../utils");
  return {
    db, meta, shareKit, config, instagram, env, pageBaseUrl,
    // Where Facebook fetches media from: the stable upload host, not a
    // per-session BASE_URL (which may be a dev tunnel Meta can't reach).
    mediaBaseUrl: (env.REMOTE_UPLOAD_BASE || pageBaseUrl || "").replace(/\/+$/, ""),
    graphVersion: env.META_GRAPH_VERSION || meta.DEFAULT_VERSION,
    signActionToken: (parts) => signActionToken(parts, authSecret),
    sendWhatsApp: (phone, msg) => sendWhatsApp(phone, msg, greenInstance, greenToken),
    sendWhatsAppButtons: (phone, payload) =>
      sendWhatsAppButtons(phone, payload, greenInstance, greenToken),
    now: () => new Date(),
    getBusinessCached: (phone) => businessCache.get(phone),
  };
}

// Best-effort WhatsApp — a messaging failure must never fail a job (spec §7).
async function notify(deps, phone, msg) {
  try { await deps.sendWhatsApp(phone, msg); }
  catch (e) { console.warn("distribution notify failed:", e && e.message); }
}

// Interactive send with a guaranteed text fallback: buttons are a nicety,
// the link is the message. Any button failure (unsupported instance, API
// rejection) silently degrades to the plain text version.
async function notifyRich(deps, phone, payload, fallbackText) {
  if (deps.sendWhatsAppButtons) {
    try {
      await deps.sendWhatsAppButtons(phone, payload);
      return;
    } catch (e) {
      console.warn("interactive send failed, falling back to text:", e && e.message);
    }
  }
  await notify(deps, phone, fallbackText);
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
  const pageUrl = `${deps.pageBaseUrl}/p/${page.page_id}`;
  const copy = deps.shareKit.buildPostCopy(page, pageUrl);
  await notifyRich(deps, page.business_phone,
    BTN.confirmOffer({ title, pageUrl, confirmLink: link, copy }),
    M.confirmOffer(title, pageUrl, link, copy));
  return { offered: true, id };
}

// Facebook fetches media from OUR host, so the URL must be one the public
// internet can reach. Page docs are built with whatever BASE_URL was live at
// build time — a dev tunnel, sometimes — which Meta answers with "Unable to
// fetch video file from URL". Anything under /files/ is served by this app,
// so it is re-pointed at the stable media host at publish time.
function publicMedia(deps, url) {
  if (!url || !deps.mediaBaseUrl) return url || null;
  try {
    const u = new URL(String(url));
    if (!u.pathname.startsWith("/files/")) return url;
    return `${deps.mediaBaseUrl}${u.pathname}${u.search}`;
  } catch { return url; }
}

// Facebook fetches media by URL; if our own host 404s (page built against a
// base that no longer serves the files) the publish CANNOT succeed, so it is
// stopped here with an honest message instead of three retries and "we'll
// try again later". Network hiccups and HEAD-hostile hosts pass through —
// only an explicit 4xx/5xx counts as unreachable.
async function mediaUnreachable(deps, url) {
  if (!url) return false;
  const f = deps.fetchFn || fetch;
  try {
    const r = await f(url, { method: "HEAD", signal: AbortSignal.timeout(10000) });
    return !r.ok && r.status !== 405 && r.status !== 501;
  } catch { return false; }
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
    video_url: publicMedia(deps, (page.hero && page.hero.video_url) || null),
    poster_url: publicMedia(deps, (page.hero && page.hero.poster_url) || null),
    photo_urls: ((page.gallery && page.gallery.images) || [])
      .map((i) => publicMedia(deps, i.url)).slice(0, 10),
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
  const dist = {
    id, page_id: page.page_id, business_phone: page.business_phone,
    status: "queued", trigger, force: !!force,
    targets: baseTargets(),
    snapshot: await snapshotFor(deps, page.page_id, page.business_phone),
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
    if (firstNotice) {
      const dashUrl = `${deps.pageBaseUrl}/distribution.html`;
      await notifyRich(deps, dist.business_phone, BTN.dashboard({
        header: "⚠️ החיבור לפייסבוק פג תוקף",
        body: "הפרסום האוטומטי מושהה עד שתחברו מחדש. זה לוקח פחות מדקה.",
        footer: "הנכסים והקבוצות שלכם נשמרו",
        dashUrl, label: "חיבור מחדש",
      }), M.reconnect(dashUrl));
    }
    return "auth";
  }
  // Missing scope on the Page: the token is valid, retrying can't help, and
  // it is NOT an expiry — the agent must reconnect and grant the permission.
  if (deps.meta.isPermissionError && deps.meta.isPermissionError(err)) {
    await db.updateDistribution(dist.id, {
      [`${base}.status`]: "failed", [`${base}.error`]: vendorText,
      [`${base}.attempts`]: attempts, updated_at: deps.now(),
    });
    await audit(deps, dist, targetKey, "publish_failed", { error: vendorText });
    return "permission";
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

// ── group share sessions (the in-app sharing queue) ──
// Facebook has no Groups publishing API, so Forly automates the PREPARATION
// and never the Facebook action: per-group copy with a tracked link, an open
// button, and states the agent confirms by hand (spec §1, review §1).
const groupKey = (url) =>
  crypto.createHash("sha256").update(url).digest("base64url").slice(0, 10);

// Groups for one property: its own saved selection first, the agent's
// default list only as a fallback. Callers may pass `groups` explicitly.
async function resolveGroups(deps, page, business, explicit) {
  if (Array.isArray(explicit)) return deps.shareKit.sanitizeGroups(explicit);
  const own = deps.db.getPropertyGroups
    ? await deps.db.getPropertyGroups(page.page_id).catch(() => null)
    : null;
  if (own && Array.isArray(own.groups) && own.groups.length) {
    return deps.shareKit.sanitizeGroups(own.groups);
  }
  return deps.shareKit.sanitizeGroups(
    (business && business.distribution && business.distribution.groups) || []);
}

async function createShareSession(deps, { page, business, copy, postUrl, groups: explicit }) {
  const id = crypto.randomUUID();
  const now = deps.now();
  const pageUrl = `${deps.pageBaseUrl}/p/${page.page_id}`;
  const groups = await resolveGroups(deps, page, business, explicit);
  const session = {
    id, business_phone: page.business_phone, page_id: page.page_id,
    created_at: now, updated_at: now,
    snapshot: {
      title: (page.property && page.property.title) || "",
      page_url: pageUrl,
      copy: copy || deps.shareKit.buildPostCopy(page, pageUrl),
      listing_type: (page.property && page.property.listing_type) || "sale",
      // City drives the "same city ⇒ reuse those groups" offer in the queue.
      city: (page.property && page.property.city) || null,
      post_url: postUrl || null,
    },
    groups: groups.map((url) => ({
      key: groupKey(url), url,
      // Per-group attribution token (review §5): rides the SHARED link only.
      token: crypto.randomBytes(6).toString("base64url"),
      state: "ready",
      copied_at: null, opened_at: null, marked_posted_at: null,
      skipped_at: null, skip_reason: null,
    })),
  };
  await deps.db.saveShareSession(session);
  return session;
}

function queueUrl(deps, session) {
  return `${deps.pageBaseUrl}/share.html?s=${session.id}` +
    `&t=${deps.signActionToken([session.id, "share"])}`;
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
    const postUrl = (sibs.map(livePostOf).filter(Boolean).length &&
      sibs.find((d) => livePostOf(d)).targets.facebook_page.post_url) || null;
    await notifyRich(deps, dist.business_phone, {
      header: "ℹ️ הנכס כבר פורסם",
      body: `"${title}" פורסם בעבר — לא פרסמנו שוב.\n` +
        "אפשר לפרסם מחדש בכוונה מעמוד ההפצה.",
      footer: "הגנה מפני פרסום כפול",
      buttons: [
        ...(postUrl ? [{ type: "url", buttonId: "post",
          buttonText: "לצפייה בפוסט", url: postUrl }] : []),
        { type: "url", buttonId: "dash", buttonText: "עמוד ההפצה",
          url: `${deps.pageBaseUrl}/distribution.html` },
      ],
    }, M.duplicate(title));
    return;
  }

  const conn = await db.getConnection(dist.business_phone);
  const fb = dist.targets.facebook_page;
  let summary = null;      // plain-text fallback, always set when notifying
  let summaryBtn = null;   // interactive variant when there's a clear next step

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
      if (why !== "no_media") {
        // "not connected" and "connected but paused" are different problems;
        // telling a connected agent their Page isn't linked sends them
        // hunting for a setting that is already correct.
        const dashUrl = `${deps.pageBaseUrl}/distribution.html`;
        const paused = why === "needs_reconnect";
        summary = paused ? M.reconnect(dashUrl) : M.notConnected(title, dashUrl);
        summaryBtn = BTN.dashboard({
          header: paused ? "⚠️ הפרסום מושהה" : "⚠️ הנכס לא פורסם",
          body: paused
            ? `"${title}" לא פורסם — החיבור לפייסבוק דורש חידוש.\n` +
              "חיבור מחדש לוקח פחות מדקה, והנכסים והקבוצות שלכם נשמרו."
            : `"${title}" לא פורסם — דף הפייסבוק עדיין לא חובר.\n` +
              "חיבור חד-פעמי, ומהנכס הבא הפרסום אוטומטי.",
          footer: "ערכת השיתוף לקבוצות נשלחה בכל מקרה",
          dashUrl, label: paused ? "חיבור מחדש" : "חיבור דף הפייסבוק",
        });
      }
    } else if (await mediaUnreachable(deps,
        dist.snapshot.video_url || (dist.snapshot.photo_urls || [])[0])) {
      await db.updateDistribution(dist.id, {
        "targets.facebook_page.status": "skipped",
        "targets.facebook_page.error": "media_unreachable", updated_at: deps.now(),
      });
      fb.status = "skipped";
      await audit(deps, dist, "facebook_page", "publish_failed",
        { error: "media_unreachable" });
      summary = M.mediaUnreachable(title);
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
        // One post can't carry video AND photos — attach gallery photos as
        // Page comments under the video post. Best-effort: a comment failure
        // never touches the (already persisted, audited) post.
        if (dist.snapshot.video_url && (dist.snapshot.photo_urls || []).length &&
            typeof deps.meta.commentWithPhoto === "function") {
          let attached = 0;
          for (const photoUrl of dist.snapshot.photo_urls.slice(0, 4)) {
            try {
              await deps.meta.commentWithPhoto({
                objectId: res.id, pageToken: conn.page_token,
                message: attached === 0
                  ? `עוד תמונות מהנכס 👇\n${dist.snapshot.page_url}` : "",
                photoUrl, graphVersion: deps.graphVersion });
              attached++;
            } catch (e) { break; }
          }
          if (attached) {
            await db.updateDistribution(dist.id, {
              "targets.facebook_page.photo_comments": attached,
              updated_at: deps.now() });
          }
        }
      } catch (err) {
        const attempts = (fb.attempts || 0) + 1;
        // Transient Graph errors requeue (≤3 attempts); auth errors flip
        // needs_reconnect; a non-Graph failure (timeout/network) on the
        // visible post is Layer 3: terminal, never retried.
        const outcome = await failTarget(deps, dist, conn, "facebook_page", err,
          { attempts, canRequeue: true });
        if (outcome === "requeued") return;
        fb.status = "failed";
        if (outcome === "permission") {
          const dashUrl = `${deps.pageBaseUrl}/distribution.html`;
          summary = M.noPermission(title, dashUrl);
          summaryBtn = BTN.dashboard({
            header: "⚠️ הפרסום לא אושר על ידי פייסבוק",
            body: `"${title}" לא פורסם — חסרה הרשאת פרסום לדף.\n` +
              "חברו מחדש ואשרו את כל ההרשאות. פחות מדקה.",
            footer: "ערכת השיתוף לקבוצות נשלחה בכל מקרה",
            dashUrl, label: "חיבור מחדש",
          });
        } else if (outcome === "terminal") {
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

  // Share queue: always attempted, never able to fail the job. Instead of a
  // wall of raw links, the agent gets one deep link into a resumable in-app
  // queue (created here so the WhatsApp message can carry it).
  if (dist.targets.share_kit.status === "pending") {
    try {
      const page = await db.getPage(dist.page_id);
      const business = await db.getBusiness(dist.business_phone);
      const session = await createShareSession(deps, {
        page: page || { page_id: dist.page_id, business_phone: dist.business_phone,
          property: { title: dist.snapshot.title } },
        business, copy: dist.snapshot.copy,
        postUrl: (fb && fb.post_url) || null,
      });
      const qUrl = queueUrl(deps, session);
      const qArgs = { title: dist.snapshot.title, groupCount: session.groups.length,
        queueUrl: qUrl, postUrl: (fb && fb.post_url) || null,
        // The copy button puts the shareable link straight on the clipboard —
        // the post itself when it exists, otherwise the property page.
        copyUrl: (fb && fb.post_url) || dist.snapshot.page_url };
      await notifyRich(deps, dist.business_phone,
        BTN.queue(qArgs), deps.shareKit.buildQueueMessage(qArgs));
      await db.updateDistribution(dist.id, {
        "targets.share_kit.status": "sent",
        "targets.share_kit.session_id": session.id,
        updated_at: deps.now() });
      await audit(deps, dist, "share_kit", "share_kit_sent", {});
      // The queue message already opened with the post link — don't send a
      // second WhatsApp saying the same thing.
      if (fb.status === "posted" && summary === M.posted(title, fb.post_url)) summary = null;
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
  if (summary) {
    if (summaryBtn) await notifyRich(deps, dist.business_phone, summaryBtn, summary);
    else await notify(deps, dist.business_phone, summary);
  }
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
  MAX_ATTEMPTS, M, BTN, baseTargets, hasLivePost, hasInFlight,
  liveDeps, maybeOffer, enqueueFromConfirm, createQueued, publicMedia,
  executeJob, runSweep, startSweeper,
  createShareSession, queueUrl, groupKey, resolveGroups,
};
