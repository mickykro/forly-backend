/* Unit tests for the admin agent-message delivery service. */
const assert = require("assert");
const { deliverAgentMessage } = require("./admin-messages");

const agents = [
  { phone: "972521111111", name: "Yael Realty" },
  { phone: "972522222222", name: "Noam Properties" },
];

(async () => {
  const sent = [];
  const recorded = [];
  await deliverAgentMessage({
    agents,
    recipientPhones: ["972522222222"],
    message: "Welcome to Forly",
    send: async (phone, message) => sent.push({ phone, message }),
    record: async (entry) => recorded.push(entry),
    sentBy: "972500000000",
  });
  assert.deepEqual(sent, [{ phone: "972522222222", message: "Welcome to Forly" }],
    "only the selected agent receives the message");
  assert.equal(recorded[0].recipient_count, 1, "delivery is recorded with the sent count");
  assert.equal(recorded[0].sent_by, "972500000000");

  const duplicateSent = [];
  const duplicateRecorded = [];
  await deliverAgentMessage({
    agents: agents.concat([{ phone: "972521111111", name: "Yael duplicate" }]),
    recipientPhones: ["972521111111"],
    message: "Welcome to Forly",
    send: async (phone) => duplicateSent.push(phone),
    record: async (entry) => duplicateRecorded.push(entry),
  });
  assert.deepEqual(duplicateSent, ["972521111111"], "a duplicate agent phone is sent once");
  assert.equal(duplicateRecorded[0].recipient_count, 1, "the audit count is deduplicated");

  await assert.rejects(
    () => deliverAgentMessage({ agents, recipientPhones: [], message: "   ", send: async () => {}, record: async () => {} }),
    /message_required/
  );
  await assert.rejects(
    () => deliverAgentMessage({ agents, recipientPhones: ["972521111111"], message: "x".repeat(1501), send: async () => {}, record: async () => {} }),
    /message_too_long/
  );
  await assert.rejects(
    () => deliverAgentMessage({ agents, recipientPhones: ["972529999999"], message: "Hello", send: async () => {}, record: async () => {} }),
    /no_recipients/
  );

  console.log("admin-messages.test.js ✓");
})().catch((err) => { console.error(err); process.exit(1); });
