/*
 * Unit tests for chat-provider.js — request shaping and response reading
 * across vendors. Pure: no network.
 * Run: node server/chat-provider.test.js
 */
const assert = require("assert");
const { providerFor, envKeyFor, buildRequest, readResponse } = require("./chat-provider");

const MSGS = [{ role: "user", content: "כמה חדרים?" }];
const build = (m) => buildRequest(m, "FACTS", MSGS, "KEY");

// ── the vendor follows the model id ──
assert.equal(providerFor("gemini-2.5-flash"), "gemini");
assert.equal(providerFor("models/gemini-2.5-flash"), "gemini");
assert.equal(providerFor("claude-sonnet-5"), "anthropic");
assert.equal(providerFor("gpt-5-mini"), "openai");
assert.equal(providerFor("o3-mini"), "openai");
assert.equal(providerFor(""), "anthropic", "unknown ids fall back, never crash");
assert.equal(providerFor(undefined), "anthropic");
assert.equal(envKeyFor("gemini-2.5-flash"), "GEMINI_API_KEY");
assert.equal(envKeyFor("claude-sonnet-5"), "ANTHROPIC_API_KEY");

// ── Gemini ──
let r = build("gemini-2.5-flash");
assert.ok(r.url.includes("/models/gemini-2.5-flash:generateContent"));
assert.equal(r.headers["x-goog-api-key"], "KEY");
assert.ok(!r.url.includes("KEY"), "the key belongs in a header, not the URL (it gets logged)");
assert.equal(r.body.system_instruction.parts[0].text, "FACTS");
assert.equal(r.body.contents[0].role, "user");
// Schema-enforced JSON is what makes answered:false dependable.
assert.equal(r.body.generationConfig.responseMimeType, "application/json");
assert.equal(r.body.generationConfig.responseSchema.type, "OBJECT");
assert.deepEqual(r.body.generationConfig.responseSchema.required, ["answered", "reply"]);
assert.equal(r.body.generationConfig.responseSchema.properties.unanswered_question.nullable, true);
assert.equal(r.body.generationConfig.responseSchema.additionalProperties, undefined,
  "Gemini's schema dialect rejects additionalProperties");
// 2.5 Flash reasons by default and bills for it; nothing here needs reasoning.
assert.equal(r.body.generationConfig.thinkingConfig.thinkingBudget, 0);
assert.equal(r.body.generationConfig.temperature, 0);

// "models/" prefix must not be doubled in the URL
assert.ok(build("models/gemini-2.5-flash").url.includes("/models/gemini-2.5-flash:"));
assert.ok(!build("models/gemini-2.5-flash").url.includes("models/models/"));

// assistant turns are renamed — Gemini has no "assistant" role
r = buildRequest("gemini-2.5-flash", "F",
  [{ role: "user", content: "a" }, { role: "assistant", content: "b" }], "K");
assert.deepEqual(r.body.contents.map((c) => c.role), ["user", "model"]);

// ── Anthropic ──
r = build("claude-sonnet-5");
assert.equal(r.url, "https://api.anthropic.com/v1/messages");
assert.equal(r.headers["x-api-key"], "KEY");
assert.equal(r.body.system, "FACTS");
assert.equal(r.body.output_config.format.type, "json_schema");
assert.equal(r.body.output_config.format.schema.additionalProperties, false);
// Sonnet 5 removed sampling params and defaults thinking ON.
assert.deepEqual(r.body.thinking, { type: "disabled" });
// output_config carries both effort and format — merging them, not clobbering.
assert.equal(r.body.output_config.effort, "low");
assert.equal(r.body.temperature, undefined);
// Haiku 4.5 is the opposite: temperature is accepted, there is no effort knob,
// and there is no thinking to switch off.
r = build("claude-haiku-4-5");
assert.equal(r.body.temperature, 0);
assert.equal(r.body.thinking, undefined);
assert.equal(r.body.output_config.effort, undefined);
assert.equal(r.body.output_config.format.type, "json_schema", "the schema applies to every tier");
assert.equal(build("claude-haiku-4-5-20251001").body.temperature, 0, "dated snapshots resolve the same");
assert.deepEqual(build("claude-opus-4-8").body.thinking, { type: "disabled" });

// ── OpenAI ──
r = build("gpt-5-mini");
assert.equal(r.headers.authorization, "Bearer KEY");
assert.equal(r.body.messages[0].role, "system");
assert.equal(r.body.response_format.json_schema.strict, true);
assert.equal(r.body.max_completion_tokens, 400, "reasoning tier renames the output cap");
assert.equal(r.body.max_tokens, undefined);
assert.equal(r.body.temperature, undefined, "reasoning tier rejects temperature");
r = build("gpt-4o-mini");
assert.equal(r.body.max_tokens, 400);
assert.equal(r.body.temperature, 0);

// ── reading responses ──
const g = readResponse("gemini-2.5-flash", {
  candidates: [{ content: { parts: [{ text: '{"answered":true}' }] } }],
  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 5 },
});
assert.deepEqual(g, { text: '{"answered":true}', in: 11, out: 5 });

assert.deepEqual(readResponse("gpt-4o-mini", {
  choices: [{ message: { content: "hi" } }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
}), { text: "hi", in: 3, out: 2 });

assert.deepEqual(readResponse("claude-sonnet-5", {
  content: [{ type: "text", text: "hi" }],
  usage: { input_tokens: 3, output_tokens: 2 },
}), { text: "hi", in: 3, out: 2 });

// An empty or malformed body must yield empty text, never throw — the caller
// treats unparsable output as "no answer, no handoff".
for (const m of ["gemini-2.5-flash", "gpt-4o-mini", "claude-sonnet-5"]) {
  assert.equal(readResponse(m, {}).text, "");
  assert.equal(readResponse(m, null).text, "");
  assert.equal(readResponse(m, { candidates: [], choices: [], content: [] }).text, "");
}

console.log("chat-provider: all tests passed");
