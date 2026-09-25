/*
 * db.js — Firestore (or in-memory fallback) storage helpers.
 * ponytail: single source for all collection access
 */

const { asMillis } = require("./utils");
const tokenVault = require("./distribution/token-vault");

let db = null;
let FieldValue = null;
const mem = { listings: new Map(), pages: new Map(), leads: new Map(), leadSubmissions: [], adminMessages: [], throttle: new Map(), otps: new Map(), portalEvents: [], connections: new Map(), distributions: new Map(), postActions: [], groupCatalog: [], shareSessions: new Map(), propertyGroups: new Map(), drafts: new Map(), extractJobs: new Map(), listingDrafts: new Map(), profileDeletes: new Map(), settings: new Map() };

// A personal `gcloud auth application-default login` file works until Google
// demands a re-login ("invalid_rapt"), and every Firestore call then fails for
// hours before anyone notices. Only a service-account key is safe to deploy.
function warnIfUserCredentials(path) {
  let type;
  try { type = JSON.parse(require("fs").readFileSync(path, "utf8")).type; } catch { return; }
  if (type === "authorized_user") {
    console.warn(`WARNING ${path} is a personal login (type: authorized_user), not a service account.\n` +
      "         Firestore will break once Google forces a re-login. Deploy a service-account key.");
  }
}

function init() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const admin = require("firebase-admin");
    admin.initializeApp();
    db = admin.firestore();
    FieldValue = admin.firestore.FieldValue;
    console.log("Firestore enabled (service account credentials found)");
    warnIfUserCredentials(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    // ponytail: first Firestore RPC sync-loads grpc protos and blocks the event
    // loop for ~30s — burn that at boot, not on the user's first OTP request.
    db.collection("_warmup").doc("_").get()
      .then(() => console.log("Firestore warm"))
      .catch((e) => console.warn("Firestore warmup failed:", e.message));
  } else {
    console.warn("No GOOGLE_APPLICATION_CREDENTIALS — using in-memory store.");
  }
}

// ── listings ──
async function saveListing(l) {
  if (db) await db.collection("listings").doc(l.listing_id).set(l);
  else mem.listings.set(l.listing_id, l);
}

async function getListing(id) {
  if (db) { const d = await db.collection("listings").doc(id).get(); return d.exists ? d.data() : null; }
  return mem.listings.get(id) || null;
}

async function setListingPageId(id, pageId) {
  if (db) await db.collection("listings").doc(id).set({ page_id: pageId }, { merge: true });
  else { const l = mem.listings.get(id); if (l) l.page_id = pageId; }
}

async function updateListing(id, patch) {
  if (db) await db.collection("listings").doc(id).set(patch, { merge: true });
  else Object.assign(mem.listings.get(id) || {}, patch);
}

async function listListingsByPhone(phone) {
  if (db) {
    const snap = await db.collection("listings").where("business_phone", "==", phone).limit(100).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.listings.values()].filter((l) => l.business_phone === phone);
}

// Listings from `source` still waiting for their page (equality filters only: no composite index needed).
async function listPendingListings(source) {
  if (db) {
    const snap = await db.collection("listings").where("source", "==", source)
      .where("status", "==", "active").where("page_id", "==", null).limit(200).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.listings.values()].filter((l) => l.source === source && l.status === "active" && !l.page_id);
}

// ── admin: full-collection reads (no phone filter) ──
async function listAllListings(limit = 1000) {
  if (db) {
    const snap = await db.collection("listings").limit(limit).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.listings.values()];
}

// ── pages ──
async function savePage(p) {
  if (db) await db.collection("property_pages").doc(p.page_id).set(p);
  else mem.pages.set(p.page_id, p);
}

async function getPage(id) {
  if (db) { const d = await db.collection("property_pages").doc(id).get(); return d.exists ? d.data() : null; }
  return mem.pages.get(id) || null;
}

// ── admin: full-collection page read (no phone filter) ──
async function listAllPages(limit = 1000) {
  if (db) {
    const snap = await db.collection("property_pages").limit(limit).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.pages.values()];
}

async function findActivePageByListing(listingId) {
  if (db) {
    const snap = await db.collection("property_pages").where("listing_id", "==", listingId).limit(5).get();
    const doc = snap.docs.find((d) => d.get("status") !== "archived");
    return doc ? doc.data() : null;
  }
  for (const p of mem.pages.values()) {
    if (p.listing_id === listingId && p.status !== "archived") return p;
  }
  return null;
}

// ── pretty page ids: {agent-slug}-{shortcode} instead of a raw UUID ──
// Content is Hebrew, so the agent part is transliterated to Latin (Hebrew in a
// URL percent-encodes into something uglier than a UUID); the random suffix
// guarantees uniqueness and keeps pages from being trivially enumerable.
const HE_LATIN = {
  "א": "a", "ב": "b", "ג": "g", "ד": "d", "ה": "h", "ו": "v", "ז": "z",
  "ח": "ch", "ט": "t", "י": "y", "כ": "k", "ך": "k", "ל": "l", "מ": "m",
  "ם": "m", "נ": "n", "ן": "n", "ס": "s", "ע": "a", "פ": "p", "ף": "f",
  "צ": "tz", "ץ": "tz", "ק": "k", "ר": "r", "ש": "sh", "ת": "t",
};
function agentSlug(agent) {
  const raw = (agent && (agent.brand_name || agent.name)) || "";
  const s = raw.split("").map((c) => (c in HE_LATIN ? HE_LATIN[c] : c)).join("")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/g, "");
  return s || "nadlan";
}
// Unambiguous base32 (no 0/1/o/i/l) so shared/typed links don't get mangled.
const SHORT_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
function shortCode(n) {
  const bytes = require("crypto").randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += SHORT_ALPHABET[bytes[i] % SHORT_ALPHABET.length];
  return out;
}
// {agentSlug}-{shortCode}, collision-checked against existing pages. 30^5 ≈ 24M
// suffixes per agent prefix, so the loop effectively never repeats.
async function uniquePageId(agent) {
  const base = agentSlug(agent);
  for (let i = 0; i < 6; i++) {
    const cand = `${base}-${shortCode(5)}`;
    if (!(await getPage(cand))) return cand;
  }
  return `${base}-${shortCode(8)}`;
}

// Live pages for the public buyer portal (call4li.com). "expiring" is kept for
// pages flagged before the expiry system was retired. Sorted in memory to
// avoid a Firestore composite index on status+created_at.
async function listPublicPages(limit = 200) {
  let pages;
  if (db) {
    const snap = await db.collection("property_pages")
      .where("status", "in", ["active", "expiring"])
      .limit(limit).get();
    pages = snap.docs.map((d) => d.data());
  } else {
    pages = [...mem.pages.values()]
      .filter((p) => p.status === "active" || p.status === "expiring")
      .slice(0, limit);
  }
  return pages.sort((a, b) => asMillis(b.created_at) - asMillis(a.created_at));
}

// Append-only analytics/trigger log for portal interactions (phone reveals
// etc.). Queryable per business_phone; future automations can watch it.
async function logPortalEvent(evt) {
  const doc = { ...evt, at: new Date() };
  if (db) await db.collection("portal_events").add(doc);
  else mem.portalEvents.push(doc);
}

// Pages at or past `soonMs`, for the daily reminder/expire sweep.
async function listPagesForExpiry(soonMs) {
  if (db) {
    const snap = await db.collection("property_pages")
      .where("status", "in", ["active", "expiring"])
      .where("expires_at", "<=", new Date(soonMs))
      .limit(100).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.pages.values()]
    .filter((p) => (p.status === "active" || p.status === "expiring") && asMillis(p.expires_at) <= soonMs)
    .slice(0, 100);
}

async function incrPageCounter(pageId, field, by) {
  if (db) await db.collection("property_pages").doc(pageId).update({ [field]: FieldValue.increment(by) });
  else { const p = mem.pages.get(pageId); if (p) p[field] = (p[field] || 0) + by; }
}

// Partial page update from a { "dot.path": value } patch — avoids clobbering
// concurrently-incremented counters the way a full set() would.
async function updatePage(pageId, patch) {
  if (db) { await db.collection("property_pages").doc(pageId).update(patch); return; }
  const p = mem.pages.get(pageId);
  if (!p) return;
  for (const [key, val] of Object.entries(patch)) {
    const parts = key.split(".");
    let o = p;
    while (parts.length > 1) { const k = parts.shift(); o[k] = o[k] || {}; o = o[k]; }
    o[parts[0]] = val;
  }
}

// ── businesses ──
async function getBusiness(phone) {
  if (!db) return null;
  const d = await db.collection("businesses").doc(phone).get();
  return d.exists ? d.data() : null;
}

async function setBusiness(phone, data, merge = true) {
  if (!db) return;
  await db.collection("businesses").doc(phone).set(data, { merge });
}

// Starter quota doc, seeded once when a profile is completed. Never overwrites
// an existing one: the chat cap (routes/chat.js) and the n8n pipelines both
// keep running counters in here.
async function initQuota(phone, data) {
  if (!db) return;
  const ref = db.collection("businesses").doc(phone).collection("quota").doc("current");
  const snap = await ref.get();
  if (!snap.exists) await ref.set(data);
}

// ── admin: all businesses (agent directory) ──
async function listAllBusinesses(limit = 1000) {
  if (!db) return [];
  const snap = await db.collection("businesses").limit(limit).get();
  return snap.docs.map((d) => d.data());
}

// ── distribution: agent Meta connection ──
// businesses/{phone}/connections/facebook — per-agent tokens are DATA (spec
// §5): they live here, never in env or Secret Manager.
function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) &&
        target[k] && typeof target[k] === "object" && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

async function getConnection(phone) {
  const key = tokenVault.keyFrom(process.env);
  if (db) {
    const d = await db.collection("businesses").doc(phone)
      .collection("connections").doc("facebook").get();
    return d.exists ? tokenVault.openConnection(d.data(), key) : null;
  }
  const c = mem.connections.get(phone);
  return c ? tokenVault.openConnection(c, key) : null;
}

// merge:true in Firestore deep-merges maps; the mem fallback must match or
// tests would pass against behavior prod doesn't have (spec §4 "deep-merge
// parity").
// Tokens are sealed (AES-GCM, META_TOKEN_KEY) before they touch storage —
// see distribution/token-vault.js. Without a key this is a passthrough.
async function setConnection(phone, patch) {
  const sealed = tokenVault.sealConnection(patch, tokenVault.keyFrom(process.env));
  if (db) {
    await db.collection("businesses").doc(phone)
      .collection("connections").doc("facebook").set(sealed, { merge: true });
    return;
  }
  mem.connections.set(phone, deepMerge(mem.connections.get(phone) || {}, sealed));
}

// posting_attempts live in posting-store.js (lazy require: no load cycle).
// profile-lifecycle.js's revoke()/quarantine() call it so a revoked/quarantined
// profile's reserved/session_started/composer_ready attempts stop instead of
// running against a profile that assertOwnership now refuses.
const cancelOpenAttempts = (...a) => require("./posting-store").cancelOpenAttempts(...a);

// ── operator settings (compare-and-set) ──
// One doc per key (e.g. "posting"), read by posting-guard.js on every
// assertAllowed() call — nothing is cached there, so a flipped switch here is
// seen at once. expectVersion lets an operator UI refuse to clobber a
// concurrent edit; a missing doc counts as version 0.
async function getSetting(key) {
  if (db) { const d = await db.collection("settings").doc(key).get(); return d.exists ? d.data() : null; }
  return mem.settings.get(key) || null;
}

function versionConflict() {
  const e = new Error("stale settings version"); e.code = "version_conflict"; return e;
}

async function setSetting(key, value, { expectVersion } = {}) {
  if (db) {
    return db.runTransaction(async (tx) => {
      const ref = db.collection("settings").doc(key);
      const snap = await tx.get(ref);
      const current = snap.exists ? snap.data() : {};
      if (expectVersion !== undefined && (current.version || 0) !== expectVersion) throw versionConflict();
      const next = Object.assign({}, current, value, { version: (current.version || 0) + 1, updated_at: new Date().toISOString() });
      tx.set(ref, next);
      return next;
    });
  }
  const current = mem.settings.get(key) || {};
  if (expectVersion !== undefined && (current.version || 0) !== expectVersion) throw versionConflict();
  const next = Object.assign({}, current, value, { version: (current.version || 0) + 1, updated_at: new Date().toISOString() });
  mem.settings.set(key, next);
  return next;
}

// ── profile deletes (pending Driver profile deletions) ──
// profile-lifecycle.js's revoke()/quarantine() write a row here when the
// Driver delete fails; retryDeletes() reads this collection itself (rather
// than being handed a list) so the daily sweeper only has to call it. Not
// hashed — the phone is already stored in plain text on this same phone's
// connection doc, so this adds no new exposure.
//
// `gen`: the profile generation this row's failed delete belongs to, and
// part of the row's key (`${platform}:${phone}:${gen}`) — a reconnect can
// bump `<platform>_profile_gen` while a delete for the OLD generation is
// still pending, and without a per-generation key a second failed delete
// (for the new generation) would overwrite the still-open row for the old
// one under the same bare `${platform}:${phone}` id, losing it. `gen` is
// optional only for a pre-existing row written before this field existed —
// such a row keeps living under the bare id, listed/retried/cleared exactly
// as before (profile-lifecycle.js's retryDeletes() treats `gen === undefined`
// as that legacy case).
function pendingDeleteId(platform, phone, gen) {
  return gen === undefined ? `${platform}:${phone}` : `${platform}:${phone}:${gen}`;
}

async function savePendingDelete({ phone, platform, since, attempts = 0, last_error = null, gen }) {
  const id = pendingDeleteId(platform, phone, gen);
  const rec = { id, phone: String(phone), platform, since, attempts, last_error };
  if (gen !== undefined) rec.gen = gen;
  if (db) { await db.collection("profile_deletes").doc(id).set(rec); return; }
  mem.profileDeletes.set(id, rec);
}

async function listPendingDeletes(limit = 100) {
  if (db) {
    const snap = await db.collection("profile_deletes").limit(limit).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.profileDeletes.values()].slice(0, limit);
}

async function clearPendingDelete(phone, platform, gen) {
  const id = pendingDeleteId(platform, phone, gen);
  if (db) { await db.collection("profile_deletes").doc(id).delete(); return; }
  mem.profileDeletes.delete(id);
}

// ── distribution: publish jobs ──
async function saveDistribution(d) {
  if (db) await db.collection("distributions").doc(d.id).set(d);
  else mem.distributions.set(d.id, JSON.parse(JSON.stringify(d)));
}

async function getDistribution(id) {
  if (db) { const d = await db.collection("distributions").doc(id).get(); return d.exists ? d.data() : null; }
  return mem.distributions.get(id) || null;
}

// Dot-path patch, same semantics as updatePage — a full set() would clobber
// fields a concurrent sweep just wrote.
async function updateDistribution(id, patch) {
  if (db) { await db.collection("distributions").doc(id).update(patch); return; }
  const d = mem.distributions.get(id);
  if (!d) return;
  for (const [key, val] of Object.entries(patch)) {
    const parts = key.split(".");
    let o = d;
    while (parts.length > 1) { const k = parts.shift(); o[k] = o[k] || {}; o = o[k]; }
    o[parts[0]] = val;
  }
}

// Single-field where, filtered/sorted in memory — no composite index needed.
async function listDistributionsByPage(pageId, limit = 50) {
  if (db) {
    const snap = await db.collection("distributions")
      .where("page_id", "==", pageId).limit(limit).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.distributions.values()].filter((d) => d.page_id === pageId).slice(0, limit);
}

async function listQueuedDistributions(limit = 10) {
  if (db) {
    const snap = await db.collection("distributions")
      .where("status", "==", "queued").limit(limit).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.distributions.values()].filter((d) => d.status === "queued").slice(0, limit);
}

// ── extract jobs (browser-backed listing scrapes) ──
// Same shape as distributions: doc-per-job, dot-path patches, single-field
// where so no composite index is needed.
async function saveExtractJob(j) {
  if (db) await db.collection("extract_jobs").doc(j.id).set(j);
  else mem.extractJobs.set(j.id, JSON.parse(JSON.stringify(j)));
}

async function getExtractJob(id) {
  if (db) { const d = await db.collection("extract_jobs").doc(id).get(); return d.exists ? d.data() : null; }
  return mem.extractJobs.get(id) || null;
}

async function updateExtractJob(id, patch) {
  if (db) { await db.collection("extract_jobs").doc(id).update(patch); return; }
  const j = mem.extractJobs.get(id);
  if (j) Object.assign(j, patch);
}

async function listExtractJobsByStatus(status, limit = 10) {
  if (db) {
    const snap = await db.collection("extract_jobs").where("status", "==", status).limit(limit).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.extractJobs.values()].filter((j) => j.status === status).slice(0, limit);
}

// ── listing drafts (Yad2/Madlan sweep results, awaiting the agent's review) ──
// Same shape as extract jobs: doc-per-draft, dot-path patches.
async function saveListingDraft(d) {
  if (db) await db.collection("listing_drafts").doc(d.id).set(d);
  else mem.listingDrafts.set(d.id, JSON.parse(JSON.stringify(d)));
}

async function getListingDraft(id) {
  if (db) { const d = await db.collection("listing_drafts").doc(id).get(); return d.exists ? d.data() : null; }
  return mem.listingDrafts.get(id) || null;
}

async function updateListingDraft(id, patch) {
  if (db) { await db.collection("listing_drafts").doc(id).update(patch); return; }
  const d = mem.listingDrafts.get(id);
  if (d) Object.assign(d, patch);
}

async function listListingDraftsByPhone(phone, limit = 50) {
  if (db) {
    const snap = await db.collection("listing_drafts").where("phone", "==", String(phone)).limit(limit).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.listingDrafts.values()].filter((d) => d.phone === String(phone)).slice(0, limit);
}

// ── distribution: curated group catalog ──
// Operator-maintained list of recommended Facebook groups shown in the
// dashboard. Agent suggestions land here with active:false until curated.
async function listGroupCatalog(limit = 200) {
  if (db) {
    const snap = await db.collection("group_catalog").limit(limit).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  return mem.groupCatalog.slice(0, limit);
}

async function addGroupCatalogEntry(doc) {
  const rec = { created_at: new Date(), ...doc };
  if (db) { const ref = await db.collection("group_catalog").add(rec); return ref.id; }
  mem.groupCatalog.push(rec);
  return String(mem.groupCatalog.length);
}

// ── distribution: per-property group selections ──
// Deliberately its own collection, NOT a field on property_pages: savePage()
// overwrites the whole page doc every time n8n rebuilds a page, which would
// silently wipe the agent's group choices. `city` is stored so a later
// property in the same city can offer to reuse the same groups.
async function getPropertyGroups(pageId) {
  if (db) {
    const d = await db.collection("property_groups").doc(pageId).get();
    return d.exists ? d.data() : null;
  }
  return mem.propertyGroups.get(pageId) || null;
}

async function savePropertyGroups(doc) {
  const rec = { ...doc, updated_at: new Date() };
  if (db) await db.collection("property_groups").doc(doc.page_id).set(rec, { merge: true });
  else mem.propertyGroups.set(doc.page_id, { ...(mem.propertyGroups.get(doc.page_id) || {}), ...rec });
  return rec;
}

async function listPropertyGroupsByPhone(phone, limit = 100) {
  if (db) {
    const snap = await db.collection("property_groups")
      .where("business_phone", "==", phone).limit(limit).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.propertyGroups.values()].filter((d) => d.business_phone === phone);
}

// ── distribution: group share sessions (the in-app sharing queue) ──
// One doc per (property × sharing run) holding the frozen copy and the
// per-group progress the agent confirms by hand. Forly never claims a group
// post it didn't see — every state here is agent-confirmed or a skip.
async function saveShareSession(s) {
  if (db) await db.collection("share_sessions").doc(s.id).set(s);
  else mem.shareSessions.set(s.id, JSON.parse(JSON.stringify(s)));
}

// Sessions written by the old `groups.<idx>.state` patch have groups as a
// map {"0": …} instead of an array — heal them on read so existing queues
// keep working instead of throwing on .map().
function healGroups(s) {
  if (!s || !s.groups || Array.isArray(s.groups)) return s;
  const groups = Object.keys(s.groups)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => s.groups[k]);
  return { ...s, groups };
}

async function getShareSession(id) {
  if (db) {
    const d = await db.collection("share_sessions").doc(id).get();
    return d.exists ? healGroups(d.data()) : null;
  }
  return healGroups(mem.shareSessions.get(id)) || null;
}

async function updateShareSession(id, patch) {
  if (db) { await db.collection("share_sessions").doc(id).update(patch); return; }
  const s = mem.shareSessions.get(id);
  if (!s) return;
  for (const [key, val] of Object.entries(patch)) {
    const parts = key.split(".");
    let o = s;
    while (parts.length > 1) { const k = parts.shift(); o[k] = o[k] || {}; o = o[k]; }
    o[parts[0]] = val;
  }
}

async function findOpenShareSession(pageId) {
  if (db) {
    const snap = await db.collection("share_sessions")
      .where("page_id", "==", pageId).limit(20).get();
    const docs = snap.docs.map((d) => d.data());
    return healGroups(docs.sort((a, b) => asMillis(b.created_at) - asMillis(a.created_at))[0]) || null;
  }
  return [...mem.shareSessions.values()]
    .filter((s) => s.page_id === pageId)
    .sort((a, b) => asMillis(b.created_at) - asMillis(a.created_at))[0] || null;
}

// Every session the agent owns, newest first. The dashboard needs group
// progress for the whole catalogue at once — one query beats findOpenShareSession
// per card, which is a read per property on every dashboard load.
async function listShareSessionsByPhone(phone, limit = 200) {
  const sort = (docs) => docs
    .sort((a, b) => asMillis(b.created_at) - asMillis(a.created_at))
    .map(healGroups);
  if (db) {
    const snap = await db.collection("share_sessions")
      .where("business_phone", "==", phone).limit(limit).get();
    return sort(snap.docs.map((d) => d.data()));
  }
  return sort([...mem.shareSessions.values()].filter((s) => s.business_phone === phone));
}

// ── distribution: append-only audit (spec §5 post_actions) ──
async function addPostAction(doc) {
  const rec = { at: new Date(), ...doc };
  if (db) await db.collection("post_actions").add(rec);
  else mem.postActions.push(rec);
}

// ── leads ──
async function getLead(phone) {
  if (db) { const d = await db.collection("leads").doc(phone).get(); return d.exists ? d.data() : null; }
  return mem.leads.get(phone) || null;
}

async function saveLead(phone, lead) {
  if (db) await db.collection("leads").doc(phone).set(lead, { merge: true });
  else mem.leads.set(phone, { ...(mem.leads.get(phone) || {}), ...lead });
}

async function addAdminMessage(entry) {
  if (db) await db.collection("admin_messages").add(entry);
  else mem.adminMessages.push(entry);
}

// Immutable, one doc per submission — a chat lead and a form lead from the same
// prospect must not collapse into one leads/{phone} summary and lose the first.
async function addLeadSubmission(doc) {
  if (db) await db.collection("lead_submissions").add(doc);
  else mem.leadSubmissions.push(doc);
}

// ── portfolio slug reservations ──
// ponytail: uses same shortCode alphabet for property slugs
async function getPortfolioSlugReservation(slug) {
  if (!db) return mem.portfolioSlugs?.get(slug) || null;
  const d = await db.collection("portfolio_slugs").doc(slug).get();
  return d.exists ? d.data() : null;
}

async function reservePortfolioSlug(phone, slug, oldSlug = null) {
  const now = new Date();
  if (!db) {
    mem.portfolioSlugs = mem.portfolioSlugs || new Map();
    const existing = mem.portfolioSlugs.get(slug);
    if (existing && existing.business_phone !== phone) throw new Error("slug_taken");
    mem.portfolioSlugs.set(slug, { business_phone: phone, current_slug: slug, created_at: now });
    if (oldSlug && oldSlug !== slug) {
      mem.portfolioSlugs.set(oldSlug, { business_phone: phone, current_slug: slug, created_at: now });
    }
    return;
  }
  await db.runTransaction(async (tx) => {
    const nextRef = db.collection("portfolio_slugs").doc(slug);
    const next = await tx.get(nextRef);
    if (next.exists && next.get("business_phone") !== phone) throw new Error("slug_taken");
    tx.set(nextRef, { business_phone: phone, current_slug: slug, created_at: now }, { merge: true });
    if (oldSlug && oldSlug !== slug) {
      tx.set(db.collection("portfolio_slugs").doc(oldSlug),
        { business_phone: phone, current_slug: slug, created_at: now }, { merge: true });
    }
  });
}

// List pages by business phone (for portfolio dashboard)
async function listPagesByPhone(phone, limit = 100) {
  if (db) {
    const snap = await db.collection("property_pages")
      .where("business_phone", "==", phone).limit(limit).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.pages.values()].filter((p) => p.business_phone === phone).slice(0, limit);
}

// ponytail: resolves one page by its public slug without reading the agent's
// whole catalogue. The slug is only unique within one business, so the phone
// filter is load-bearing, not an optimisation — dropping it would let one
// agent's slug resolve to another's page.
async function findPageBySlug(phone, publicSlug) {
  if (db) {
    const snap = await db.collection("property_pages")
      .where("business_phone", "==", phone)
      .where("public_slug", "==", publicSlug)
      .limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
  }
  return [...mem.pages.values()].find(
    (p) => p.business_phone === phone && p.public_slug === publicSlug
  ) || null;
}

// ── property drafts (WhatsApp chat intake, see whatsapp-intake.js) ──
// One doc per agent phone; saveDraft replaces the whole doc on purpose so a
// cleared field (skipped, pending_opener: null) never lingers from a merge.
async function getDraft(phone) {
  if (db) { const d = await db.collection("property_drafts").doc(phone).get(); return d.exists ? d.data() : null; }
  return mem.drafts.get(phone) || null;
}

async function saveDraft(draft) {
  if (db) await db.collection("property_drafts").doc(draft.phone).set(draft);
  else mem.drafts.set(draft.phone, draft);
}

async function deleteDraft(phone) {
  if (db) await db.collection("property_drafts").doc(phone).delete();
  else mem.drafts.delete(phone);
}

module.exports = {
  init,
  get db() { return db; },
  get mem() { return mem; },
  shortCode,
  saveListing, getListing, setListingPageId, updateListing, listListingsByPhone, listPendingListings, listAllListings,
  savePage, getPage, findActivePageByListing, listPublicPages, listPagesForExpiry, incrPageCounter, updatePage, uniquePageId, listAllPages, listPagesByPhone, findPageBySlug,
  getBusiness, setBusiness, listAllBusinesses,
  getLead, saveLead, addLeadSubmission, logPortalEvent,
  getPortfolioSlugReservation, reservePortfolioSlug,
  getConnection, setConnection, cancelOpenAttempts,
  getSetting, setSetting,
  savePendingDelete, listPendingDeletes, clearPendingDelete,
  saveDistribution, getDistribution, updateDistribution,
  listDistributionsByPage, listQueuedDistributions, addPostAction,
  listGroupCatalog, addGroupCatalogEntry,
  saveShareSession, getShareSession, updateShareSession, findOpenShareSession,
  listShareSessionsByPhone, healGroups, addAdminMessage,
  getPropertyGroups, savePropertyGroups, listPropertyGroupsByPhone,
  getDraft, saveDraft, deleteDraft,
  saveExtractJob, getExtractJob, updateExtractJob, listExtractJobsByStatus,
  saveListingDraft, getListingDraft, updateListingDraft, listListingDraftsByPhone,
};
