/*
 * chat-model.js — per-model request shaping for the Messages API.
 *
 * The model is configurable per page (chatbot-config.js), but the request body
 * a model accepts is NOT uniform, and the differences are hard errors rather
 * than degradations:
 *
 *   • Sampling parameters (temperature/top_p/top_k) are REMOVED on Opus 5 and
 *     rejected as non-default on Sonnet 5 — a `temperature: 0` that is correct
 *     on Haiku 4.5 returns a 400 on either.
 *   • Thinking is ON by default on Sonnet 5 and Opus 5 (it is off on Haiku 4.5
 *     and was off on Opus 4.7/4.8). `max_tokens` caps thinking + reply
 *     together, so a request tuned for a 400-token answer silently truncates
 *     mid-sentence once thinking is on.
 *
 * The bot answers short grounded questions from a fact sheet — there is nothing
 * to reason about — so thinking is disabled wherever the model allows it, and
 * effort is pinned low. That keeps behaviour and cost comparable across models,
 * which is the point: the model should be a config value, not a rewrite.
 *
 * Pure functions, unit-tested in chat-model.test.js.
 */

// Models that removed sampling params and default thinking to on. Matched by
// prefix so a dated snapshot (claude-sonnet-5-2026…) resolves the same way.
const MODERN = [
  "claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-mythos-5",
  "claude-opus-4-8", "claude-opus-4-7",
];

// Fable/Mythos reject an explicit thinking:disabled at any effort — thinking is
// always on there. Omitting the field is the only accepted form.
const ALWAYS_THINKS = ["claude-fable-5", "claude-mythos-5"];

const startsWithAny = (model, list) =>
  list.some((m) => String(model || "").startsWith(m));

const isModern = (model) => startsWithAny(model, MODERN);
const alwaysThinks = (model) => startsWithAny(model, ALWAYS_THINKS);

/*
 * The model-specific half of the request body. Merge over the shared fields
 * (model, system, messages, max_tokens).
 *
 * `maxTokens` is returned rather than taken from the caller because a model
 * that insists on thinking needs headroom for it — 400 tokens is an answer
 * budget, not an answer-plus-reasoning budget.
 */
function requestShape(model) {
  if (alwaysThinks(model)) {
    // Cannot disable; give thinking its own room so the reply isn't truncated.
    return { maxTokens: 2000, body: { output_config: { effort: "low" } } };
  }
  if (isModern(model)) {
    return {
      maxTokens: 400,
      body: {
        // Explicit: on these models omitting `thinking` means adaptive-on.
        thinking: { type: "disabled" },
        // Valid alongside disabled thinking at "high" or below on Opus 5.
        output_config: { effort: "low" },
      },
    };
  }
  // Haiku 4.5 and older: no effort parameter, sampling params still accepted.
  return { maxTokens: 400, body: { temperature: 0 } };
}

module.exports = { MODERN, ALWAYS_THINKS, isModern, alwaysThinks, requestShape };
