/*
 * posting-listing-groups.js — the agent chooses a property's Facebook groups
 * while its page is still being built (create.html's building screen, or the
 * WhatsApp link / "ברירת מחדל" reply after "ליצור").
 *
 * The choice rides on the listing (posting_groups: "default" | [group ids])
 * until the page exists; createPropertyPage then applies it:
 *   "default" → the account's default groups that suit the property
 *               (A.defaultGroupIds), texts generated, no review;
 *   [ids]     → a campaign on exactly those groups, held (awaiting_texts)
 *               until the agent approves each group's text.
 * A choice made after the page exists is applied at once.
 * Only for an agent whose Facebook browser is connected.
 */
const A = require("./posting-account");
const C = require("./posting-campaign");

const DEFAULT = "default";
const MAX_GROUPS = 40;
const LIVE = new Set(["running", "paused"]);

const connected = (conn) => !!(conn && conn.facebook_browser_connected_at);
const memberMap = (conn) => new Map(((conn && conn.facebook_groups_member) || [])
  .filter((g) => g && g.membership_state === "member").map((g) => [String(g.group_id), g]));
// The account's default groups (what "ברירת מחדל" means): the one list, A.defaultGroupIds.
const defaultIds = (conn, biz) => A.defaultGroupIds(conn, biz);
const offerOf = (conn, biz) => ({ connected: connected(conn), defaults: connected(conn) ? defaultIds(conn, biz).length : 0 });
const businessOf = (x, phone) => (typeof x.db.getBusiness === "function" ? x.db.getBusiness(String(phone)).catch(() => null) : null);

const campaignOf = (x, phone, pageId) => x.store.getPostingCampaign(x.store.campaignId(phone, pageId)).catch(() => null);

// The choice on a page that exists. → the campaign, or null.
async function apply(page, listing, deps = {}) {
  const choice = listing && listing.posting_groups;
  if (!choice || !page || !page.page_id) return null;
  const x = A.ctxOf(deps);
  const phone = String(page.business_phone);
  const conn = (await x.db.getConnection(phone)) || {};
  if (!connected(conn)) return null;
  const member = memberMap(conn);
  // "default": the default groups that suit this property (its city, its deal).
  let ids = choice === DEFAULT ? defaultIds(conn, await businessOf(x, phone)) : choice.map(String);
  if (choice === DEFAULT) {
    const catalog = await A.catalogIndex(x.db);
    ids = ids.filter((id) => member.has(id) && A.fitsProperty(member.get(id),
      A.catalogEntriesFor(catalog, { group_id: id, aliases: member.get(id).aliases, url: member.get(id).canonical_url || member.get(id).url }, conn), page.property));
  }
  const groups = ids.filter((id) => member.has(id))
    .map((id) => ({ group_id: id, url: member.get(id).canonical_url || member.get(id).url, name: member.get(id).name || "" }));
  if (!groups.length) return null;
  const cur = await campaignOf(x, phone, page.page_id);
  let c;
  if (cur && LIVE.has(cur.status)) c = await C.addGroups(cur.id, groups, deps);
  else {
    const perm = conn.posting_permission || {};
    const consent = listing.posting_consent || { at: perm.granted_at, version: perm.consent_version };
    c = await C.create({ phone, page, groups, mode: perm.auto_mode === "per_post" ? "per_post" : "standing", days: 30, repeat: false, targets: ["groups"], consent }, deps,
      { restartWhen: () => true });
  }
  if (!c || choice === DEFAULT) return c; // default groups: generated texts, no review
  // Held until the agent approves each group's text (approveTexts).
  return A.mutate(x, c.id, (cur) => (cur.awaiting_texts ? null : { awaiting_texts: true }));
}

// The agent's choice: "default" or a list of group ids. → { ok } or { error }.
async function choose({ listing, phone, choice, consentVersion }, deps = {}) {
  const x = A.ctxOf(deps);
  if (!listing || String(listing.business_phone) !== String(phone)) return { error: "not_found" };
  const conn = (await x.db.getConnection(phone)) || {};
  if (!connected(conn)) return { error: "facebook_not_connected" };
  let value;
  if (choice === DEFAULT) {
    if (!defaultIds(conn, await businessOf(x, phone)).length) return { error: "no_defaults" };
    value = DEFAULT;
  } else {
    const ids = [...new Set((Array.isArray(choice) ? choice : []).map(String))];
    const member = memberMap(conn);
    if (!ids.length || ids.length > MAX_GROUPS || ids.some((id) => !member.has(id))) return { error: "invalid_groups" };
    value = ids;
  }
  const patch = { posting_groups: value, posting_consent: { at: A.iso(x.clock()), version: consentVersion || null } };
  await x.db.updateListing(listing.listing_id, patch);
  if (listing.page_id) {
    const page = await x.db.getPage(listing.page_id);
    if (page) await apply(page, Object.assign({}, listing, patch), deps);
  }
  return { ok: true, choice: value };
}

// Each chosen group's text, once the page exists. → { awaiting, groups } or null.
async function review(listing, deps = {}) {
  if (!listing || !listing.page_id) return null;
  const x = A.ctxOf(deps);
  const page = await x.db.getPage(listing.page_id);
  const c = page && (await campaignOf(x, String(listing.business_phone), page.page_id));
  if (!c) return null;
  return {
    awaiting: c.awaiting_texts === true,
    groups: (c.groups || []).map((g) => ({
      group_id: String(g.group_id), name: g.name || "",
      copy: g.copy || C.buildCopy(page, c, { ...g, target: "group" }, "property", deps.pageBaseUrl || ""),
    })),
  };
}

// The agent approves the texts ({ group_id: text }): stored per group, and the
// campaign is released. → the campaign, or null.
async function approveTexts(listing, copies, deps = {}) {
  if (!listing || !listing.page_id || !copies || typeof copies !== "object") return null;
  const x = A.ctxOf(deps);
  const c = await campaignOf(x, String(listing.business_phone), listing.page_id);
  if (!c) return null;
  return A.mutate(x, c.id, (cur) => ({
    awaiting_texts: false,
    groups: (cur.groups || []).map((g) => {
      const t = typeof copies[g.group_id] === "string" ? C.cleanCopy(copies[g.group_id]) : "";
      return t ? { ...g, copy: t } : g;
    }),
  }));
}

// "ברירת מחדל" on WhatsApp after the page is built (the chat draft is gone by
// then): the agent's newest listing of the last day that has no campaign yet.
async function latestUnchosen(phone, deps = {}, maxAgeMs = 24 * 3600 * 1000) {
  const x = A.ctxOf(deps);
  const now = x.clock().getTime();
  const fresh = (await x.db.listListingsByPhone(String(phone)))
    .filter((l) => l && !l.posting_groups && now - Date.parse(l.created_at || 0) < maxAgeMs)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  for (const l of fresh) {
    if (!l.page_id || !(await campaignOf(x, String(phone), l.page_id))) return l;
  }
  return null;
}

// The link the WhatsApp messages carry: a "groups"-scoped sign-in (it opens
// only the group picker, never the rest of the account) to groups.html.
const LINK_TTL_S = 7 * 24 * 3600;
function link(baseUrl, authSecret, phone, listingId) {
  const t = require("./auth").signSession(authSecret, String(phone), { scope: "groups", ttlS: LINK_TTL_S });
  return `${String(baseUrl || "").replace(/\/+$/, "")}/api/posting/groups-link?t=${encodeURIComponent(t)}&l=${encodeURIComponent(listingId)}`;
}

module.exports = { DEFAULT, LINK_TTL_S, link, businessOf, connected, defaultIds, offerOf, apply, choose, review, approveTexts, latestUnchosen };
