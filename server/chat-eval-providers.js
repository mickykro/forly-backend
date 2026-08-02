/*
 * chat-eval-providers.js — pricing table for the eval's cost estimate.
 *
 * The transport lives in chat-provider.js, which production uses too, so the
 * eval exercises the exact request the bot will send — same schema, same
 * thinking config, same headers. A comparison run against a different code path
 * than production measures the wrong thing.
 *
 * ⚠️ Non-Anthropic prices are indicative and drift; confirm against the
 * vendor's live pricing page before making a cost decision.
 */

// USD per million tokens.
const PRICING = {
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-2.0-flash": { in: 0.1, out: 0.4 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 2, out: 10 },      // introductory; list is 3/15
  "claude-opus-5": { in: 5, out: 25 },
  "claude-fable-5": { in: 10, out: 50 },
};

function priceOf(model) {
  const key = Object.keys(PRICING).find((k) => String(model).startsWith(k));
  return key ? PRICING[key] : null;
}

module.exports = { PRICING, priceOf };
