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

function buildRequest(lang, fields) {
  const keys = Object.keys(fields);
  return {
    model: MODEL,
    max_tokens: 16000,
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
  let client = deps.client;
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) return { skipped: "no_api_key" };
    const Anthropic = require("@anthropic-ai/sdk");
    client = new Anthropic({ timeout: 60000, maxRetries: 2 });
  }
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

module.exports = { translatePage, collect, alreadyIn, buildRequest, readReply, NAMES, MODEL };
