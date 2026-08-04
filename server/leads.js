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

// source: "landing_page" | "chat". questions: string[] (chat only; [] for form).
async function submitLead({ page, name, phone, source, questions }) {
  if (!phone) throw new Error("phone required");   // reject before any write
  const q = Array.isArray(questions) ? questions.filter(Boolean) : [];

  const existing = await db.getLead(phone);
  const existingStatus = existing ? existing.status : null;
  await db.saveLead(phone, {
    phone, prospect_name: name, source,
    page_id: page.page_id, listing_id: page.listing_id,
    agent_phone: page.business_phone,
    // never overwrite "converted" (set when a lead later signs up as an agent)
    ...(existingStatus === "converted" ? {} : { status: existingStatus || "new" }),
    last_activity_at: new Date(),
  });

  await db.addLeadSubmission({
    page_id: page.page_id, listing_id: page.listing_id,
    prospect_name: name, prospect_phone: phone,
    source, questions: q,
    property_title: (page.property && page.property.title) || "",
    agent: {
      name: (page.agent && page.agent.name) || "",
      brand_name: (page.agent && page.agent.brand_name) || "",
      phone: (page.agent && page.agent.phone) || page.business_phone,
      license: (page.agent && page.agent.license) || "",
    },
    agent_phone: page.business_phone,
    created_at: new Date(),
  });

  await db.incrPageCounter(page.page_id, "lead_count", 1);
}

module.exports = { submitLead };
