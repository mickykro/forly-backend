/*
 * chat-eval-providers.js — send the same prompt to different vendors, so the
 * bot's model can be chosen from measurements instead of from vibes.
 *
 * Dev-only, used by chat-eval.js. Production (routes/chat.js) is Anthropic-only
 * — swapping the live provider is a bigger decision than this file, and it has
 * privacy-policy consequences (visitor chat text leaves for whoever serves it).
 *
 * Every adapter takes the same (system, question, model) and returns the raw
 * assistant text, so the grounding contract — one JSON object, parsed by
 * chat-prompt.parseModelReply — is identical across vendors. That is the point:
 * a model that cannot reliably emit that object is unusable here no matter how
 * well it writes Hebrew, and this makes that visible rather than theoretical.
 *
 * ⚠️ Model IDs, request shapes and prices for non-Anthropic vendors are from
 * training data and drift fast. Treat them as a starting point: the adapters
 * surface the vendor's raw error text so a wrong id or field is obvious and
 * quick to correct, rather than failing silently.
 */
const chatModel = require("./chat-model");

const TIMEOUT_MS = 30000;
const MAX_OUT = 400;

// USD per million tokens. Anthropic figures are current; the others are
// indicative only — confirm against the vendor's live pricing page before
// making a cost decision on them.
const PRICING = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 2, out: 10 },      // introductory, list is 3/15
  "claude-opus-5": { in: 5, out: 25 },
  "claude-fable-5": { in: 10, out: 50 },
};

function priceOf(model) {
  const key = Object.keys(PRICING).find((k) => String(model).startsWith(k));
  return key ? PRICING[key] : null;
}

async function post(url, headers, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json" }, headers),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const PROVIDERS = {
  anthropic: {
    envKey: "ANTHROPIC_API_KEY",
    defaultModel: "claude-haiku-4-5",
    async ask(system, question, model, key) {
      // Sampling params and thinking defaults differ across Claude families.
      const shape = chatModel.requestShape(model);
      const d = await post("https://api.anthropic.com/v1/messages",
        { "x-api-key": key, "anthropic-version": "2023-06-01" },
        Object.assign({
          model, max_tokens: shape.maxTokens, system,
          messages: [{ role: "user", content: question }],
        }, shape.body));
      return {
        text: (d.content || []).map((b) => b.text || "").join(""),
        in: (d.usage || {}).input_tokens || 0,
        out: (d.usage || {}).output_tokens || 0,
      };
    },
  },

  openai: {
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-5-mini",
    async ask(system, question, model, key) {
      // Reasoning-tier models reject `temperature` and rename the output cap,
      // the same class of split Claude has between Haiku and Sonnet 5.
      const reasoning = /^(o\d|gpt-5)/.test(model);
      const body = {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: question },
        ],
      };
      if (reasoning) body.max_completion_tokens = MAX_OUT;
      else { body.max_tokens = MAX_OUT; body.temperature = 0; }
      const d = await post("https://api.openai.com/v1/chat/completions",
        { authorization: `Bearer ${key}` }, body);
      return {
        text: ((d.choices || [])[0] || {}).message?.content || "",
        in: (d.usage || {}).prompt_tokens || 0,
        out: (d.usage || {}).completion_tokens || 0,
      };
    },
  },

  gemini: {
    envKey: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-flash",
    async ask(system, question, model, key) {
      const d = await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {},
        {
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: question }] }],
          generationConfig: { temperature: 0, maxOutputTokens: MAX_OUT },
        });
      const parts = (((d.candidates || [])[0] || {}).content || {}).parts || [];
      const u = d.usageMetadata || {};
      return {
        text: parts.map((p) => p.text || "").join(""),
        in: u.promptTokenCount || 0,
        out: u.candidatesTokenCount || 0,
      };
    },
  },
};

module.exports = { PROVIDERS, PRICING, priceOf, MAX_OUT };
