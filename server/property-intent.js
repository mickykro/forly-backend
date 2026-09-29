/*
 * property-intent.js — does this WhatsApp message mean "start a property page"?
 *
 * Exact keywords ("דף נכס") are caught for free by property-draft.openerKind;
 * this catches the way agents actually write it ("בוקר טוב, אני רוצה לבנות דף
 * נכס", "סביון, 8 חדרים, 32 מיליון"). One short LLM call through chat-provider;
 * any failure is a "no", so the message falls through to n8n's bot as before.
 */
const { ask } = require("./chat-provider");

const MODEL = process.env.PROPERTY_PARSE_MODEL || "claude-haiku-4-5-20251001";

const SYSTEM = `A real-estate agent sent this WhatsApp message to Forly, an assistant that builds property listing pages and also edits photos and creates marketing content.
Answer "yes" if the agent wants to start a new property page, or is giving the details of a property to list (city, rooms, price...).
Answer "no" for anything else: photo edits, videos, posts, questions, small talk — even when they mention a property.
Examples:
"בוקר טוב אני רוצה לבנות דף נכס" → yes
"סביון, 8 חדרים, 32 מיליון" → yes
"יש לי דירה חדשה למכירה ברמת גן" → yes
"תעשי את החלל הזה אחרי שיפוץ, זה אותו נכס" → no
"תכיני פוסט לאינסטגרם על הנכס" → no
Reply with one word: yes or no.`;

async function wantsNewProperty(text, { askFn = ask, model = MODEL, keys = process.env } = {}) {
  const reply = await askFn(model, SYSTEM, [{ role: "user", content: String(text).slice(0, 500) }], keys, { schema: null, maxOut: 5 });
  return /^\W*yes/i.test((reply && reply.text) || "");
}

module.exports = { wantsNewProperty, SYSTEM };

if (require.main === module) {
  (async () => {
    const assert = require("assert");
    const fake = (text) => async () => ({ text });
    assert.equal(await wantsNewProperty("x", { askFn: fake("yes") }), true);
    assert.equal(await wantsNewProperty("x", { askFn: fake(" Yes.") }), true);
    assert.equal(await wantsNewProperty("x", { askFn: fake("no") }), false);
    assert.equal(await wantsNewProperty("x", { askFn: fake("") }), false);
    console.log("property-intent.js ok");
  })().catch((e) => { console.error(e); process.exit(1); });
}
