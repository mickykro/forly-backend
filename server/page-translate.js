/*
 * page-translate.js — a property page's words in the page's chosen language.
 *
 * The agent picks the page language on create; the input (typed fields, a
 * WhatsApp draft, an imported Yad2/Facebook listing) can be in any language,
 * and n8n's generated copy does not always follow the choice. Right before the
 * page is saved, every visible text field is sent to Claude in one call and
 * comes back in the page language. Static labels are already translated by the
 * templates (public-nadlan/templates/i18n.js); tags stay as they are — they are
 * canonical keys the portal filters on.
 *
 * Place names are display-only: property.address/neighborhood/city stay as
 * entered (group matching, the chat bot and distribution compare them against
 * Hebrew catalogs), and the translations go to doc.place_i18n, which the page
 * payload (routes/pages.js pagePayload) shows in their place.
 *
 * Fail-open: no key, a refusal, a timeout or a malformed reply leaves the page
 * exactly as built. A page is never held back by its translation.
 */
const NAMES = { he: "Hebrew", en: "English", ar: "Arabic", ru: "Russian", es: "Spanish", fr: "French" };
const MODEL = process.env.PAGE_TRANSLATE_MODEL || "claude-opus-5-5";
const UI_MODEL = process.env.UI_TRANSLATE_MODEL || "claude-sonnet-5-5"; // UI strings: many, short, no nuance to buy
const { CLAUDE_NO_SAMPLING } = require("./chat-provider");
// The 5.5 models do not think before responding and answer 400 to
// thinking: disabled ("send between_tools instead"); nothing to switch off.
const NO_THINKING_PARAM = /^claude-(opus|sonnet|haiku)-5-5/;
const MAX_FIELDS = 80;

// Letters that are not the target language's script. For the three scripts
// that only one supported language uses, a page with none of them needs no call.
const FOREIGN = {
  he: /[A-Za-zÀ-ɏЀ-ӿ؀-ۿ]/,
  ar: /[A-Za-zÀ-ɏЀ-ӿ֐-׿]/,
  ru: /[A-Za-zÀ-ɏ֐-׿؀-ۿ]/,
};

const ITEM_KEYS = ["name", "label", "title", "desc", "description", "type", "category", "text"];
const isText = (v) => typeof v === "string" && /\p{L}/u.test(v);

// Every visible text field as { path: text }. Paths are dot paths into the doc.
function collect(doc) {
  const out = {};
  const put = (path, v) => { if (isText(v)) out[path] = v; };
  const p = doc.property || {};
  for (const k of ["title", "address", "neighborhood", "city"]) put(`property.${k}`, p[k]);
  put("hero.phrase", doc.hero && doc.hero.phrase);
  ((doc.carousel && doc.carousel.slides) || []).forEach((s, i) => {
    for (const k of ["num", "title", "body", "tag"]) put(`carousel.slides.${i}.${k}`, s && s[k]);
  });
  ((doc.gallery && doc.gallery.images) || []).forEach((img, i) => put(`gallery.images.${i}.description`, img && img.description));
  const area = doc.area || {};
  put("area.blurb", area.blurb);
  for (const list of ["stops", "stats"]) {
    (area[list] || []).forEach((it, i) => {
      if (typeof it === "string") return put(`area.${list}.${i}`, it);
      for (const k of ITEM_KEYS) put(`area.${list}.${i}.${k}`, it && it[k]);
    });
  }
  const cta = doc.cta || {};
  for (const k of ["headline", "sub", "button_label"]) put(`cta.${k}`, cta[k]);
  (cta.bullets || []).forEach((b, i) => put(`cta.bullets.${i}`, b));
  put("agent.tagline", doc.agent && doc.agent.tagline);
  for (const [k, v] of Object.entries(doc.texts || {})) put(`texts.${k}`, v);
  return out;
}

const PLACE = /^property\.(address|neighborhood|city)$/;

function setPath(doc, path, value) {
  const place = PLACE.exec(path);
  if (place) {
    doc.place_i18n = Object.assign({}, doc.place_i18n, { [place[1]]: value });
    return;
  }
  const parts = path.split(".");
  let node = doc;
  for (const part of parts.slice(0, -1)) {
    if (node == null || typeof node !== "object") return;
    node = node[part];
  }
  if (node != null && typeof node === "object") node[parts[parts.length - 1]] = value;
}

// True when the page's text is already all in the target language's script.
function alreadyIn(lang, fields) {
  const re = FOREIGN[lang];
  return !!re && Object.values(fields).every((v) => !re.test(v));
}

function buildRequest(lang, fields, model = MODEL) {
  const keys = Object.keys(fields);
  return {
    model,
    max_tokens: 16000,
    // Opus 5 / Sonnet 5 think by default, and max_tokens caps thinking and the
    // reply together (chat-provider.js): off, or a page's worth of JSON can be
    // cut short or run past the timeout.
    ...(CLAUDE_NO_SAMPLING.test(model) && !NO_THINKING_PARAM.test(model) ? { thinking: { type: "disabled" } } : {}),
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // a declined request is re-run on Anthropic's recommended fallback
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
          required: keys,
          additionalProperties: false,
        },
      },
    },
    system:
      `You localize the text of a real-estate listing page into ${NAMES[lang]}. ` +
      "Each JSON value is one visible text on the page. Return the same keys, each value written " +
      `naturally in ${NAMES[lang]} for local home buyers. A value already in ${NAMES[lang]} is returned unchanged. ` +
      `Place names (streets, neighborhoods, cities) are given as a ${NAMES[lang]} reader knows them; ` +
      "keep house numbers, prices, numbers and units. People's and companies' names are not translated. " +
      "Keep each value about as long as the original; it sits in a fixed design.",
    messages: [{ role: "user", content: JSON.stringify(fields) }],
  };
}

// → the reply's { path: text }, keeping only known keys with non-empty strings.
function readReply(response, fields) {
  if (!response || response.stop_reason === "refusal" || response.stop_reason === "max_tokens") return null;
  const text = (response.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const out = {};
  for (const k of Object.keys(fields)) {
    if (typeof parsed[k] === "string" && parsed[k].trim()) out[k] = parsed[k].trim();
  }
  return out;
}

/*
 * Translate the page doc in place into doc.language. → { translated: n } or
 * { skipped: reason }. deps.client (tests) stands in for the Anthropic client.
 */
async function translatePage(doc, deps = {}) {
  const lang = doc && doc.language;
  if (!NAMES[lang]) return { skipped: "language" };
  const fields = collect(doc);
  const keys = Object.keys(fields);
  if (!keys.length) return { skipped: "empty" };
  if (keys.length > MAX_FIELDS) return { skipped: "too_many_fields" };
  if (alreadyIn(lang, fields)) return { skipped: "already_in_language" };
  const client = clientOf(deps);
  if (!client) return { skipped: "no_api_key" };
  let response;
  try {
    response = await client.beta.messages.create(buildRequest(lang, fields));
  } catch (err) {
    console.error(`[page-translate] ${lang} failed: ${err && (err.status || "")} ${err && err.message}`);
    return { skipped: "error" };
  }
  const out = readReply(response, fields);
  if (!out) return { skipped: response && response.stop_reason === "refusal" ? "refusal" : "bad_reply" };
  for (const [path, value] of Object.entries(out)) setPath(doc, path, value);
  return { translated: Object.keys(out).length };
}

// A Claude client, or null when the server has no key (deps.client stands in for tests).
function clientOf(deps) {
  if (deps.client) return deps.client;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require("@anthropic-ai/sdk");
  return new Anthropic({ timeout: 60000, maxRetries: 2 });
}

/*
 * The dashboard's own words (routes/i18n.js): Hebrew UI strings → { source:
 * translation } for the ones that came back; null when nothing could be asked
 * (no key, unknown language); throws when the call failed or the reply was
 * unusable, so the caller can say why. Same call shape as a page; the strings
 * are keyed by position for the schema.
 */
async function translateStrings(lang, strings, deps = {}) {
  const client = clientOf(deps);
  if (!NAMES[lang] || !client || !strings.length) return null;
  const fields = Object.fromEntries(strings.map((s, i) => [`s${i}`, s]));
  const req = buildRequest(lang, fields, deps.model || UI_MODEL);
  req.system =
    `You localize the user interface of a real-estate agents' web dashboard from Hebrew into ${NAMES[lang]}. ` +
    "Each JSON value is one UI string, or a fragment of one that the code joins to a number or a name. " +
    `Return the same keys, each value in natural, concise ${NAMES[lang]} as a software product would phrase it. ` +
    "Keep punctuation, emoji, arrows, ellipses and leading/trailing dashes as they are; keep digits, {placeholders} and " +
    "product names (Forly, WhatsApp, Facebook, Instagram) unchanged. A fragment stays a fragment (do not complete the sentence).";
  const response = await client.beta.messages.create(req);
  const out = readReply(response, fields);
  if (!out) throw new Error(`unusable reply (stop_reason ${response && response.stop_reason})`);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [fields[k], v]));
}

module.exports = { translatePage, translateStrings, collect, setPath, alreadyIn, buildRequest, readReply, NAMES, MODEL, UI_MODEL };
