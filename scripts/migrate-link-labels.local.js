#!/usr/bin/env node
/*
 * One-off (4 Oct 2026): the post link used to be labelled as the video
 * ("סרטון מהדירה->…"); it leads to the property page, so share-kit now says
 * "details". This rewrites the approved texts already stored on campaigns
 * that are still running or paused: campaign.groups[].copy (what the admin
 * types in manual posting) and the copy of posts that have not gone out yet
 * (scheduled / pending_approval — with its copy_hash, the posting check's
 * fingerprint). Only the label in front of "->" (and the old first-comment
 * lines) changes; anything the agent edited stays as is. Posts posting or
 * posted are never touched.
 *
 *   node scripts/migrate-link-labels.local.js            # dry run: what would change
 *   node scripts/migrate-link-labels.local.js --apply    # write it
 */
const path = require("path");
const fs = require("fs");
const assert = require("assert");
const crypto = require("crypto");
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 32); // posting-campaign's
const OPEN = new Set(["scheduled", "pending_approval"]);
const SERVER = path.join(__dirname, "..", "server");
process.chdir(SERVER);

// server/.env, the way index.js loads it.
for (const line of fs.existsSync(".env") ? fs.readFileSync(".env", "utf8").split("\n") : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

// Old label → new label (as in share-kit's TEMPLATES, same order).
const LABELS = [
  ["רוצים לראות לפני ביקור? יש סרטון מהדירה", "רוצים לדעת עוד לפני ביקור? כל הפרטים כאן"],
  ["אפשר לראות את הדירה בסרטון", "כל המידע על הדירה כאן"],
  ["מה דעתכם? הסרטון כאן", "מה דעתכם? כל הפרטים כאן"],
  ["כל הפרטים+סרטון", "כל הפרטים על הדירה"],
  ["לפרטים וסרטון", "לפרטים נוספים על הנכס"],
  ["לצפייה בסרטון", "לפרטים נוספים"],
  ["הסרטון מהדירה", "כל הפרטים והתמונות"],
  ["סרטון מהדירה", "כל הפרטים על הנכס"], // templates 1 and 2 shared it; one new label for both
  ["סרטון", "פרטים מלאים"],
];
const LINES = [
  ["הקישור לסרטון ולפרטים בתגובה הראשונה 👇", "הקישור לפרטים המלאים בתגובה הראשונה 👇"],
  ["התמונות והסרטון בתגובה הראשונה 👇", "כל הפרטים והתמונות בתגובה הראשונה 👇"],
  ["הוספתי קישור עם הסרטון בתגובה הראשונה 👇", "הוספתי קישור עם כל הפרטים בתגובה הראשונה 👇"],
];

// Line by line: a line that IS an old label followed by "->", or IS an old CTA line.
function relabel(text) {
  if (typeof text !== "string") return text;
  return text.split("\n").map((line) => {
    for (const [from, to] of LABELS) if (line.startsWith(`${from}->`)) return to + line.slice(from.length);
    for (const [from, to] of LINES) if (line.trim() === from) return to;
    return line;
  }).join("\n");
}

// The check: labels in front of the link change, the same words elsewhere do not.
assert.equal(relabel("דירה\nסרטון מהדירה->https://f.ly/p/1\nדני"), "דירה\nכל הפרטים על הנכס->https://f.ly/p/1\nדני");
assert.equal(relabel("סרטון->https://f.ly/p/1"), "פרטים מלאים->https://f.ly/p/1");
assert.equal(relabel("רוצים לראות לפני ביקור? יש סרטון מהדירה->https://f.ly/p/1"), "רוצים לדעת עוד לפני ביקור? כל הפרטים כאן->https://f.ly/p/1");
assert.equal(relabel("יש סרטון מהדירה בתגובה"), "יש סרטון מהדירה בתגובה", "the agent's own words stay");
assert.equal(relabel("התמונות והסרטון בתגובה הראשונה 👇"), "כל הפרטים והתמונות בתגובה הראשונה 👇");

(async () => {
  const apply = process.argv.includes("--apply");
  const db = require(path.join(SERVER, "db"));
  db.init();
  if (!db.db) { console.error("no Firestore (GOOGLE_APPLICATION_CREDENTIALS) — nothing checked"); process.exit(1); }
  const store = require(path.join(SERVER, "posting-store"));
  const A = require(path.join(SERVER, "posting-account"));
  const x = A.ctxOf({});

  let campaigns = 0, texts = 0, shown = 0;
  for (const status of ["running", "paused"]) {
    for (const c of await store.listPostingCampaignsByStatus(status, 1000)) {
      const stale = (o) => o && typeof o.copy === "string" && relabel(o.copy) !== o.copy;
      const changed = (c.groups || []).filter(stale).concat((c.posts || []).filter((p) => stale(p) && OPEN.has(p.status)));
      if (!changed.length) continue;
      campaigns++; texts += changed.length;
      if (shown < 3) {
        shown++;
        const g = changed[0];
        console.log(`\n── ${c.id.slice(0, 8)}… (${status}), ${changed.length} text(s). Before / after:\n${g.copy}\n──\n${relabel(g.copy)}`);
      }
      if (apply) {
        await A.mutate(x, c.id, (cur) => (cur ? {
          groups: (cur.groups || []).map((g) => (stale(g) ? { ...g, copy: relabel(g.copy) } : g)),
          // Re-read inside the transaction: a post that started meanwhile is left alone.
          posts: (cur.posts || []).map((p) => (stale(p) && OPEN.has(p.status) ? { ...p, copy: relabel(p.copy), copy_hash: sha(relabel(p.copy)) } : p)),
        } : null));
      }
    }
  }
  console.log(`\n${apply ? "updated" : "would update"} ${texts} text(s) in ${campaigns} campaign(s)${apply ? "" : " — run with --apply to write"}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
