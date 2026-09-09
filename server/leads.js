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
// Supports both page-based leads and portfolio leads (context.page vs context.business_phone).
async function submitLead({ page, context, name, phone, source, questions, message, portfolio_url }) {
  if (!phone) throw new Error("phone required");   // reject before any write
  const q = Array.isArray(questions) ? questions.filter(Boolean) : [];

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
  });

  await db.addLeadSubmission({
    page_id: p ? p.page_id : null,
    listing_id: p ? p.listing_id : null,
    prospect_name: name, prospect_phone: phone,
    source, questions: q,
    message: message || null,
    portfolio_url: portfolio_url || null,
    property_title: (p?.property?.title) || "",
    agent: {
      name: agent.name || "",
      brand_name: agent.brand_name || "",
      phone: agent.phone || agentPhone,
      license: agent.license || "",
    },
    agent_phone: agentPhone,
    created_at: new Date(),
  });

  // Only increment page counter if we have a page
  if (p?.page_id) {
    await db.incrPageCounter(p.page_id, "lead_count", 1);
  }
}

module.exports = { submitLead };
