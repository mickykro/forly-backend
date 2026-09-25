/*
 * leads.js — the one lead writer, two callers (form + chat).
 *
 * Writes TWO docs on every submission:
 *   • leads/{phone}            — the rolling summary, one per prospect. status
 *                                "new" is CONDITIONAL: never downgrade a lead
 *                                that already converted to an agent signup.
 *   • lead_submissions/{auto}  — immutable, one per submission, carries the
 *                                source and the unanswered questions. Without it
 *                                a chat lead and a form lead from the same phone
 *                                collapse into one doc and the first page is lost.
 *
 * Notification (n8n / WhatsApp) stays with the caller — the form path relays via
 * n8n, the chat path WhatsApps the agent directly. This module only persists.
 */
const db = require("./db");

// source: "landing_page" | "chat" | "portfolio". questions: string[] (chat only; [] for form).
// qualification: { budget, timeline, financing } (chat only). recommended_page_ids: string[] (chat only).
// Supports both page-based leads and portfolio leads (context.page vs context.business_phone).
// attribution: { campaign_id, attempt_key, group_id } — resolved by the route
// from the fly_ref cookie (posting-attribution.js, R4), never from a request body.
async function submitLead({ page, context, name, phone, source, questions, message, portfolio_url, qualification, recommended_page_ids, attribution }) {
  if (!phone) throw new Error("phone required");   // reject before any write
  const q = Array.isArray(questions) ? questions.filter(Boolean) : [];
  const qual = qualification && Number(qualification.budget) > 0 ? {
    budget: Number(qualification.budget),
    timeline: qualification.timeline || null,
    financing: qualification.financing || null,
  } : null;
  const recIds = Array.isArray(recommended_page_ids) ? recommended_page_ids.filter(Boolean).map(String) : [];

  // Support both old { page } and new { context } patterns
  const p = page || context?.page || null;
  const agentPhone = p ? p.business_phone : context?.business_phone;
  const agent = p ? p.agent : context?.agent || {};

  const existing = await db.getLead(phone);
  const existingStatus = existing ? existing.status : null;
  await db.saveLead(phone, {
    phone, prospect_name: name, source,
    page_id: p ? p.page_id : null,
    listing_id: p ? p.listing_id : null,
    agent_phone: agentPhone,
    // never overwrite "converted" (set when a lead later signs up as an agent)
    ...(existingStatus === "converted" ? {} : { status: existingStatus || "new" }),
    last_activity_at: new Date(),
    // Only write what this submission knows — a form lead after a chat lead
    // must not null out the budget the chat captured (merge semantics).
    ...(qual ? { qualification: qual, recommended_page_ids: recIds } : {}),
  });

  await db.addLeadSubmission({
    page_id: p ? p.page_id : null,
    listing_id: p ? p.listing_id : null,
    prospect_name: name, prospect_phone: phone,
    source, questions: q,
    message: message || null,
    portfolio_url: portfolio_url || null,
    qualification: qual,
    recommended_page_ids: recIds,
    property_title: (p?.property?.title) || "",
    agent: {
      name: agent.name || "",
      brand_name: agent.brand_name || "",
      phone: agent.phone || agentPhone,
      license: agent.license || "",
    },
    agent_phone: agentPhone,
    ...(cleanAttribution(attribution) ? { attribution: cleanAttribution(attribution) } : {}),
    created_at: new Date(),
  });

  // Only increment page counter if we have a page
  if (p?.page_id) {
    await db.incrPageCounter(p.page_id, "lead_count", 1);
  }
}

// Only the three ids, as short strings; anything else attributes nothing.
function cleanAttribution(a) {
  if (!a || typeof a !== "object") return null;
  const id = (v) => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null);
  const out = { campaign_id: id(a.campaign_id), attempt_key: id(a.attempt_key), group_id: id(a.group_id) };
  return out.campaign_id && out.attempt_key ? out : null;
}

module.exports = { submitLead };
