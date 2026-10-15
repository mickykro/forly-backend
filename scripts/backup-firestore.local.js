#!/usr/bin/env node
/*
 * Dump an entire Firestore database (every collection, every subcollection) to one JSON file.
 * Read-only. Timestamps/refs/bytes/geopoints are tagged ({__ts}, {__ref}, ...) so they can be restored as-is.
 *
 *   cd server && GOOGLE_APPLICATION_CREDENTIALS=<key> node ../scripts/backup-firestore.local.js <out.json>
 *
 * Uses the key's own project, never GOOGLE_CLOUD_PROJECT.
 */
const fs = require("fs");
const admin = require("../server/node_modules/firebase-admin");

const out = process.argv[2];
const key = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!out || !key) { console.error("usage: GOOGLE_APPLICATION_CREDENTIALS=<key> backup-firestore.local.js <out.json>"); process.exit(1); }
const projectId = JSON.parse(fs.readFileSync(key, "utf8")).project_id;
admin.initializeApp({ projectId });
const db = admin.firestore();
const { Timestamp, DocumentReference, GeoPoint } = admin.firestore;

function enc(v) {
  if (v instanceof Timestamp) return { __ts: [v.seconds, v.nanoseconds] };
  if (v instanceof DocumentReference) return { __ref: v.path };
  if (v instanceof GeoPoint) return { __geo: [v.latitude, v.longitude] };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { __bytes: Buffer.from(v).toString("base64") };
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]));
  return v;
}

const docs = {};
async function walk(cols) {
  for (const col of cols) {
    // listDocuments also returns "missing" parents that only hold subcollections
    for (const ref of await col.listDocuments()) {
      const snap = await ref.get();
      if (snap.exists) docs[ref.path] = enc(snap.data());
      await walk(await ref.listCollections());
    }
  }
}

(async () => {
  await walk(await db.listCollections());
  fs.writeFileSync(out, JSON.stringify({ project: projectId, at: new Date().toISOString(), docs }));
  console.log(`project ${projectId}: ${Object.keys(docs).length} docs -> ${out}`);
})().catch((e) => { console.error(e); process.exit(1); });
