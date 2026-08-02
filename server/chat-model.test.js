/*
 * Unit tests for chat-model.js — per-model request shaping.
 * Run: node server/chat-model.test.js
 */
const assert = require("assert");
const { requestShape, isModern, alwaysThinks } = require("./chat-model");

// ── family detection, including dated snapshots ──
assert.equal(isModern("claude-haiku-4-5"), false);
assert.equal(isModern("claude-haiku-4-5-20251001"), false);
assert.equal(isModern("claude-sonnet-5"), true);
assert.equal(isModern("claude-opus-5"), true);
assert.equal(isModern("claude-opus-4-8"), true);
assert.equal(isModern("claude-sonnet-5-20260401"), true, "dated snapshots must resolve the same");
assert.equal(isModern(""), false);
assert.equal(isModern(undefined), false);
assert.equal(alwaysThinks("claude-fable-5"), true);
assert.equal(alwaysThinks("claude-opus-5"), false);

// ── Haiku 4.5 and older: sampling params accepted, no thinking to disable ──
let s = requestShape("claude-haiku-4-5-20251001");
assert.equal(s.body.temperature, 0);
assert.equal(s.body.thinking, undefined, "no thinking field on a model without one");
assert.equal(s.body.output_config, undefined, "Haiku 4.5 has no effort parameter");
assert.equal(s.maxTokens, 400);

// ── Sonnet 5 / Opus 5: temperature is a 400, thinking defaults ON ──
for (const m of ["claude-sonnet-5", "claude-opus-5", "claude-opus-4-8"]) {
  s = requestShape(m);
  assert.equal(s.body.temperature, undefined, `${m}: temperature must not be sent`);
  assert.equal(s.body.top_p, undefined);
  assert.equal(s.body.top_k, undefined);
  // Omitting `thinking` on these means adaptive-on, which would eat the
  // 400-token budget and truncate the reply — it has to be explicit.
  assert.deepEqual(s.body.thinking, { type: "disabled" }, `${m}: thinking must be explicitly off`);
  assert.equal(s.body.output_config.effort, "low");
  assert.equal(s.maxTokens, 400);
}

// Opus 5 rejects disabled thinking above "high" effort — "low" stays legal.
assert.ok(["low", "medium", "high"].includes(requestShape("claude-opus-5").body.output_config.effort));

// ── Fable/Mythos: thinking cannot be disabled at all, so budget for it ──
s = requestShape("claude-fable-5");
assert.equal(s.body.thinking, undefined, "an explicit thinking field is a 400 here");
assert.equal(s.body.temperature, undefined);
assert.ok(s.maxTokens > 400, "thinking needs its own headroom or the reply truncates");

// ── an unknown/future id falls back to the conservative shape ──
s = requestShape("some-other-model");
assert.equal(s.maxTokens, 400);

console.log("chat-model: all tests passed");
