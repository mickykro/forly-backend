/* Safe delivery boundary for messages initiated from the operator console. */

const MAX_MESSAGE_CHARS = 1500;
const MAX_RECIPIENTS = 200;

async function deliverAgentMessage({ agents, recipientPhones, message, send, record, sentBy }) {
  const text = String(message || "").trim();
  if (!text) throw new Error("message_required");
  if (text.length > MAX_MESSAGE_CHARS) throw new Error("message_too_long");

  const requested = new Set((recipientPhones || []).map(String));
  const seenPhones = new Set();
  const recipients = (agents || []).filter((agent) => {
    const phone = String(agent.phone || "");
    if (!phone || !requested.has(phone) || seenPhones.has(phone)) return false;
    seenPhones.add(phone);
    return true;
  });
  if (!recipients.length) throw new Error("no_recipients");
  if (recipients.length > MAX_RECIPIENTS) throw new Error("too_many_recipients");

  for (const agent of recipients) await send(agent.phone, text);
  const entry = {
    sent_by: sentBy || "",
    recipient_count: recipients.length,
    recipient_phones: recipients.map((agent) => agent.phone),
    message: text,
    created_at: new Date(),
  };
  await record(entry);
  return { recipientCount: recipients.length };
}

module.exports = { deliverAgentMessage, MAX_MESSAGE_CHARS, MAX_RECIPIENTS };
