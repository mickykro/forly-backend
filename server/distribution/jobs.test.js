/*
 * Unit tests for distribution/jobs.js — the state machine against fakes.
 * Covers every double-post scenario from spec §8.
 * Run: node server/distribution/jobs.test.js
 */
const assert = require("assert");
const jobs = require("./jobs");
const meta = require("./meta");
const shareKit = require("./share-kit");
const config = require("./config");

// ── fakes ──
function fakeDb() {
  const dists = new Map(), actions = [], conns = new Map(), pages = new Map(), bizs = new Map();
  return {
    dists, actions, conns, pages, bizs,
    getPage: async (id) => pages.get(id) || null,
    getBusiness: async (p) => bizs.get(p) || null,
    // Copies both ways: production Firestore reads return snapshots, so the
    // fake must too — otherwise stale-connection-read bugs pass the suite.
    getConnection: async (p) => (conns.has(p) ? { ...conns.get(p) } : null),
    setConnection: async (p, patch) =>
      conns.set(p, Object.assign({ ...(conns.get(p) || {}) }, patch)),
    saveDistribution: async (d) => dists.set(d.id, JSON.parse(JSON.stringify(d))),
    getDistribution: async (id) => dists.get(id) || null,
    updateDistribution: async (id, patch) => {
      const d = dists.get(id);
      for (const [k, v] of Object.entries(patch)) {
        const parts = k.split("."); let o = d;
        while (parts.length > 1) { const kk = parts.shift(); o[kk] = o[kk] || {}; o = o[kk]; }
        o[parts[0]] = v;
      }
    },
    listDistributionsByPage: async (pid) => [...dists.values()].filter((d) => d.page_id === pid),
    listQueuedDistributions: async () => [...dists.values()].filter((d) => d.status === "queued"),
    addPostAction: async (a) => actions.push(a),
  };
}
// script: array of results; an Error throws, anything else resolves.
const scripted = (script) => async () => {
  const r = script.shift();
  if (r instanceof Error) throw r;
  return r;
};
function fakeMeta({ video = [], photos = [], comments = [] } = {}) {
  const commentCalls = [];
  return { GraphError: meta.GraphError, isAuthError: meta.isAuthError, postUrl: meta.postUrl,
    publishVideo: scripted(video), publishPhotos: scripted(photos),
    commentCalls,
    commentWithPhoto: async (args) => {
      commentCalls.push(args);
      const r = comments.shift();
      if (r instanceof Error) throw r;
      return r || { id: `CM${commentCalls.length}` };
    } };
}
function makeDeps({ db, metaMod }) {
  const sent = [];
  const deps = {
    db, meta: metaMod, shareKit, config, env: {},
    pageBaseUrl: "https://x.test", graphVersion: "v21.0",
    signActionToken: () => "TOK",
    sendWhatsApp: async (phone, msg) => sent.push({ phone, msg }),
    now: () => new Date("2026-08-16T10:00:00Z"),
    getBusinessCached: (p) => db.getBusiness(p),
  };
  return { deps, sent };
}
const PAGE = { page_id: "pg1", business_phone: "9725000", status: "active",
  property: { title: "דירה", rooms: 3, price: 1000000 },
  agent: { name: "דנה" },
  hero: { video_url: "https://x.test/v.mp4", poster_url: "https://x.test/p.jpg" },
  gallery: { images: [{ url: "https://x.test/1.jpg" }, { url: "https://x.test/2.jpg" }] } };
const CONN = { page_id: "fbp", page_name: "Dana Homes", page_token: "PT", needs_reconnect: false };
function seed(db, { conn = CONN, page = PAGE } = {}) {
  db.pages.set(page.page_id, page);
  db.bizs.set(page.business_phone, { features: { distribution: true },
    distribution: { groups: ["https://www.facebook.com/groups/g1"] } });
  if (conn) db.conns.set(page.business_phone, { ...conn });
}
async function queuedDist(deps, { force = false } = {}) {
  const db = deps.db;
  const page = await db.getPage("pg1");
  const biz = await db.getBusiness(page.business_phone);
  return jobs.createQueued(deps, { page, business: biz, trigger: "dashboard", force });
}

(async () => {
  // ── happy path: video post — id persisted, audit written, summary sent ──
  {
    const db = fakeDb(); seed(db);
    const { deps, sent } = makeDeps({ db, metaMod: fakeMeta({ video: [{ id: "V1" }] }) });
    const d = await queuedDist(deps);
    await jobs.runSweep(deps);
    const done = db.dists.get(d.id);
    assert.equal(done.status, "done");
    assert.equal(done.targets.facebook_page.status, "posted");
    assert.equal(done.targets.facebook_page.post_id, "V1");
    assert.equal(done.targets.facebook_page.post_url, "https://www.facebook.com/V1");
    assert.equal(done.targets.share_kit.status, "sent");
    const acts = db.actions.map((a) => a.action).sort();
    assert.deepEqual(acts, ["published", "share_kit_sent"]);
    const pub = db.actions.find((a) => a.action === "published");
    assert.equal(pub.post_id, "V1");
    assert.equal(pub.content.media_type, "video");
    assert.ok(pub.content.copy.includes("דירה"), "exact copy audited");
    assert.equal(pub.trigger, "dashboard");
    // share kit + summary both went to the agent
    assert.ok(sent.some((s) => s.msg.includes("ערכת שיתוף")));
    assert.ok(sent.some((s) => s.msg.includes("https://www.facebook.com/V1")));
  }

  // ── no video ⇒ multi-photo post ──
  {
    const db = fakeDb();
    seed(db, { page: { ...PAGE, hero: { poster_url: "https://x.test/p.jpg" } } });
    const { deps } = makeDeps({ db, metaMod: fakeMeta({ photos: [{ id: "F1" }] }) });
    const d = await queuedDist(deps);
    await jobs.runSweep(deps);
    const done = db.dists.get(d.id);
    assert.equal(done.targets.facebook_page.post_id, "F1");
    assert.equal(db.actions.find((a) => a.action === "published").content.media_type, "photos");
  }

  // ── double-post: sibling with a live post (any status) ⇒ skipped_duplicate ──
  {
    const db = fakeDb(); seed(db);
    // a FAILED old doc that still carries a post id counts as posted (spec §8)
    await db.saveDistribution({ id: "old", page_id: "pg1", business_phone: "9725000",
      status: "failed", targets: { facebook_page: { status: "failed", post_id: "OLD1" } } });
    const { deps, sent } = makeDeps({ db, metaMod: fakeMeta({ video: [{ id: "NEW" }] }) });
    const d = await queuedDist(deps);            // force defaults to false
    await jobs.runSweep(deps);
    assert.equal(db.dists.get(d.id).status, "skipped_duplicate");
    assert.equal(db.dists.get(d.id).targets.facebook_page.post_id, undefined, "nothing posted");
    assert.ok(sent.some((s) => s.msg.includes("כבר פורסם")), "honest duplicate line");
  }

  // ── force repost goes through and audits as "reposted" ──
  {
    const db = fakeDb(); seed(db);
    await db.saveDistribution({ id: "old", page_id: "pg1", business_phone: "9725000",
      status: "done", targets: { facebook_page: { status: "posted", post_id: "OLD1" } } });
    const { deps } = makeDeps({ db, metaMod: fakeMeta({ video: [{ id: "NEW" }] }) });
    const d = await queuedDist(deps, { force: true });
    await jobs.runSweep(deps);
    assert.equal(db.dists.get(d.id).targets.facebook_page.post_id, "NEW");
    assert.equal(db.actions.find((a) => a.post_id === "NEW").action, "reposted");
  }

  // ── concurrent queued docs for one page: exactly one post ──
  {
    const db = fakeDb(); seed(db);
    const { deps } = makeDeps({ db, metaMod: fakeMeta({ video: [{ id: "ONLY" }, { id: "WRONG" }] }) });
    const d1 = await queuedDist(deps);
    const d2 = await queuedDist(deps);
    await jobs.runSweep(deps);
    const statuses = [db.dists.get(d1.id).status, db.dists.get(d2.id).status].sort();
    assert.deepEqual(statuses, ["done", "skipped_duplicate"]);
    const posted = db.actions.filter((a) => a.action === "published");
    assert.equal(posted.length, 1, "one post only");
    assert.equal(posted[0].post_id, "ONLY");
  }

  // ── not connected: fb skipped with honest line, share kit still sent ──
  {
    const db = fakeDb(); seed(db, { conn: null });
    const { deps, sent } = makeDeps({ db, metaMod: fakeMeta() });
    const d = await queuedDist(deps);
    await jobs.runSweep(deps);
    const done = db.dists.get(d.id);
    assert.equal(done.status, "done");
    assert.equal(done.targets.facebook_page.status, "skipped");
    assert.equal(done.targets.share_kit.status, "sent");
    assert.ok(sent.some((s) => s.msg.includes("לא חובר")), "not-connected line");
    assert.ok(!db.actions.some((a) => a.action === "published"));
  }

  // ── auth error: needs_reconnect set, ONE nudge, terminal, audited ──
  {
    const db = fakeDb(); seed(db);
    const authErr = new meta.GraphError("expired", { code: 190, type: "OAuthException" });
    const { deps, sent } = makeDeps({ db, metaMod: fakeMeta({ video: [authErr] }) });
    const d = await queuedDist(deps);
    await jobs.runSweep(deps);
    assert.equal(db.conns.get("9725000").needs_reconnect, true);
    assert.equal(db.dists.get(d.id).status, "failed");
    assert.equal(db.dists.get(d.id).targets.facebook_page.status, "failed");
    const nudges = sent.filter((s) => s.msg.includes("חיבור")).length;
    assert.equal(nudges >= 1, true, "reconnect nudge sent");
    assert.ok(db.actions.some((a) => a.action === "publish_failed"));
    // vendor text stays in the doc/audit, never in WhatsApp
    assert.ok(!sent.some((s) => s.msg.includes("expired")));
    // second job while needs_reconnect: fb skipped, NO second nudge
    const before = sent.filter((s) => s.msg.includes("חיבור")).length;
    const d2 = await queuedDist(deps, { force: true });
    await jobs.runSweep(deps);
    assert.equal(db.dists.get(d2.id).targets.facebook_page.status, "skipped");
    assert.equal(sent.filter((s) => s.msg.includes("חיבור")).length, before, "single nudge");
  }

  // ── transient Graph error: retried up to 3 attempts, then failed ──
  {
    const db = fakeDb(); seed(db);
    const t = () => new meta.GraphError("try later", { code: 2 });
    const { deps } = makeDeps({ db, metaMod: fakeMeta({ video: [t(), t(), t()] }) });
    const d = await queuedDist(deps);
    await jobs.runSweep(deps);   // attempt 1 → back to queued
    assert.equal(db.dists.get(d.id).status, "queued");
    assert.equal(db.dists.get(d.id).targets.facebook_page.attempts, 1);
    await jobs.runSweep(deps);   // attempt 2 → back to queued
    await jobs.runSweep(deps);   // attempt 3 → terminal
    assert.equal(db.dists.get(d.id).status, "failed");
    assert.equal(db.dists.get(d.id).targets.facebook_page.attempts, 3);
    assert.ok(db.actions.some((a) => a.action === "publish_failed"));
  }

  // ── timeout/network on the visible post: TERMINAL, never retried ──
  {
    const db = fakeDb(); seed(db);
    const { deps, sent } = makeDeps({ db, metaMod: fakeMeta({ video: [new Error("fetch timeout")] }) });
    const d = await queuedDist(deps);
    await jobs.runSweep(deps);
    const done = db.dists.get(d.id);
    assert.equal(done.status, "failed");
    assert.equal(done.targets.facebook_page.attempts, 1, "no retry after timeout");
    assert.ok(sent.some((s) => s.msg.includes("בדקו בדף")), "check-your-page line");
  }

  // ── malformed doc doesn't kill the sweep ──
  {
    const db = fakeDb(); seed(db);
    await db.saveDistribution({ id: "bad", status: "queued" }); // no page_id/targets
    const { deps } = makeDeps({ db, metaMod: fakeMeta({ video: [{ id: "OK1" }] }) });
    const d = await queuedDist(deps);
    await jobs.runSweep(deps);
    assert.equal(db.dists.get("bad").status, "failed", "malformed doc marked failed");
    assert.equal(db.dists.get(d.id).status, "done", "healthy doc still executed");
  }

  // ── maybeOffer: entitled + fresh page ⇒ awaiting_confirm + confirm link ──
  {
    const db = fakeDb(); seed(db);
    const { deps, sent } = makeDeps({ db, metaMod: fakeMeta() });
    const r = await jobs.maybeOffer(deps, PAGE);
    assert.equal(r.offered, true);
    const d = db.dists.get(r.id);
    assert.equal(d.status, "awaiting_confirm");
    assert.equal(d.trigger, "auto");
    assert.ok(sent[0].msg.includes(`/api/distribution/confirm?d=${r.id}&t=TOK`));
    // second call while one is in flight: no duplicate offer
    const r2 = await jobs.maybeOffer(deps, PAGE);
    assert.equal(r2.offered, false);
    // not entitled ⇒ nothing happens
    db.bizs.set("9725000", { features: {} });
    const r3 = await jobs.maybeOffer(deps, { ...PAGE, page_id: "pg9" });
    assert.equal(r3.offered, false);
  }

  // ── enqueueFromConfirm snapshots page+groups at confirm time ──
  {
    const db = fakeDb(); seed(db);
    const { deps } = makeDeps({ db, metaMod: fakeMeta() });
    const r = await jobs.maybeOffer(deps, PAGE);
    await jobs.enqueueFromConfirm(deps, db.dists.get(r.id), "confirm_link");
    const d = db.dists.get(r.id);
    assert.equal(d.status, "queued");
    assert.equal(d.trigger, "confirm_link");
    assert.ok(d.confirmed_at);
    assert.equal(d.snapshot.video_url, "https://x.test/v.mp4");
    assert.deepEqual(d.snapshot.groups, ["https://www.facebook.com/groups/g1"]);
    assert.ok(d.snapshot.copy.includes("דירה"), "copy frozen into the snapshot");
  }

  // ── IG posts after FB, audited, both links in the summary ──
  {
    const db = fakeDb(); seed(db, { conn: { ...CONN, ig_business_id: "IG1" } });
    const { deps, sent } = makeDeps({ db, metaMod: fakeMeta({ video: [{ id: "V1" }] }) });
    deps.instagram = { publishToInstagram: scripted([
      { media_id: "M1", permalink: "https://www.instagram.com/p/x/" }]) };
    const d = await queuedDist(deps);
    await jobs.runSweep(deps);
    const done = db.dists.get(d.id);
    assert.equal(done.targets.instagram.status, "posted");
    assert.equal(done.targets.instagram.media_id, "M1");
    assert.ok(db.actions.some((a) => a.target === "instagram" && a.action === "published"));
    assert.ok(sent.some((s) => s.msg.includes("instagram.com/p/x")));
  }

  // ── no IG account linked ⇒ skipped, not failed, job still done ──
  {
    const db = fakeDb(); seed(db);   // CONN has no ig_business_id
    const { deps } = makeDeps({ db, metaMod: fakeMeta({ video: [{ id: "V1" }] }) });
    deps.instagram = { publishToInstagram: scripted([]) };
    const d = await queuedDist(deps);
    await jobs.runSweep(deps);
    assert.equal(db.dists.get(d.id).targets.instagram.status, "skipped");
    assert.equal(db.dists.get(d.id).status, "done");
  }

  // ── FB already posted + IG transient error ⇒ TERMINAL (no requeue!) ──
  {
    const db = fakeDb(); seed(db, { conn: { ...CONN, ig_business_id: "IG1" } });
    const { deps, sent } = makeDeps({ db, metaMod: fakeMeta({ video: [{ id: "V1" }] }) });
    deps.instagram = { publishToInstagram: scripted([
      new meta.GraphError("busy", { code: 2 })]) };
    const d = await queuedDist(deps);
    await jobs.runSweep(deps);
    const done = db.dists.get(d.id);
    assert.equal(done.targets.facebook_page.post_id, "V1");
    assert.notEqual(done.status, "queued", "must never requeue after an FB post");
    assert.equal(done.targets.instagram.status, "failed");
    assert.ok(sent.some((s) => s.msg.includes("אינסטגרם נכשל")));
  }

  // ── video post gets gallery photos attached as Page comments ──
  {
    const db = fakeDb(); seed(db);
    const metaMod = fakeMeta({ video: [{ id: "V1" }] });
    const { deps } = makeDeps({ db, metaMod });
    const d = await queuedDist(deps);
    await jobs.runSweep(deps);
    assert.equal(metaMod.commentCalls.length, 2, "both gallery photos commented");
    assert.equal(metaMod.commentCalls[0].objectId, "V1");
    assert.equal(metaMod.commentCalls[0].photoUrl, "https://x.test/1.jpg");
    assert.ok(metaMod.commentCalls[0].message.includes("עוד תמונות"), "first comment labeled");
    assert.equal(metaMod.commentCalls[1].message, "", "later comments unlabeled");
    assert.equal(db.dists.get(d.id).targets.facebook_page.photo_comments, 2);
  }

  // ── a comment failure never touches the already-posted job ──
  {
    const db = fakeDb(); seed(db);
    const metaMod = fakeMeta({ video: [{ id: "V1" }], comments: [new Error("nope")] });
    const { deps } = makeDeps({ db, metaMod });
    const d = await queuedDist(deps);
    await jobs.runSweep(deps);
    const done = db.dists.get(d.id);
    assert.equal(done.status, "done");
    assert.equal(done.targets.facebook_page.post_id, "V1");
    assert.equal(done.targets.facebook_page.photo_comments, undefined, "no count on failure");
  }

  // ── FB auth error with IG linked: ONE nudge, IG never tries the dead token ──
  {
    const db = fakeDb(); seed(db, { conn: { ...CONN, ig_business_id: "IG1" } });
    const authErr = new meta.GraphError("expired", { code: 190, type: "OAuthException" });
    const { deps, sent } = makeDeps({ db, metaMod: fakeMeta({ video: [authErr] }) });
    let igCalls = 0;
    deps.instagram = { publishToInstagram: async () => { igCalls++;
      throw new meta.GraphError("expired", { code: 190, type: "OAuthException" }); } };
    const d = await queuedDist(deps);
    await jobs.runSweep(deps);
    assert.equal(igCalls, 0, "IG must not attempt publishing with a dead token");
    assert.equal(sent.filter((s) => s.msg.includes("חיבור")).length, 1, "exactly one nudge");
    assert.equal(db.dists.get(d.id).targets.instagram.status, "skipped");
  }

  // ── FB timeout warning is NOT lost when IG transiently requeues the job ──
  {
    const db = fakeDb(); seed(db, { conn: { ...CONN, ig_business_id: "IG1" } });
    const { deps, sent } = makeDeps({ db, metaMod: fakeMeta({ video: [new Error("fetch timeout")] }) });
    deps.instagram = { publishToInstagram: scripted([
      new meta.GraphError("busy", { code: 2 }),
      { media_id: "M2", permalink: null }]) };
    const d = await queuedDist(deps);
    await jobs.runSweep(deps);   // FB timeout (terminal) + IG transient → requeued
    assert.ok(sent.some((s) => s.msg.includes("בדקו בדף")),
      "check-your-page warning sent before the IG requeue");
    assert.equal(db.dists.get(d.id).status, "queued");
    await jobs.runSweep(deps);   // IG retry succeeds
    assert.equal(db.dists.get(d.id).targets.instagram.status, "posted");
    assert.equal(db.dists.get(d.id).status, "failed", "FB terminal failure keeps the doc failed");
  }

  console.log("jobs.test.js OK");
})().catch((e) => { console.error(e); process.exit(1); });
