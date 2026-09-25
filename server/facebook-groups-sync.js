/*
 * facebook-groups-sync.js — the groups this account is actually a member of.
 *
 * Read from the account's own "Your groups" page, stored on the connection,
 * refreshed weekly and on demand. The campaign API (Task 16) gates on this
 * list: Forly posts only where the agent already belongs, and only ever
 * SUGGESTS joining somewhere else — joining is the agent's act, in their own
 * browser (docs/distribution/DECISION-no-automation.md).
 *
 * Stable IDs (review R3 §7): a vanity slug alone is not an identity. When the
 * slug is all digits it IS the numeric group id (`id_verified: true`);
 * otherwise the provisional id is `slug:<slug>` until a first group-page
 * visit resolves the real numeric id (Task 18) via resolveGroupId(). No
 * MAX_GROUPS cap here — share-kit's cap is for the WhatsApp share kit, not
 * for how many groups this account belongs to.
 *
 * Privacy (R3 §8): the full "Your groups" list is read into memory, but a
 * name is only ever PERSISTED when the entry matches the curated catalog,
 * reads as real-estate, or was explicitly selected by the agent — every
 * other membership is stored as `{ group_id, name_hash }` only. Group names
 * and URLs never appear in a log line.
 *
 * [Unverified] GROUPS_URL and SELECTORS come from the Task 1 findings file.
 */
const crypto = require("crypto");
const driver = require("./driver-browser");
const { profileName } = require("./profile-name");
const postingGuard = require("./posting-guard");
const shareKit = require("./distribution/share-kit");

const GROUPS_URL = process.env.FB_GROUPS_PAGE || "https://www.facebook.com/groups/joins/";
const SELECTORS = { groupLink: 'a[href*="/groups/"][role="link"]' };
const STALE_MS = 7 * 86400000; // isStale(): a sync older than this is due for a refresh
const STALE_DROP_MS = 30 * 86400000; // mergeMembership(): a stale/left entry this old is forgotten

const REAL_ESTATE_RE = /דיר|נדל|להשכר|למכיר|apartment|rent|real estate|נכס/i;

const slugOf = (url) => (String(url).match(/\/groups\/([^/?#]+)/) || [])[1] || null;
const isNumeric = (slug) => /^\d+$/.test(String(slug || ""));
const groupIdOf = (slug) => (isNumeric(slug) ? slug : `slug:${slug}`);

// Reads the account's own "Your groups" page: scrolls it fully open, then
// canonicalises and dedups by slug. share-kit is called one URL at a time —
// never on the whole list, which would apply its MAX_GROUPS cap here.
async function syncMembership(page) {
  await page.goto(GROUPS_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 1200); await page.waitForTimeout(800); } // load the whole list
  const raw = await page.$$eval(SELECTORS.groupLink, (els) => els.map((a) => ({ href: a.href, text: (a.textContent || "").trim() })));
  const out = new Map();
  for (const { href, text } of raw) {
    const slug = slugOf(href);
    if (!slug || !text || out.has(slug)) continue;
    const url = shareKit.sanitizeGroups([href])[0] || `https://www.facebook.com/groups/${slug}`;
    out.set(slug, { url, slug, name: text.slice(0, 120) });
  }
  return [...out.values()];
}

function nameHash(name) {
  return crypto.createHmac("sha256", String(process.env.PROFILE_KEY || "dev")).update(String(name || "")).digest("hex").slice(0, 16);
}

// Which canonical URLs / numeric ids the curated catalog carries, so a
// membership that matches one keeps its name instead of being hashed.
function catalogMatchers(catalog) {
  const urls = new Set();
  const ids = new Set();
  for (const c of Array.isArray(catalog) ? catalog : []) {
    const canon = shareKit.sanitizeGroups([c && c.url])[0];
    if (!canon) continue;
    urls.add(canon);
    const slug = slugOf(canon);
    if (isNumeric(slug)) ids.add(slug);
  }
  return { urls, ids };
}

function shouldKeepName(entry, { catalogUrls, catalogIds, selected }) {
  if (catalogUrls.has(entry.canonical_url)) return true;
  if (entry.id_verified && catalogIds.has(entry.group_id)) return true;
  if (REAL_ESTATE_RE.test(entry.name || "")) return true;
  if (Array.isArray(selected) && selected.includes(entry.group_id)) return true;
  return false;
}

function ageMs(now, iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? now.getTime() - t : Infinity;
}

/*
 * Pure merge of a fresh scrape into the previously stored list (R3 §8).
 * Observed now -> "member", observed_at = last_confirmed_at = now. In
 * `prev` but not observed now -> "stale", `observed_at` left exactly as it
 * was (the last time it WAS seen); a stale (or "left", set elsewhere —
 * Task 18) entry whose `observed_at` is more than 30 days old is dropped.
 * The privacy decision is recomputed for every OBSERVED entry from the
 * current catalog/keyword list every time, never inherited from storage.
 */
function mergeMembership(prev, scraped, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const nowIso = now.toISOString();
  const selected = Array.isArray(opts.selected) ? opts.selected : [];
  const { urls: catalogUrls, ids: catalogIds } = catalogMatchers(opts.catalog);
  const prevList = Array.isArray(prev) ? prev : [];
  const prevMap = new Map(prevList.filter((e) => e && e.group_id).map((e) => [e.group_id, e]));

  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(scraped) ? scraped : []) {
    const slug = item && item.slug;
    if (!slug) continue;
    const group_id = groupIdOf(slug);
    if (seen.has(group_id)) continue; // dedup within one scrape, by group_id
    seen.add(group_id);
    const idVerified = isNumeric(slug);
    const built = { group_id, canonical_url: item.url, slug, name: item.name, id_verified: idVerified };
    const entry = {
      group_id,
      canonical_url: built.canonical_url,
      slug,
      membership_state: "member",
      observed_at: nowIso,
      last_confirmed_at: nowIso,
      id_verified: idVerified,
    };
    if (shouldKeepName(built, { catalogUrls, catalogIds, selected })) entry.name = built.name;
    else entry.name_hash = nameHash(built.name);
    out.push(entry);
  }

  for (const [group_id, prevEntry] of prevMap) {
    if (seen.has(group_id)) continue; // fresh data for this one already pushed above
    if (ageMs(now, prevEntry.observed_at) > STALE_DROP_MS) continue; // dropped
    out.push(prevEntry.membership_state === "left"
      ? Object.assign({}, prevEntry)
      : Object.assign({}, prevEntry, { membership_state: "stale" }));
  }
  return out;
}

function mergeResolvedEntries(a, b) {
  const newer = (x, y) => (new Date(x || 0).getTime() >= new Date(y || 0).getTime() ? x : y);
  const state = a.membership_state === "member" || b.membership_state === "member"
    ? "member"
    : (a.membership_state === "stale" || b.membership_state === "stale" ? "stale" : b.membership_state);
  const merged = {
    group_id: b.group_id,
    canonical_url: newer(a.last_confirmed_at, b.last_confirmed_at) === a.last_confirmed_at ? a.canonical_url : b.canonical_url,
    slug: b.slug,
    membership_state: state,
    observed_at: newer(a.observed_at, b.observed_at),
    last_confirmed_at: newer(a.last_confirmed_at, b.last_confirmed_at),
    id_verified: true,
  };
  const name = a.name || b.name;
  if (name) merged.name = name;
  else if (a.name_hash || b.name_hash) merged.name_hash = a.name_hash || b.name_hash;
  return merged;
}

// Task 18 resolves a vanity slug's real numeric id on the group's own page
// and rewrites the provisional `slug:<slug>` id here. If the numeric id is
// already in the list (seen separately, or resolved earlier), the two
// entries are merged rather than left as duplicates.
function resolveGroupId(conn, provisionalId, numericId) {
  const list = Array.isArray(conn && conn.facebook_groups_member) ? conn.facebook_groups_member : [];
  const provIdx = list.findIndex((e) => e && e.group_id === provisionalId);
  if (provIdx === -1) return list;
  const rewritten = Object.assign({}, list[provIdx], { group_id: numericId, id_verified: true });
  const existingIdx = list.findIndex((e, i) => i !== provIdx && e && e.group_id === numericId);
  if (existingIdx === -1) return list.map((e, i) => (i === provIdx ? rewritten : e));
  const merged = mergeResolvedEntries(list[existingIdx], rewritten);
  return list.filter((_, i) => i !== provIdx && i !== existingIdx).concat(merged);
}

// Its own session, on the agent's own persisted Facebook profile. Used by
// the weekly sweep (Task 16, at most one per account per sweep) and by the
// agent's own "רענון קבוצות" resync button (Task 19).
async function runSync({ phone }, deps = {}) {
  const withPage = deps.withPage || driver.withPage;
  const guard = deps.guard || postingGuard;
  const db = deps.db;
  await guard.assertAllowed({ phone, platform: "facebook", action: "session" }, deps);
  const conn = (await db.getConnection(phone)) || {};
  const gen = conn.facebook_profile_gen || 0;
  const pageDeps = Object.assign({}, deps, { phone, platform: "facebook", conn });
  const scraped = await withPage(
    { duration: 300, note: "forly-sync:groups", profile: { name: profileName("facebook", phone, gen), persist: true } },
    syncMembership,
    pageDeps,
  );
  const catalog = await db.listGroupCatalog(500);
  const merged = mergeMembership(conn.facebook_groups_member || [], scraped, { now: new Date(), catalog, selected: [] });
  await db.setConnection(phone, { facebook_groups_member: merged, facebook_groups_synced_at: new Date().toISOString() });
  return merged.length;
}

const isStale = (conn, now) => !conn.facebook_groups_synced_at || now.getTime() - new Date(conn.facebook_groups_synced_at).getTime() > STALE_MS;

module.exports = { syncMembership, mergeMembership, resolveGroupId, runSync, isStale, SELECTORS, GROUPS_URL };
