/*
 * page-auth.js — ownership check for the page-mutating dashboard endpoints.
 *
 * POST /api/page/update used to accept any caller ("session auth would go here;
 * for now allow any update"), so anyone holding a page_id — and page ids sit in
 * every landing-page URL an agent has ever shared — could rewrite that page's
 * price, title, agent name and images. This module is the check that closes it.
 *
 * Kept separate from routes/pages.js so the decision is a pure function and can
 * be unit-tested without Express, Firestore or a live session (pages-auth.test.js).
 *
 * Not used by /api/page/edit-text: that route authenticates with the per-page
 * edit_token instead, and serves agents who are not logged in at all.
 */

// Rollout: run one deploy with PAGE_UPDATE_AUTH=log to surface any caller we
// don't know about (an n8n node, a saved bookmark), then drop the var. The
// insecure state has to be asked for — the default is to enforce.
const MODE_LOG = "log";
const MODE_ENFORCE = "enforce";

function readMode(raw) {
  return String(raw || "").trim().toLowerCase() === MODE_LOG ? MODE_LOG : MODE_ENFORCE;
}

/** Normalize an allowlist of phones into a Set of canonical forms. */
function normalizeSet(phones, normalize) {
  return new Set((phones || []).map((p) => normalize(p)).filter(Boolean));
}

/*
 * Decide whether `session` may mutate `page`.
 *
 * Both sides are normalized before comparing: session userIds and
 * business_phone are written by different code paths ("0501234567" vs
 * "972501234567"), and a raw string compare would 403 the real owner.
 *
 * Returns {ok:true, via} or {ok:false, status, error, reason}. `reason` is for
 * the log line only — the response body never explains why beyond the code.
 */
function checkPageAccess({ session, page, adminSet, normalize }) {
  if (!session || !session.userId) {
    return { ok: false, status: 401, error: "unauthenticated", reason: "no_session" };
  }
  if (!page) {
    return { ok: false, status: 404, error: "not found", reason: "no_page" };
  }
  const caller = normalize(session.userId);
  if (!caller) {
    return { ok: false, status: 401, error: "unauthenticated", reason: "unparsable_caller" };
  }
  const owner = normalize(page.business_phone);
  if (owner && owner === caller) return { ok: true, via: "owner", caller, owner };
  if (adminSet && adminSet.has(caller)) return { ok: true, via: "admin", caller, owner };
  // A page with no business_phone at all fails closed rather than falling open;
  // the log-only deploy is what surfaces it if any such page exists.
  return {
    ok: false,
    status: 403,
    error: "not_owner",
    reason: owner ? "phone_mismatch" : "page_has_no_owner",
    caller,
    owner,
  };
}

/** One-line audit record for a denied (or would-be-denied) update. */
function denialLog(pageId, verdict, mode) {
  return `page_update_denied mode=${mode} page=${pageId} reason=${verdict.reason} ` +
    `caller=${verdict.caller || "-"} owner=${verdict.owner || "-"}`;
}

module.exports = {
  MODE_LOG,
  MODE_ENFORCE,
  readMode,
  normalizeSet,
  checkPageAccess,
  denialLog,
};
