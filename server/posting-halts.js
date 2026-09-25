/*
 * posting-halts.js — R5: halts are classified, and the response is per class.
 *
 * The ACCOUNT halts, not the campaign. Every halt is appended to the
 * connection's posting_halts ({at, code}) with posting_last_halt_at, which
 * the fleet breaker (posting-sweeper.js) queries.
 *
 *   captcha / checkpoint   disabled until an operator re-enables; profile quarantined
 *   restricted             disabled indefinitely (owner-level decision)
 *   rate_limited /
 *   feature_blocked        14-day penalty (posting-safety halves the caps)
 *   login_required         reconnect needed; no penalty
 *   suspected_compromise   profile revoked; disabled until the operator lifts it
 *   selector_failure       this campaign paused `internal` after 3 in a row
 *   confirmed_removed      that group off for 30 days; two in 7 days → account penalty
 *
 * A second captcha/checkpoint/restricted within 30 days sets
 * posting_owner_review_required: the standard re-enable no longer suffices.
 * A disabling halt stops the account's open attempts (R2): pre-submit ones
 * are cancelled, submit_started+ are left for reconciliation.
 */
const safety = require("./posting-safety");
const { redact } = require("./driver-browser");
const A = require("./posting-account");

const { iso, tail, fail, ms, ctxOf, nowOf, configOf, mutate, say, tellOperator, MS_DAY } = A;
const DISABLING = safety.SIGNAL_DISABLES; // captcha, checkpoint, restricted
const PENALISING = safety.SIGNAL_PENALISES; // rate_limited, feature_blocked
const QUARANTINED = new Set(["captcha", "checkpoint"]);
const CLASSES = new Set([...DISABLING, ...PENALISING, "login_required", "suspected_compromise", "selector_failure", "confirmed_removed"]);
// Codes the driver (Task 18) reports when the page's own markers are missing.
const SELECTOR_CODES = new Set(["selector_failure", "composer_not_found", "navigation_failed", "markers_missing"]);
const SELECTOR_PAUSE_AT = 3;
const OWNER_REVIEW_WINDOW_DAYS = 30, GROUP_PENALTY_DAYS = 30, REMOVALS_WINDOW_DAYS = 7, HALT_KEEP_DAYS = 365;

// A driver/verification code → its R5 class, or null when it is not a halt.
function classOf(code) {
  if (!code) return null;
  if (CLASSES.has(code) && code !== "selector_failure") return code;
  if (SELECTOR_CODES.has(code)) return "selector_failure";
  if (code === "removed") return "confirmed_removed";
  return null;
}

async function cancelOpen(x, phone, now) {
  try { return await x.store.cancelOpenAttempts(phone, "facebook", now); }
  catch (e) {
    // Never let a failed cancel abort the halt: the reaper cancels on lease expiry.
    A.noteCancelFailure((e && e.failures && e.failures.length) || 1);
    console.error(redact(`posting halt ${tail(phone)}: cancel incomplete (${(e && e.code) || "error"})`));
    return (e && e.cancelled) || 0;
  }
}

async function lifecycleStop(cls, phone, deps, x, now) {
  const lifecycle = deps.lifecycle || require("./profile-lifecycle");
  const lcDeps = { db: x.db, driver: deps.driver || require("./driver-browser") };
  try {
    if (QUARANTINED.has(cls)) return await lifecycle.quarantine(phone, "facebook", cls, lcDeps);
    return await lifecycle.revoke({ phone, platform: "facebook", reason: "suspected_compromise" }, lcDeps);
  } catch (e) {
    console.error(redact(`posting halt ${tail(phone)}: ${cls} lifecycle failed (${(e && e.code) || "error"})`));
    return cancelOpen(x, phone, now); // the profile write may have failed; the attempts still stop
  }
}

const MESSAGES = {
  disabled: (code) => `⚠️ פייסבוק עצרה את הפרסום בחשבון שלכם (${code}). הפרסום האוטומטי כבוי עד שנבדוק את זה יחד איתכם.`,
  penalty: (code) => `⚠️ פייסבוק הגבילה זמנית את הפרסום (${code}). בשבועיים הקרובים נפרסם לאט יותר.`,
  reconnect: () => "🔑 פייסבוק ביקשה להתחבר מחדש. כדי שהפרסום ימשיך, התחברו שוב מעמוד החיבורים.",
  removed: () => "ℹ️ מנהלי אחת הקבוצות הסירו פוסט. לא נפרסם בקבוצה הזו בחודש הקרוב.",
};

/*
 * haltAccount(phone, cls, deps, { campaignId, group_id, now })
 * → { cls, disabled, owner_review, penalty_until, reconnect, paused, campaign_paused }
 */
async function haltAccount(phone, cls, deps = {}, opts = {}) {
  if (!CLASSES.has(cls)) throw fail("invalid_input", "unknown halt class");
  if (cls === "confirmed_removed" && !opts.group_id) throw fail("invalid_input", "confirmed_removed needs group_id");
  phone = String(phone);
  const x = ctxOf(deps);
  const now = opts.now instanceof Date ? opts.now : nowOf(deps, x);
  const at = iso(now);
  const config = await configOf(deps, x);
  const out = { cls, disabled: false, owner_review: false, penalty_until: null, reconnect: false, paused: 0, campaign_paused: false };

  const conn = (await x.db.getConnection(phone)) || {};
  const prior = (conn.posting_halts || []).filter((h) => h && now.getTime() - ms(h.at) < HALT_KEEP_DAYS * MS_DAY);
  const entry = opts.group_id ? { at, code: cls, group_id: String(opts.group_id) } : { at, code: cls };
  const patch = { posting_halts: prior.concat([entry]), posting_last_halt_at: at, posting_last_halt_code: cls };
  const within = (h, days) => now.getTime() - ms(h.at) < days * MS_DAY;

  if (DISABLING.has(cls) || cls === "suspected_compromise") {
    Object.assign(patch, { posting_disabled_until_admin: true, posting_disabled_at: at, posting_disabled_class: cls });
    out.disabled = true;
    if (DISABLING.has(cls) && prior.some((h) => DISABLING.has(h.code) && within(h, OWNER_REVIEW_WINDOW_DAYS))) {
      patch.posting_owner_review_required = true;
      out.owner_review = true;
    }
  }
  if (PENALISING.has(cls)) out.penalty_until = patch.posting_penalty_until = iso(now.getTime() + config.penalty_days * MS_DAY);
  if (cls === "login_required") {
    Object.assign(patch, { facebook_needs_reconnect: true, facebook_needs_reconnect_at: at });
    out.reconnect = true;
  }
  if (cls === "confirmed_removed") {
    patch.posting_group_penalties = { [String(opts.group_id)]: { code: cls, at, until: iso(now.getTime() + GROUP_PENALTY_DAYS * MS_DAY) } };
    if (prior.some((h) => h.code === "confirmed_removed" && within(h, REMOVALS_WINDOW_DAYS))) {
      out.penalty_until = patch.posting_penalty_until = iso(now.getTime() + config.penalty_days * MS_DAY);
    }
  }
  await x.db.setConnection(phone, patch);

  // R2: the account stops now — its open attempts and every running campaign.
  if (out.disabled || out.reconnect) {
    if (QUARANTINED.has(cls) || cls === "suspected_compromise") await lifecycleStop(cls, phone, deps, x, now);
    else await cancelOpen(x, phone, now);
    for (const c of await x.store.listPostingCampaignsByPhone(phone)) {
      if (c.status !== "running") continue;
      if (await mutate(x, c.id, (cur) => (cur.status === "running" ? { status: "paused", pause_reason: "account" } : null))) out.paused++;
    }
  }

  // A calibration problem, not the account's: three in a row pause the campaign.
  if (cls === "selector_failure" && opts.campaignId) {
    const c = await mutate(x, opts.campaignId, (cur) => {
      const n = (cur.selector_failures || 0) + 1;
      return n >= SELECTOR_PAUSE_AT && cur.status === "running" ? { selector_failures: n, status: "paused", pause_reason: "internal" } : { selector_failures: n };
    });
    out.campaign_paused = !!(c && c.status === "paused" && c.pause_reason === "internal");
    if (out.campaign_paused) await tellOperator(deps, `posting: campaign …${String(opts.campaignId).slice(-6)} paused after ${SELECTOR_PAUSE_AT} selector failures — calibration needed`);
  }

  // Task 20's builders take (campaign, code); the campaign is the one that halted, when known.
  const camp = opts.campaignId ? await x.store.getPostingCampaign(opts.campaignId) : null;
  if (out.disabled) await say(deps, phone, "halted", MESSAGES.disabled(cls), camp, cls);
  else if (out.reconnect) await say(deps, phone, "reconnect", MESSAGES.reconnect(), camp, cls);
  else if (cls === "confirmed_removed") await say(deps, phone, "removed", MESSAGES.removed(), camp, cls);
  else if (out.penalty_until) await say(deps, phone, "penalty", MESSAGES.penalty(cls), camp, cls);

  if (out.disabled || out.owner_review) {
    const what = out.owner_review ? "second disabling halt in 30 days — owner review required" : "account disabled";
    await tellOperator(deps, `posting: ${what} (${cls}) for account ${tail(phone)}`);
  }
  if (cls !== "selector_failure") console.error(redact(`posting halt ${tail(phone)}: ${cls}${out.disabled ? " (disabled)" : ""}`));
  return out;
}

module.exports = { haltAccount, classOf, CLASSES, SELECTOR_CODES, SELECTOR_PAUSE_AT };
