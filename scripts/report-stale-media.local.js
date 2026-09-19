#!/usr/bin/env node
/*
 * Which stored media URLs point at a host that no longer exists?
 *
 * Media URLs are absolute and are written into Firestore at creation time, so a
 * page built while BASE_URL was a throwaway tunnel (*.trycloudflare.com) kept
 * that hostname forever. The tunnel died; the rows did not. This counts them.
 *
 * It never writes anything — read-only. No doc.ref is taken, so it cannot.
 *
 *   cd server && GOOGLE_APPLICATION_CREDENTIALS=... node ../scripts/report-stale-media.local.js [--samples N]
 *
 * Exits non-zero if it could not reach a real database, so a credential-less
 * run cannot be mistaken for a clean one.
 */
process.chdir(require("path").join(__dirname, "..", "server"));

const db = require("../server/db");
const { INFRA_HOST } = require("../server/utils");

const line = (s) => console.log(s);
const rule = (s) => line(`\n══ ${s} ${"═".repeat(Math.max(0, 62 - s.length))}`);

const argN = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const SAMPLES = argN("--samples", 3);
// Matches the hard caps inside db.js's listAll* helpers, which have no cursor.
const LIST_CAP = 1000;
const RAW_CAP = 5000;

// A URL is suspect when its host is one we know to be ephemeral or non-public
// infrastructure. Reuses the very regex index.js uses to keep such hosts out of
// buyer-visible links, so the report and the guard can never drift apart.
const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };
const isStale = (v) => typeof v === "string" && /^https?:\/\//.test(v) && INFRA_HOST.test(v);

// Pull every string at a dotted path, descending into arrays on the way.
function pluck(doc, dotted) {
  let cur = [doc];
  for (const key of dotted.split(".")) {
    const next = [];
    for (const node of cur) {
      if (node == null) continue;
      const v = Array.isArray(node) ? node.map((x) => x && x[key]) : [node[key]];
      for (const x of v) {
        if (Array.isArray(x)) next.push(...x); else if (x != null) next.push(x);
      }
    }
    cur = next;
  }
  return cur.filter((x) => typeof x === "string");
}

const FIELDS = {
  listings: ["photos_urls", "own_video_url", "agent.logo_url"],
  property_pages: ["hero.video_url", "hero.poster_url", "gallery.images.url",
    "area.map_image_url", "agent.logo_url", "theme.font_url"],
  businesses: ["logo_url", "portfolio.hero.portrait_url", "portfolio.theme.font_url",
    "onboarding_partial.logo_url", "onboarding_partial.portrait_url"],
  distributions: ["snapshot.video_url", "snapshot.poster_url", "snapshot.photo_urls"],
  post_actions: ["content.media_urls"],
};

function scan(name, docs, idOf) {
  const byHost = new Map();
  let affected = 0;
  for (const d of docs) {
    let hit = false;
    for (const f of FIELDS[name]) {
      for (const url of pluck(d, f)) {
        if (!isStale(url)) continue;
        hit = true;
        const h = hostOf(url) || "unparseable";
        if (!byHost.has(h)) byHost.set(h, { count: 0, fields: new Set(), ids: [] });
        const e = byHost.get(h);
        e.count++;
        e.fields.add(f);
        if (e.ids.length < SAMPLES) e.ids.push(idOf(d));
      }
    }
    if (hit) affected++;
  }
  return { byHost, affected, scanned: docs.length };
}

function report(name, res, cap) {
  rule(name);
  const truncated = res.scanned >= cap;
  line(`  scanned ${res.scanned} docs${truncated ? `  ⚠ TRUNCATED at the ${cap} cap — every count below is a FLOOR` : ""}`);
  if (!res.byHost.size) { line("  ✓ no stale media hosts"); return { affected: 0, truncated }; }
  line(`  ✗ ${res.affected} docs carry a stale host`);
  for (const [host, e] of [...res.byHost].sort((a, b) => b[1].count - a[1].count)) {
    line(`     ${host}  —  ${e.count} urls in ${[...e.fields].join(", ")}`);
    line(`       e.g. ${e.ids.join(", ")}`);
  }
  return { affected: res.affected, truncated };
}

(async () => {
  db.init();
  line("stale media report — read-only");
  line(`firestore: ${db.db ? "connected" : "IN-MEMORY (no GOOGLE_APPLICATION_CREDENTIALS — nothing persisted)"}`);
  if (!db.db) {
    line("");
    line("✗ Refusing to report against the in-memory fallback: every collection");
    line("  would read as empty and the database would look clean. Set");
    line("  GOOGLE_APPLICATION_CREDENTIALS and re-run.");
    process.exit(2);
  }

  // Collections with a list helper; those without are queried directly, the
  // way server/scripts/backfill-portfolios.js does.
  const rawList = async (coll) => {
    const snap = await db.db.collection(coll).limit(RAW_CAP).get();
    return snap.docs.map((d) => ({ ...d.data(), __id: d.id }));
  };

  const [listings, pages, businesses, distributions, postActions] = await Promise.all([
    db.listAllListings(LIST_CAP).catch(() => []),
    db.listAllPages(LIST_CAP).catch(() => []),
    db.listAllBusinesses(LIST_CAP).catch(() => []),
    rawList("distributions").catch(() => []),
    rawList("post_actions").catch(() => []),
  ]);

  const totals = [
    report("listings", scan("listings", listings, (d) => d.listing_id || d.__id || "?"), LIST_CAP),
    report("property_pages", scan("property_pages", pages, (d) => d.page_id || d.__id || "?"), LIST_CAP),
    report("businesses", scan("businesses", businesses, (d) => d.phone || d.__id || "?"), LIST_CAP),
    report("distributions", scan("distributions", distributions, (d) => d.__id || "?"), RAW_CAP),
    report("post_actions", scan("post_actions", postActions, (d) => d.__id || "?"), RAW_CAP),
  ];

  const affected = totals.reduce((n, t) => n + t.affected, 0);
  const truncated = totals.some((t) => t.truncated);

  rule("summary");
  line(`  ${affected} documents carry at least one stale media URL${truncated ? " (FLOOR — a collection hit its cap)" : ""}`);
  line("");
  line("  Reading these numbers:");
  line("  • distributions and post_actions are SNAPSHOT COPIES. A stale URL there");
  line("    was copied from a page at share time and is independent of the page's");
  line("    current value — fixing the page does not fix the snapshot.");
  line("  • property_pages rows may still distribute FINE despite counting here:");
  line("    publicMedia() in server/distribution/jobs.js re-points any /files/ URL");
  line("    at the live media host on the way out. The stored value stays stale.");
  line("  • A stale host in listings.photos_urls is the costly one. createPropertyPage");
  line("    falls back to photos[0].url for the poster (server/routes/pages.js), so a");
  line("    dead host there makes page creation FAIL, not merely render badly.");
  line("");
  line("  Nothing was modified.");
})().catch((e) => { console.error("report failed:", e); process.exit(1); });
