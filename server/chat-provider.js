/*
 * chat-provider.js — one call shape for the chat bot across model vendors.
 *
 * The bot's model is a per-page config value (chatbot-config.js), so the vendor
 * has to follow the model rather than being hard-coded. The provider is
 * inferred from the model id — set `chatbot.model` to "gemini-2.5-flash" and
 * the request goes to Google; "claude-sonnet-5" and it goes to Anthropic.
 *
 * Every provider is asked for SCHEMA-ENFORCED JSON rather than being asked
 * nicely in the prompt. That matters more here than anywhere else: the bot's
 * whole purpose is that `answered: false` reliably fires the handoff, and a
 * reply we can't parse produces neither an answer nor a lead. Prompt-instructed
 * JSON makes that a probability; a response schema makes it a guarantee.
 * chat-prompt.parseModelReply stays as the backstop for the cases a schema
 * can't cover (a refusal, a truncated body).
 *
 * `buildRequest` is pure and unit-tested; `ask` is the thin fetch around it.
 *
 * Supported here are the tiers that make sense for a public, capped, per-message
 * endpoint. The frontier tiers (Claude Opus/Fable, and their equivalents) are
 * deliberately absent: they cost 10-50x per message for a bot that reads five
 * facts off a page, and Fable additionally rejects `thinking: disabled`, so
 * setting one would surface as a vendor 400 rather than working expensively.
 */
const TIMEOUT_MS = 20000;
const MAX_OUT = 400;

// The contract every provider is held to. Expressed per-vendor below because
// the three schema dialects differ in ways that are errors, not preferences.
const FIELDS = ["answered", "reply", "unanswered_question"];

const PROVIDERS = {
  anthropic: { envKey: "ANTHROPIC_API_KEY", match: /^claude-/ },
  gemini: { envKey: "GEMINI_API_KEY", match: /^(gemini|models\/gemini)/ },
  openai: { envKey: "OPENAI_API_KEY", match: /^(gpt-|o\d)/ },
};

/** Which vendor serves this model id. Unknown ids fall back to Anthropic. */
function providerFor(model) {
  const id = String(model || "");
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (p.match.test(id)) return name;
  }
  return "anthropic";
}

const envKeyFor = (model) => PROVIDERS[providerFor(model)].envKey;

// ── per-vendor request bodies ──

// Sonnet 5 and Opus 4.7+ removed the sampling parameters (sending `temperature`
// is a 400) and turned thinking ON by default — and `max_tokens` caps thinking
// and reply together, so leaving it implicit truncates the answer mid-sentence.
// Haiku 4.5 is the opposite on both counts. Matched by prefix so a dated
// snapshot resolves the same way.
const CLAUDE_NO_SAMPLING = /^claude-(opus-5|sonnet-5|opus-4-8|opus-4-7)/;

function anthropicRequest(model, system, messages, key) {
  const modern = CLAUDE_NO_SAMPLING.test(String(model));
  const body = {
    model,
    max_tokens: MAX_OUT,
    system,
    messages,
  };
  if (modern) {
    body.thinking = { type: "disabled" };   // explicit: omitting it means ON
  } else {
    body.temperature = 0;                   // Haiku 4.5 and older
  }
  // `output_config` carries BOTH the response format and the effort level, so
  // they have to be built together — assigning one over the other drops the
  // schema and silently reverts to prompt-instructed JSON.
  body.output_config = Object.assign(modern ? { effort: "low" } : {}, {
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          answered: { type: "boolean" },
          reply: { type: "string" },
          unanswered_question: { type: ["string", "null"] },
        },
        required: FIELDS,
        additionalProperties: false,
      },
    },
  });
  return {
    url: "https://api.anthropic.com/v1/messages",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    body,
  };
}

function geminiRequest(model, system, messages, key) {
  const id = String(model).replace(/^models\//, "");
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent`,
    headers: { "x-goog-api-key": key },
    body: {
      system_instruction: { parts: [{ text: system }] },
      // Gemini uses "model" for the assistant role, not "assistant".
      contents: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        temperature: 0,
        maxOutputTokens: MAX_OUT,
        responseMimeType: "application/json",
        // OpenAPI-3.0 subset: uppercase type names, `nullable` instead of a
        // union type, and no additionalProperties. Not the JSON Schema dialect
        // the other two take.
        responseSchema: {
          type: "OBJECT",
          properties: {
            answered: { type: "BOOLEAN" },
            reply: { type: "STRING" },
            unanswered_question: { type: "STRING", nullable: true },
          },
          required: ["answered", "reply"],
        },
        // 2.5-series Flash reasons by default and bills for it. There is
        // nothing to reason about over a fact sheet, and it costs latency in a
        // chat bubble, so it is switched off explicitly.
        thinkingConfig: { thinkingBudget: 0 },
      },
    },
  };
}

function openaiRequest(model, system, messages, key) {
  // Reasoning-tier ids reject `temperature` and rename the output cap.
  const reasoning = /^(o\d|gpt-5)/.test(String(model));
  const body = {
    model,
    messages: [{ role: "system", content: system }].concat(messages),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "grounded_reply",
        strict: true,
        schema: {
          type: "object",
          properties: {
            answered: { type: "boolean" },
            reply: { type: "string" },
            unanswered_question: { type: ["string", "null"] },
          },
          required: FIELDS,
          additionalProperties: false,
        },
      },
    },
  };
  if (reasoning) body.max_completion_tokens = MAX_OUT;
  else { body.max_tokens = MAX_OUT; body.temperature = 0; }
  return { url: "https://api.openai.com/v1/chat/completions", headers: { authorization: `Bearer ${key}` }, body };
}

const BUILDERS = { anthropic: anthropicRequest, gemini: geminiRequest, openai: openaiRequest };

/** Pure: the exact HTTP call for this model. Unit-tested. */
function buildRequest(model, system, messages, key) {
  return BUILDERS[providerFor(model)](model, system, messages, key || "");
}

/** Pure: pull assistant text + token usage out of a vendor response body. */
function readResponse(model, data) {
  const d = data || {};
  switch (providerFor(model)) {
    case "gemini": {
      const parts = (((d.candidates || [])[0] || {}).content || {}).parts || [];
      const u = d.usageMetadata || {};
      return {
        text: parts.map((p) => p.text || "").join(""),
        in: u.promptTokenCount || 0,
        out: u.candidatesTokenCount || 0,
      };
    }
    case "openai": {
      const msg = ((d.choices || [])[0] || {}).message || {};
      const u = d.usage || {};
      return { text: msg.content || "", in: u.prompt_tokens || 0, out: u.completion_tokens || 0 };
    }
    default: {
      const u = d.usage || {};
      return {
        text: (d.content || []).map((b) => b.text || "").join(""),
        in: u.input_tokens || 0,
        out: u.output_tokens || 0,
      };
    }
  }
}

async function ask(model, system, messages, keys) {
  const key = (keys || {})[envKeyFor(model)];
  if (!key) throw new Error(`${envKeyFor(model)} is not set (required for model ${model})`);
  const req = buildRequest(model, system, messages, key);
  const res = await fetch(req.url, {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json" }, req.headers),
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    // Surface the vendor's own message — a wrong model id or a schema dialect
    // mismatch is otherwise indistinguishable from an outage.
    throw new Error(`${providerFor(model)} ${res.status}: ${text.slice(0, 300)}`);
  }
  return readResponse(model, JSON.parse(text));
}

module.exports = { PROVIDERS, MAX_OUT, providerFor, envKeyFor, buildRequest, readResponse, ask };
