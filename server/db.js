/*
 * db.js — Firestore (or in-memory fallback) storage helpers.
 * ponytail: single source for all collection access
 */

let db = null;
let FieldValue = null;
const mem = { listings: new Map(), pages: new Map(), leads: new Map(), throttle: new Map(), otps: new Map() };

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

module.exports = {
  init,
  get db() { return db; },
  get mem() { return mem; },
  saveListing, getListing, setListingPageId, listListingsByPhone,
  savePage, getPage, findActivePageByListing, incrPageCounter, updatePage,
  getBusiness, setBusiness,
  saveLead,
};
