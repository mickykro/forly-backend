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
const dbLive = require("./db");
const shareKit = require("./distribution/share-kit");
const profileLock = require("./profile-lock");
const { SIGNAL_DISABLES, SIGNAL_PENALISES } = require("./posting-signals");

const GROUPS_URL = process.env.FB_GROUPS_PAGE || "https://www.facebook.com/groups/joins/";
const SELECTORS = { groupLink: 'a[href*="/groups/"][role="link"]' };
const STALE_MS = 7 * 86400000; // isStale(): a sync older than this is due for a refresh
const STALE_DROP_MS = 30 * 86400000; // mergeMembership(): a stale/left entry this old is forgotten

const REAL_ESTATE_RE = /דיר|נדל|להשכר|למכיר|apartment|rent|real estate|נכס/i;

// The link on "Your groups" also carries the group's last-activity line;
// only the first line is the name. The suffix is also cut when the two come
// glued (textContent has no line break).
const NAME_NOISE = /\s*(פעילות אחרונה|פעילות לאחרונה|Last active|You last visited|ביקרת לאחרונה).*$/is;
function groupName(text) {
  const first = String(text || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  return first.replace(NAME_NOISE, "").trim().slice(0, 120);
}

const slugOf = (url) => (String(url).match(/\/groups\/([^/?#]+)/) || [])[1] || null;
const isNumeric = (slug) => /^\d+$/.test(String(slug || ""));
const groupIdOf = (slug) => (isNumeric(slug) ? slug : `slug:${slug}`);

// Reads the account's own "Your groups" page: scrolls it fully open, then
// canonicalises and dedups by slug. share-kit is called one URL at a time —
// never on the whole list, which would apply its MAX_GROUPS cap here.
// opts.guard(action) (runSync): the kill switch before the navigation (R2).
// The page's own signal is read right after it loads (posting-driver-proof):
// anything but "ok" — a login wall, a checkpoint, an unreadable page —
// throws `sync_signal` with `.signal`, and nothing is scraped.
async function syncMembership(page, opts = {}) {
  if (typeof opts.guard === "function") await opts.guard("navigate");
  await page.goto(GROUPS_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  const signal = await require("./posting-driver-proof").readSignal(page, "");
  if (signal !== "ok") throw Object.assign(new Error("groups page not readable"), { code: "sync_signal", signal });
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 1200); await page.waitForTimeout(800); } // load the whole list
  const raw = await page.$$eval(SELECTORS.groupLink, (els) => els.map((a) => ({ href: a.href, text: (a.innerText || a.textContent || "").trim() })));
  const out = new Map();
  for (const { href, text } of raw) {
    const slug = slugOf(href);
    if (!slug || !text || out.has(slug)) continue;
    const url = shareKit.sanitizeGroups([href])[0] || `https://www.facebook.com/groups/${slug}`;
    const name = groupName(text);
    if (!name) continue;
    out.set(slug, { url, slug, name });
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
 * `opts.hidden` (hiddenIds(conn)): groups the agent removed from the list
 * (DELETE /api/posting/groups/:id) — never re-added, observed or carried.
 */
function mergeMembership(prev, scraped, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const hidden = opts.hidden instanceof Set ? opts.hidden : new Set((Array.isArray(opts.hidden) ? opts.hidden : []).map(String));
  const nowIso = now.toISOString();
  const selected = Array.isArray(opts.selected) ? opts.selected : [];
  const { urls: catalogUrls, ids: catalogIds } = catalogMatchers(opts.catalog);
  const prevList = Array.isArray(prev) ? prev : [];
  const prevMap = new Map(prevList.filter((e) => e && e.group_id).map((e) => [e.group_id, e]));
  // A vanity slug already resolved to its numeric id (Task 18) stays that
  // entry when the scrape sees the slug again: one group, one entry.
  const aliasTo = new Map();
  for (const e of prevList) for (const a of (e && Array.isArray(e.aliases) ? e.aliases : [])) aliasTo.set(String(a), e.group_id);

  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(scraped) ? scraped : []) {
    const slug = item && item.slug;
    if (!slug) continue;
    const group_id = aliasTo.get(groupIdOf(slug)) || groupIdOf(slug);
    if (hidden.has(groupIdOf(slug)) || hidden.has(group_id)) continue; // the agent removed it
    if (seen.has(group_id)) continue; // dedup within one scrape, by group_id
    seen.add(group_id);
    const idVerified = isNumeric(group_id);
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
    const prevAliases = (prevMap.get(group_id) || {}).aliases;
    if (Array.isArray(prevAliases) && prevAliases.length) entry.aliases = prevAliases.slice();
    if (shouldKeepName(built, { catalogUrls, catalogIds, selected })) entry.name = built.name;
    else entry.name_hash = nameHash(built.name);
    out.push(entry);
  }

  for (const [group_id, prevEntry] of prevMap) {
    if (seen.has(group_id)) continue; // fresh data for this one already pushed above
    if ([group_id, ...(prevEntry.aliases || [])].some((id) => hidden.has(String(id)))) continue;
    if (ageMs(now, prevEntry.observed_at) > STALE_DROP_MS) continue; // dropped
    const carried = prevEntry.membership_state === "left"
      ? Object.assign({}, prevEntry)
      : Object.assign({}, prevEntry, { membership_state: "stale" });
    // Privacy is re-gated on EVERY merge, not only when an entry is first
    // observed: an entry kept in the clear earlier (a catalog match, or an
    // agent selection) can stop qualifying — removed from the catalog, or
    // deselected — while the row itself is simply carried forward here.
    // A hash-only entry has nothing left to leak and no way back to a name
    // from its hash, so there is nothing to re-gate for it.
    if (carried.name && !shouldKeepName(carried, { catalogUrls, catalogIds, selected })) {
      carried.name_hash = nameHash(carried.name);
      delete carried.name;
    }
    out.push(carried);
  }
  return out;
}

// "left" is positive evidence (the agent's own browser showed "Join group");
// "stale" is only the absence of evidence (we simply didn't see it in the
// last scrape). So left beats stale, and left beats a member entry too
// UNLESS that member sighting is more recent than the left determination —
// a re-join after leaving is real and should win once it's the newer fact.
function resolveMergedState(a, b) {
  const memberEntry = a.membership_state === "member" ? a : (b.membership_state === "member" ? b : null);
  const leftEntry = a.membership_state === "left" ? a : (b.membership_state === "left" ? b : null);
  if (memberEntry && leftEntry) {
    const memberAt = new Date(memberEntry.last_confirmed_at || 0).getTime();
    const leftAt = Math.max(new Date(leftEntry.observed_at || 0).getTime(), new Date(leftEntry.last_confirmed_at || 0).getTime());
    return memberAt > leftAt ? "member" : "left";
  }
  if (memberEntry) return "member"; // member vs. stale
  if (leftEntry) return "left"; // left vs. stale, or left vs. left
  return "stale"; // stale vs. stale, or any other combination
}

function mergeResolvedEntries(a, b) {
  const newer = (x, y) => (new Date(x || 0).getTime() >= new Date(y || 0).getTime() ? x : y);
  const state = resolveMergedState(a, b);
  const merged = {
    group_id: b.group_id,
    canonical_url: newer(a.last_confirmed_at, b.last_confirmed_at) === a.last_confirmed_at ? a.canonical_url : b.canonical_url,
    slug: b.slug,
    membership_state: state,
    observed_at: newer(a.observed_at, b.observed_at),
    last_confirmed_at: newer(a.last_confirmed_at, b.last_confirmed_at),
    id_verified: true,
  };
  const aliases = [...new Set([...(a.aliases || []), ...(b.aliases || []), a.group_id, b.group_id])].filter((id) => id && id !== merged.group_id);
  if (aliases.length) merged.aliases = aliases;
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
  // The provisional id stays an alias: history recorded under it (attempts,
  // group buckets, dedup) still belongs to this group.
  const aliases = [...new Set([...(list[provIdx].aliases || []), provisionalId])].filter((id) => id !== numericId);
  const rewritten = Object.assign({}, list[provIdx], { group_id: numericId, id_verified: true, aliases });
  const existingIdx = list.findIndex((e, i) => i !== provIdx && e && e.group_id === numericId);
  if (existingIdx === -1) return list.map((e, i) => (i === provIdx ? rewritten : e));
  const merged = mergeResolvedEntries(list[existingIdx], rewritten);
  return list.filter((_, i) => i !== provIdx && i !== existingIdx).concat(merged);
}

// A scrape that is not evidence (I3): nothing read at all, or under half of
// the members known before when there were at least 5. Stale-marking a
// whole list on a slow render would take every group out of every campaign.
// → null when the scrape may be merged, else "empty" | "shrunk".
const SHRINK_MIN_KNOWN = 5;
function scrapeAnomaly(prev, scraped) {
  const n = Array.isArray(scraped) ? scraped.length : 0;
  if (!n) return "empty";
  const known = (Array.isArray(prev) ? prev : []).filter((e) => e && e.membership_state === "member").length;
  return known >= SHRINK_MIN_KNOWN && n < known * 0.5 ? "shrunk" : null;
}

// settings/posting_health.sync_anomalies[kind] += 1 (the admin overview). Never throws.
async function noteAnomaly(db, kind) {
  try {
    const prev = (await db.getSetting("posting_health")) || {};
    const cur = Object.assign({}, prev.sync_anomalies || {});
    cur[kind] = (cur[kind] || 0) + 1;
    await db.setSetting("posting_health", { sync_anomalies: cur, sync_last_anomaly_at: new Date().toISOString() });
  } catch (e) { console.error(driver.redact(`groups sync anomaly note failed: ${(e && e.code) || "error"}`)); }
}
const HALTING = new Set([...SIGNAL_DISABLES, ...SIGNAL_PENALISES, "login_required"]);

// Its own session, on the agent's own persisted Facebook profile. Used by
// the weekly sweep (Task 16, at most one per account per sweep) and by the
// agent's own "רענון קבוצות" resync button (Task 19). Never while the agent's
// login browser is open (profile_busy). A halting signal on the groups page
// halts the account (R5) and writes nothing; an empty or collapsed scrape
// writes nothing either — both are counted in posting_health and thrown.
async function runSync({ phone }, deps = {}) {
  const withPage = deps.withPage || driver.withPage;
  const guard = deps.guard || postingGuard;
  const db = deps.db || dbLive;
  await guard.assertAllowed({ phone, platform: "facebook", action: "session" }, deps);
  const conn = (await db.getConnection(phone)) || {};
  if (profileLock.loginOpen(conn, "facebook")) throw Object.assign(new Error("login browser open"), { code: "profile_busy" });
  const gen = conn.facebook_profile_gen || 0;
  const pageDeps = Object.assign({}, deps, { phone, platform: "facebook", conn });
  const navGuard = (action) => guard.assertAllowed({ phone, platform: "facebook", action }, deps);
  let scraped;
  try {
    scraped = await withPage(
      { duration: 300, note: "forly-sync:groups", profile: { name: profileName("facebook", phone, gen), persist: true } },
      (page) => syncMembership(page, { guard: navGuard }),
      pageDeps,
    );
  } catch (e) {
    if (!e || e.code !== "sync_signal") throw e;
    await noteAnomaly(db, "signal");
    if (HALTING.has(e.signal)) await (deps.haltAccount || require("./posting-halts").haltAccount)(phone, e.signal, deps);
    throw e;
  }
  const catalog = await db.listGroupCatalog(500);
  // Re-read after the scrape (minutes): a group removed meanwhile stays removed.
  const fresh = (await db.getConnection(phone)) || {};
  const anomaly = scrapeAnomaly(fresh.facebook_groups_member, scraped);
  if (anomaly) {
    await noteAnomaly(db, anomaly);
    throw Object.assign(new Error("groups scrape not trusted"), { code: "sync_anomaly", anomaly });
  }
  const merged = mergeMembership(fresh.facebook_groups_member || [], scraped, { now: new Date(), catalog, selected: [], hidden: hiddenIds(fresh) });
  await db.setConnection(phone, { facebook_groups_member: merged, facebook_groups_synced_at: new Date().toISOString() });
  return merged.length;
}

// Every id the agent removed from their list: facebook_groups_hidden holds
// { ids: [group_id, ...aliases], hidden_at } entries — ids only, never names.
function hiddenIds(conn) {
  const out = new Set();
  for (const h of Array.isArray(conn && conn.facebook_groups_hidden) ? conn.facebook_groups_hidden : []) {
    for (const id of (h && Array.isArray(h.ids) ? h.ids : [])) if (id) out.add(String(id));
  }
  return out;
}

const isStale = (conn, now) => !conn.facebook_groups_synced_at || now.getTime() - new Date(conn.facebook_groups_synced_at).getTime() > STALE_MS;

module.exports = { groupName, syncMembership, mergeMembership, resolveGroupId, runSync, isStale, hiddenIds, scrapeAnomaly, SELECTORS, GROUPS_URL };
