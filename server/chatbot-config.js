/*
 * chatbot-config.js — is the chat bot on for this page, and with what settings?
 *
 * Two levels of control, because the operator needs both:
 *   • a per-AGENT entitlement (businesses/{phone}.features.chatbot) — flipping
 *     it lights up every page that agent owns, old ones included, because it is
 *     resolved live here rather than stamped onto the page when it was built;
 *   • a per-PAGE override (property_pages/{id}.chatbot.enabled) that can force
 *     one page on for an agent who isn't entitled, or force one page off for an
 *     agent who is. `null` means "inherit", which is the default.
 *
 * Everything else (model, greeting, limits) resolves page → business defaults →
 * the constants below, so a page with no chatbot config at all still works.
 *
 * Pure functions — no I/O, no Firestore. Unit-tested in chatbot-config.test.js.
 */

// Built-in defaults live in code, not in .env: a fresh page must work with no
// configuration anywhere, and these are product decisions rather than
// deployment ones.
const DEFAULTS = {
  // Gemini Flash: cheapest and fastest of the tiers evaluated, strong Hebrew,
  // and Google is already a named data processor in the privacy policy.
  // Override per page or per business with chatbot.model — the vendor follows
  // the id (chat-provider.js), so "claude-sonnet-5" here just works.
  model: "gemini-2.5-flash",
  greeting: null,              // null ⇒ the widget falls back to its i18n string
  limits: {
    max_msgs_per_convo: 20,
    max_chars_per_msg: 500,
    max_msgs_per_ip_hour: 30,
    max_msgs_per_page_day: 300,
    max_msgs_per_agent_month: 3000,
    // After a lead is captured the bot answers this many more, then closes with
    // a fixed line — it can't promise an agent it can't deliver.
    max_msgs_after_handoff: 5,
  },
};

// Demo accounts cost tokens and produce no revenue, so they get a tighter
// monthly allowance than a paying agent.
const DEMO_MONTHLY_CAP = 500;

const firstDefined = (...vals) => {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
};

/*
 * The global kill switch. Deliberately the one setting that stays in the
 * environment rather than the database: it answers "stop every bot right now",
 * and a switch that lives only in Firestore cannot be thrown when Firestore —
 * or the spend — is the thing going wrong. Absent ⇒ on, so no env is required.
 */
function globallyEnabled(env) {
  return String((env || {}).CHATBOT_ENABLED || "").trim().toLowerCase() !== "false";
}

function isDemoBusiness(business) {
  const b = business || {};
  return b.source === "demo" || b.onboarding_state === "demo_partial";
}

/*
 * resolve(page, business, env) → the full picture for one page.
 *
 * `public` is the only part that may be sent to the browser. It is a separate
 * object rather than a filter applied at the call site so that leaking `model`
 * or `limits` to a visitor takes a deliberate mistake instead of an omission.
 */
function resolve(page, business, env) {
  const pc = (page && page.chatbot) || {};
  const bd = (business && business.chatbot_defaults) || {};
  const agentOn = !!(business && business.features && business.features.chatbot);

  let enabled;
  let reason;
  if (!globallyEnabled(env)) {
    enabled = false; reason = "global_off";
  } else if (pc.enabled === true) {
    enabled = true; reason = "page_on";
  } else if (pc.enabled === false) {
    enabled = false; reason = "page_off";
  } else {
    enabled = agentOn; reason = agentOn ? "agent_on" : "agent_off";
  }

  const pick = (k) => firstDefined(pc[k], bd[k], DEFAULTS[k]);
  const pl = pc.limits || {};
  const bl = bd.limits || {};
  const limits = {};
  for (const k of Object.keys(DEFAULTS.limits)) {
    // A bad value in Firestore (string, null-ish, non-numeric) must fall back
    // to the default rather than becoming NaN — every comparison against NaN
    // is false, which silently disables that cap entirely.
    const raw = Number(firstDefined(pl[k], bl[k], DEFAULTS.limits[k]));
    limits[k] = Number.isFinite(raw) && raw > 0 ? raw : DEFAULTS.limits[k];
  }
  if (isDemoBusiness(business) && pl.max_msgs_per_agent_month == null &&
      bl.max_msgs_per_agent_month == null) {
    limits.max_msgs_per_agent_month = DEMO_MONTHLY_CAP;
  }

  return {
    enabled,
    reason,
    public: { enabled, greeting: pick("greeting") || null },
    model: pick("model"),
    limits,
  };
}

/*
 * Compact shape for the admin properties table: what the page itself says
 * (true / false / null = inherit), what that works out to, and why.
 */
function adminState(page, business, env) {
  const pc = (page && page.chatbot) || {};
  const r = resolve(page, business, env);
  return {
    page: pc.enabled === true ? true : pc.enabled === false ? false : null,
    effective: r.enabled,
    reason: r.reason,
  };
}

module.exports = {
  DEFAULTS, DEMO_MONTHLY_CAP,
  globallyEnabled, isDemoBusiness, resolve, adminState,
};
