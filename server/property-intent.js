/*
 * property-intent.js — what does this WhatsApp message want with property pages?
 *
 *   "new"    start a property page ("בוקר טוב, אני רוצה לבנות דף נכס",
 *            "סביון, 8 חדרים, 32 מיליון")
 *   "update" change a page that already exists ("תעדכן את התמונות בדף של
 *            דליות 35", "תיצור סרטון חדש לנכס בנחל דליות")
 *   null     anything else — the message goes on to n8n's bot
 *
 * Exact keywords ("דף נכס") are caught for free by property-draft.openerKind.
 * One short LLM call through chat-provider; the caller treats a failure as null.
 */
const { ask } = require("./chat-provider");
const D = require("./property-draft");
const C = require("./draft-corrections");

const MODEL = process.env.PROPERTY_PARSE_MODEL || "claude-haiku-4-5-20251001";

const SYSTEM = `A real-estate agent sent this WhatsApp message to Forly, an assistant that builds property listing pages and also edits photos and creates marketing content.
Answer "new" if the agent wants to start a new property page, or is giving the details of a property to list (city, rooms, price...).
Answer "update" if the agent wants to change a property page that already exists: its photos, video, price or details.
Answer "no" for anything else: editing or enhancing photos, creating posts or videos not tied to an existing page, questions, small talk — even when they mention a property.
Examples:
"בוקר טוב אני רוצה לבנות דף נכס" → new
"סביון, 8 חדרים, 32 מיליון" → new
"מעלה נכס חדש :" → new
"יש לי דירה חדשה למכירה ברמת גן" → new
"אני רוצה לעדכן תמונות לנכס בנחל דליות 35" → update
"תיצור סרטון חדש לנכס בנחל דליות 35" → update
"תוריד את המחיר בדף של הרצל 5 ל-2 מיליון" → update
"תעשי את החלל הזה אחרי שיפוץ, זה אותו נכס" → no
"תכיני פוסט לאינסטגרם על הנכס" → no
"צריך לערוך את התמונות" → no
Reply with one word: new, update or no.`;

async function classify(text, { askFn = ask, model = MODEL, keys = process.env } = {}) {
  const reply = await askFn(model, SYSTEM, [{ role: "user", content: String(text).slice(0, 500) }], keys, { schema: null, maxOut: 5 });
  const m = /^\W*(new|update)\b/i.exec((reply && reply.text) || "");
  return m ? m[1].toLowerCase() : null;
}

// Only a message that mentions a property or a listing detail is worth the
// intent check's LLM call; photo edits and small talk go straight to n8n's bot.
const PROPERTY_WORDS = /נכס|דירה|דירת|בית|וילה|פנטהאוז|קוטג|דופלקס|מגרש|דף|סרטון|וידאו/;
async function intentOf(text, deps) {
  const t = String(text || "").trim();
  if (!deps.classifyIntent || !t || t.length > 300) return null;
  if (!PROPERTY_WORDS.test(t) && !C.hintedFields(t).length) return null;
  try { return await deps.classifyIntent(t); } catch (err) { return null; }
}

// Exact opener, else the intent check: "אני רוצה לבנות דף נכס" → "intent",
// "תעדכן את התמונות בדף של דליות 35" → "update".
async function openerOf(text, deps) {
  const kind = D.openerKind(text);
  if (kind) return kind;
  const intent = await intentOf(text, deps);
  return intent === "new" ? "intent" : intent;
}

module.exports = { classify, intentOf, openerOf, SYSTEM };

if (require.main === module) {
  (async () => {
    const assert = require("assert");
    const fake = (text) => async () => ({ text });
    assert.equal(await classify("x", { askFn: fake("new") }), "new");
    assert.equal(await classify("x", { askFn: fake(" Update.") }), "update");
    assert.equal(await classify("x", { askFn: fake("no") }), null);
    assert.equal(await classify("x", { askFn: fake("") }), null);
    console.log("property-intent.js ok");
  })().catch((e) => { console.error(e); process.exit(1); });
}
