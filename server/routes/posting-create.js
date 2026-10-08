/*
 * routes/posting-create.js — the create-time checks shared by the agent's
 * campaign API (routes/posting.js) and the admin's (routes/admin-campaigns.js):
 * the body shape, the group gate, and the posting permission a campaign's
 * consent creates. Moved here unchanged from routes/posting.js.
 */
const A = require("../posting-account");
const S_ = require("./posting-shared");

const { CONSENT_VERSION } = S_;
const MODES = new Set(["per_post", "standing"]);

// A permission created by a campaign's own consent covers campaign posting
// only: no default groups and groups-only targets, so it never auto-enrolls
// new listings (posting-campaign.enrollNewPage) — that is PUT /settings' job.
// adminConsent: the consent an admin recorded ({ admin_tail, method, note }),
// kept on the permission as on the campaign; null when the agent agreed.
function campaignPermission(prev, now, adminConsent = null) {
  const a = adminConsent && typeof adminConsent === "object" ? adminConsent : null;
  return {
    enabled: true, consent_version: CONSENT_VERSION, granted_at: A.iso(now), platforms: ["facebook"],
    targets: ["groups"], default_group_ids: [], page_id: (prev && prev.page_id) || null,
    auto_mode: "standing", allows_dwell: true, allows_visible_interactions: false, revoked_at: null,
    granted_by: a ? a.admin_tail || null : null,
    consent_by: a ? { by: "admin", admin_tail: a.admin_tail || null, method: a.method || null, note: a.note || null } : { by: "agent" },
  };
}
const permActive = (p) => !!p && p.enabled === true && Array.isArray(p.platforms) && p.platforms.includes("facebook");

function validCreate(b) {
  if (typeof b.page_id !== "string" || !S_.ID_RE.test(b.page_id) || !MODES.has(b.mode)) return null;
  const g = S_.parseGroupIds(b.group_ids, { required: true });
  const t = S_.parseTargets(b.targets);
  if (g.error || t.error) return null;
  if (b.days !== undefined && !(Number.isFinite(b.days) && b.days >= 1 && b.days <= 30)) return null;
  if (b.repeat_days !== undefined && b.repeat_days !== null && !(Number.isInteger(b.repeat_days) && b.repeat_days >= 3 && b.repeat_days <= 30)) return null; // never the same property to a group within 3 days
  for (const k of ["repeat", "include_unknown", "account_aged", "posted_manually"]) if (b[k] !== undefined && typeof b[k] !== "boolean") return null;
  // The text approved per group (manual posting): { group_id: text }.
  if (b.copies !== undefined && b.copies !== null && (typeof b.copies !== "object" || Array.isArray(b.copies) || Object.keys(b.copies).length > 60
    || Object.values(b.copies).some((t) => typeof t !== "string" || t.length > require("../posting-campaign").MAX_COPY))) return null;
  return { ids: g.ids, targets: t.targets };
}

// The hard gate for groups a campaign may post to (create, add): only groups
// this account belongs to now; the catalog adds names and policy. A group
// the catalog forbids to agents, or whose listing types exclude this page's,
// is refused here rather than kept and never planned. → { groups } or
// { error, group_ids } (a 422).
async function vetGroups(catalogFn, conn, page, ids, includeUnknown) {
  const gate = S_.memberGate(conn, ids);
  if (gate.notMember) return { error: "not_member", group_ids: gate.notMember };
  const listingType = (page.property || {}).listing_type || null;
  const lookup = S_.catalogLookup(await catalogFn(listingType || "sale"));
  const unknown = gate.entries.filter((m) => !lookup(m)).map((m) => m.group_id);
  if (unknown.length && !includeUnknown) return { error: "unknown_group", group_ids: unknown };
  const disallowed = gate.entries.filter((m) => lookup.all(m).some(A.policyDisallowed) || A.nameBarsAgents(m.name)).map((m) => m.group_id);
  if (disallowed.length) return { error: "group_disallowed", group_ids: disallowed };
  const wrongType = gate.entries.filter((m) => lookup.all(m).some((e) => A.typeExcluded(e, listingType))).map((m) => m.group_id);
  if (wrongType.length) return { error: "listing_type_not_allowed", group_ids: wrongType };
  return { groups: gate.entries.map((m) => {
    const cat = lookup(m);
    return { group_id: m.group_id, url: S_.memberUrl(m), name: m.name || (cat && cat.name) || "", agent_policy: (cat && cat.agent_policy) || "unknown" };
  }) };
}

module.exports = { validCreate, vetGroups, campaignPermission, permActive, MODES };
