/*
 * db.js — Firestore (or in-memory fallback) storage helpers.
 * ponytail: single source for all collection access
 */

const { asMillis } = require("./utils");

let db = null;
let FieldValue = null;
const mem = { listings: new Map(), pages: new Map(), leads: new Map(), throttle: new Map(), otps: new Map(), baJobs: new Map() };

function init() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const admin = require("firebase-admin");
    admin.initializeApp();
    db = admin.firestore();
    FieldValue = admin.firestore.FieldValue;
    console.log("Firestore enabled (service account credentials found)");
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

// ── pages ──
async function savePage(p) {
  if (db) await db.collection("property_pages").doc(p.page_id).set(p);
  else mem.pages.set(p.page_id, p);
}

async function getPage(id) {
  if (db) { const d = await db.collection("property_pages").doc(id).get(); return d.exists ? d.data() : null; }
  return mem.pages.get(id) || null;
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

// ── leads ──
async function saveLead(phone, lead) {
  if (db) await db.collection("leads").doc(phone).set(lead, { merge: true });
  else mem.leads.set(phone, lead);
}

// ── before/after video jobs ──
async function saveBaJob(j) {
  if (db) await db.collection("ba_jobs").doc(j.job_id).set(j);
  else mem.baJobs.set(j.job_id, j);
}

async function getBaJob(id) {
  if (db) { const d = await db.collection("ba_jobs").doc(id).get(); return d.exists ? d.data() : null; }
  return mem.baJobs.get(id) || null;
}

// Partial update + refreshed updated_at. Returns the merged job so callers can
// keep acting on it without a second read.
async function updateBaJob(id, patch) {
  const full = Object.assign({}, patch, { updated_at: new Date() });
  if (db) await db.collection("ba_jobs").doc(id).set(full, { merge: true });
  else Object.assign(mem.baJobs.get(id) || {}, full);
  return getBaJob(id);
}

module.exports = {
  init,
  get db() { return db; },
  get mem() { return mem; },
  saveListing, getListing, setListingPageId, updateListing, listListingsByPhone,
  savePage, getPage, findActivePageByListing, listPagesForExpiry, incrPageCounter, updatePage, uniquePageId,
  getBusiness, setBusiness,
  saveLead,
  saveBaJob, getBaJob, updateBaJob,
};
