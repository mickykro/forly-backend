#!/usr/bin/env node
/*
 * Dev DB was seeded with every prod user. Delete all users except one.
 * A user = a businesses/{phone} doc (with its subcollections) + its uids/{uid} row.
 *
 *   cd server && GOOGLE_APPLICATION_CREDENTIALS=<dev key> node ../scripts/prune-dev-users.local.js --keep 9725XXXXXXXX[,9725YYYYYYYY]
 *   ...same... --apply        # actually delete (default is a dry run)
 *
 * Refuses to run unless the credentials' project id contains "dev".
 */
process.chdir(require("path").join(__dirname, "..", "server"));
const admin = require("../server/node_modules/firebase-admin");

const args = process.argv.slice(2);
const keep = (args[args.indexOf("--keep") + 1] || "").split(",").filter(Boolean);
const apply = args.includes("--apply");
if (!args.includes("--keep") || !keep.length) { console.error("usage: --keep <phone>[,<phone>...] [--apply]"); process.exit(1); }

const key = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!key) { console.error("GOOGLE_APPLICATION_CREDENTIALS not set"); process.exit(1); }
const projectId = JSON.parse(require("fs").readFileSync(key, "utf8")).project_id || "";
if (!/dev/i.test(projectId)) { console.error(`refusing: project "${projectId}" is not a dev project`); process.exit(1); }

admin.initializeApp({ projectId }); // pin to the key's project: GOOGLE_CLOUD_PROJECT would otherwise win
const db = admin.firestore();

(async () => {
  const businesses = await db.collection("businesses").get();
  const missing = keep.filter((k) => !businesses.docs.some((d) => d.id === k));
  if (missing.length) { console.error(`refusing: businesses/${missing} not found`); process.exit(1); }
  const doomed = businesses.docs.filter((d) => !keep.includes(d.id));
  const uids = (await db.collection("uids").get()).docs.filter((d) => !keep.includes(d.get("phone")));

  console.log(`project ${projectId}: keep ${keep}; delete ${doomed.length} businesses, ${uids.length} uids`);
  if (!apply) { console.log("dry run — add --apply to delete"); return; }

  for (const d of doomed) await db.recursiveDelete(d.ref);
  const w = db.bulkWriter();
  uids.forEach((d) => w.delete(d.ref));
  await w.close();
  console.log("done");
})().catch((e) => { console.error(e); process.exit(1); });
