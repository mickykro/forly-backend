/*
 * whatsapp-replies.js — every message the property chat sends, in one place.
 * Each function returns { text, buttons? }. Button texts ARE the command words
 * property-draft.command() understands, so a tap and a typed word behave the
 * same. Green API: max 3 buttons, 25 chars each (utils.sendWhatsAppButtons).
 */
const { MIN_PHOTOS } = require("./property-draft");
const { inPlace } = require("./utils");
const { symbol } = require("./currency");
// "תמונה אחת" / "4 תמונות" — Hebrew nouns don't stay plural with 1.
const count = (n, one, many) => (n === 1 ? one : `${n} ${many}`);
// No currency on the draft/page means ILS (everything created before currencies existed).
const money = (n, cur) => `${symbol(cur)}${Number(n).toLocaleString("en-US")}`;

const LABELS = {
  city: "עיר", address: "כתובת", price: "מחיר", rooms: "מספר חדרים", deal: "סוג עסקה", size_sqm: "שטח במ״ר",
  floor: "קומה", parking: "חניות", neighborhood: "שכונה", description: "תיאור", template: "עיצוב", currency: "מטבע", sqm_built: "מ״ר בנוי", sqm_plot: "מגרש (מ״ר)",
};

const QUESTIONS = {
  city: "באיזו עיר הנכס?",
  price: "מה המחיר? (למשל 2,900,000 או 2.9 מיליון; לשכירות — לחודש)",
  rooms: "כמה חדרים? (אפשר גם 3.5)",
  deal: "למכירה או להשכרה?",
  size_sqm: "מה השטח במ״ר?",
  floor: "באיזו קומה? (קרקע = 0)",
  parking: "כמה חניות? (אין = 0)",
  neighborhood: "באיזו שכונה?",
  description: "רוצים להוסיף תיאור קצר לנכס? שלחו טקסט חופשי.",
  // Numbers and names follow property-draft.js TEMPLATES (create.html's picker order).
  template: "איזה עיצוב לדף? ענו במספר או בשם:\n1 קלאסי · 2 נוקטורן · 3 ריל · 4 אטלייה · 5 לופה · 6 אורביט",
};
const REQUIRED = new Set(["city", "price", "rooms"]);

function ask(field) {
  const optional = !REQUIRED.has(field);
  const r = { text: QUESTIONS[field] + (optional ? "\n(או דלג)" : "") };
  if (field === "deal") r.buttons = ["למכירה", "להשכרה"];
  if (field === "template") r.buttons = ["קלאסי", "נוקטורן", "ריל"]; // Green API caps buttons at 3; the text lists all six
  return r;
}
// Second miss on the same question: don't repeat it word for word — say what works.
const EXAMPLES = {
  price: "כתבו מספר, למשל 2,500,000 או 2.5 מיליון", rooms: "כתבו רק מספר, למשל 4 או 3.5",
  size_sqm: "כתבו רק מספר, למשל 95", floor: "כתבו רק מספר, למשל 3 (קרקע = 0)",
  parking: "כתבו רק מספר, למשל 1 (אין = 0)", deal: "כתבו ״למכירה״ או ״להשכרה״",
};
function invalid(field, attempt = 1) {
  if (attempt < 2 || !EXAMPLES[field]) return { text: `לא הצלחתי להבין את ה${LABELS[field]}. ${QUESTIONS[field]}` };
  const skip = REQUIRED.has(field) ? "" : "\nאו ״דלג״ כדי להמשיך בלי.";
  return { text: `עדיין לא הבנתי 🙏 ${EXAMPLES[field]}.${skip}` };
}
function required(field) { return { text: `${LABELS[field]} הוא שדה חובה לדף. ${QUESTIONS[field]}` }; }

function headline(f) {
  const where = f.neighborhood || f.city;
  const parts = [];
  if (f.rooms) parts.push(`${f.rooms} חד׳${where ? ` ${inPlace(where)}` : ""}`);
  else if (where) parts.push(where);
  if (f.price) parts.push(money(f.price, f.currency));
  return parts.join(", ");
}

// What was read, spelled out (address and city too) so a wrong field is caught here, not on the live page.
function understood(f) {
  const where = [f.address, f.neighborhood && f.city ? f.city : null].filter(Boolean);
  return [headline(f), ...where].filter(Boolean).join(" · ");
}
function opened(kind, fields) {
  if (kind === "keyword") return { text: "מתחילים דף נכס חדש 🏠 אשאל כמה שאלות קצרות." };
  const h = understood(fields || {});
  if (!h) return { text: "קראתי את המודעה אבל לא מצאתי בה פרטים ברורים. נשלים ביחד." };
  return { text: `קראתי את המודעה: ${h}.\nמשהו לא נכון? כתבו למשל ״/עיר באר שבע״. אשלים איתך את מה שחסר.` };
}

// Photos with no caption and no property open: ask once what they are for, instead of editing them all.
function photoChoice(n) {
  const all = n === 1 ? "לשפר את התמונה" : `לשפר את כל ${n} התמונות (${n} עריכות)`;
  const lines = ["1 · דף נכס חדש", "2 · להוסיף לדף נכס קיים", `3 · ${all}`];
  if (n > 3) lines.push("4 · לשפר 3 לדוגמה");
  return { text: `קיבלתי ${n === 1 ? "תמונה" : `${n} תמונות`} 📸 מה לעשות?\n${lines.join("\n")}\nאו כתבו מה לשנות בתמונות.` };
}
// "חסרים פרטים?" / "סיימת?" in the middle of the questions: where things stand.
function progress(missingFields, photos) {
  const need = missingFields.map((f) => LABELS[f]);
  if (photos < MIN_PHOTOS) need.push(`תמונות (יש ${photos}, צריך ${MIN_PHOTOS})`);
  return { text: need.length ? `עוד חסר: ${need.join(" · ")}. תמונות אפשר לשלוח בכל שלב 📸` : "יש לי הכול ✅" };
}
function swapPhotos(oldN, newN) {
  return { text: `להחליף את ${oldN} התמונות הקודמות ב-${newN} החדשות, או להוסיף אותן?`, buttons: ["להחליף", "להוסיף"] };
}
function sendReplacements(n) { return { text: `שלחו את התמונות החדשות — הן יחליפו את ${n} הקיימות 📸` }; }
function recovered(hadAd, photos) {
  const what = [hadAd ? "את פרטי הנכס מהמודעה" : null, photos ? `${photos} תמונות` : null].filter(Boolean).join(" ו-");
  return { text: `בונים דף נכס 🏠 אספתי מהשיחה ${what}.` };
}
function duplicatePage(title) {
  return { text: `יש לך כבר דף לנכס הזה: ${title}. לעדכן את הדף הקיים (תמונות ופרטים), או ליצור דף חדש?`, buttons: ["לעדכן את הקיים", "דף חדש"] };
}
function useEdited(n) {
  return { text: `להשתמש ב-${n === 1 ? "תמונה שערכתי" : `${n} התמונות שערכתי`} קודם לנכס הזה?`, buttons: ["כן", "לא"] };
}
function pagePhotosAsk(title, had, got) {
  return { text: `לעדכן את התמונות בדף ${title}: להחליף את ${had} התמונות הקיימות ב-${got} החדשות, או להוסיף אותן?`, buttons: ["להחליף", "להוסיף"] };
}
function pagePhotosDone(n, editUrl) { return { text: `עדכנתי ✅ בדף יש עכשיו ${n} תמונות.\nלסידור או לשינויים נוספים: ${editUrl}` }; }
function backToDraft() { return { text: "חוזרים לנכס שבטיפול:" }; }
function noPages() { return { text: "עוד אין לך דפי נכס. לדף חדש מהתמונות ענו 1." }; }
function noUpdate() { return { text: "בסדר, לא מעדכנת כלום 🙂" }; }
function sendForEdit() { return { text: "בשמחה ✨ שלחו את התמונות לעריכה 📸" }; }
function stopped() { return { text: "עצרתי ✋ לא אערוך תמונות נוספות." }; }

function offer(n) { return { text: n === 1 ? "ערכתי תמונה אחת ✨ לבנות ממנה דף נכס?" : `ערכתי ${n} תמונות ✨ לבנות מהן דף נכס?`, buttons: ["כן", "לא"] }; }
function askPhotos() { return { text: `עכשיו התמונות 📸 שלחו לפחות ${MIN_PHOTOS} תמונות של הנכס.` }; }
function photosProgress(n) {
  if (n < MIN_PHOTOS) return { text: `יש לי ${count(n, "תמונה אחת", "תמונות")}. צריך לפחות ${MIN_PHOTOS} — שלחו עוד.` };
  return { text: `יש לי ${n} תמונות. עוד תמונות, או ממשיכים?`, buttons: ["ממשיכים"] };
}
function photosSaved(n, dropped = 0) {
  return { text: `שמרתי ${count(n, "תמונה אחת", "תמונות")} לנכס.` + (dropped ? ` (${dropped} לא נשמרו — המקסימום הוא 54)` : "") };
}

function summaryLines(s) {
  const lines = [];
  if (s.rooms) lines.push(`${s.rooms} חד׳`);
  if (s.city) lines.push(s.neighborhood ? `${s.neighborhood}, ${s.city}` : s.city);
  if (s.price) lines.push(money(s.price, s.currency));
  if (s.deal) lines.push(s.deal === "rent" ? "להשכרה" : "למכירה");
  if (s.size_sqm) lines.push(`${s.size_sqm} מ״ר`);
  if (s.floor !== null && s.floor !== undefined) lines.push(`קומה ${s.floor}`);
  if (s.parking) lines.push(count(s.parking, "חניה אחת", "חניות"));
  lines.push(count(s.photos, "תמונה אחת", "תמונות"));
  return lines.join(" · ");
}
function choose() {
  return {
    text: "כל הפרטים והתמונות אצלי ✅\nלראות תצוגה מקדימה ולערוך לפני היצירה, או ליצור את הדף עכשיו?\n" +
      "שימו לב: ״ליצור״ בונה את הדף מיד, בלי תצוגה מקדימה.",
    buttons: ["תצוגה מקדימה", "ליצור"],
  };
}
function reviewReady(link, skipped = []) {
  const names = skipped.filter((f) => LABELS[f]).map((f) => LABELS[f]);
  const note = names.length ? `\nדילגתם על: ${names.join(", ")}. אפשר להשלים בדף, או כאן — למשל /${LABELS[skipped[0]]} …` : "";
  return { text: `כל הפרטים מוכנים ✅\nבדקו, ערכו אם צריך ובנו את דף הנכס כאן:\n${link}${note}` };
}
function previewOnly(link) { return { text: `בחרתם תצוגה מקדימה — היצירה ממשיכה בדף:\n${link}` }; }

// ── corrections ──
const CODES = { city: "c", price: "p", currency: "u", rooms: "r", deal: "d", size_sqm: "s", floor: "f", parking: "k", neighborhood: "n", description: "t", template: "x" };
function show(field, v, cur) {
  if (field === "currency") return symbol(v); // unset is ₪
  if (v === null || v === undefined) return "—";
  if (field === "price") return money(v, cur);
  if (field === "deal") return v === "rent" ? "להשכרה" : "למכירה";
  if (field === "description") return String(v).slice(0, 40) + (String(v).length > 40 ? "…" : "");
  return String(v);
}
function fieldList(fields) {
  const lines = Object.keys(CODES).map((f) => `/${LABELS[f]} (/${CODES[f]}): ${show(f, fields[f], fields.currency)}`);
  return { text: `לתיקון כתבו / ושם השדה, למשל /מחיר 2.1 מיליון\n${lines.join("\n")}` };
}
function unknownField(name) { return { text: `לא מכירה את השדה ״${name}״. כתבו / לרשימת השדות.` }; }
function updated(changes, cur = changes.currency) {
  // Parking reads as a phrase ("חניה אחת"), not "חניות 1".
  const part = ([f, v]) => (f === "parking" && v ? count(v, "חניה אחת", "חניות") : `${LABELS[f]} ${show(f, v, cur)}`);
  return { text: `עדכנתי: ${Object.entries(changes).map(part).join(", ")} ✅` };
}
function confirmChanges(changes, fields) {
  const list = Object.entries(changes).map(([f, v]) => `${LABELS[f]} ${show(f, fields[f], fields.currency)} ← ${show(f, v, changes.currency || fields.currency)}`).join("\n");
  return { text: `להחליף?\n${list}`, buttons: ["כן", "לא"] };
}
// Links to the page editor for an existing page (or a few, when the message named none).
function editLinks(links) {
  if (links.length === 1) {
    return { text: `לעדכון ${links[0].title}: שלחו כאן את התמונות החדשות 📸, או כתבו מה לשנות (למשל ״מחיר 1.9 מיליון״).\nסרטון משלכם ושאר העריכה — בעורך הדף:\n${links[0].url}` };
  }
  return { text: `איזה נכס לעדכן? כל קישור פותח את עורך הדף:\n${links.map((l) => `• ${l.title}\n${l.url}`).join("\n")}` };
}
function editHeld(links) {
  const where = links.length === 1 ? links[0].url : links.map((l) => `• ${l.title}\n${l.url}`).join("\n");
  return { text: `לא ערכתי את התמונות 🙂 תמונות לדף מעלים בעורך הדף:\n${where}` };
}
// A live page's change, approved before it is written.
function confirmPageChanges(title, changes, current) {
  const list = Object.entries(changes).map(([f, v]) => `${LABELS[f]} ${show(f, current[f], current.currency)} ← ${show(f, v, changes.currency || current.currency)}`).join("\n");
  return { text: `לעדכן בדף ${title}?\n${list}`, buttons: ["כן", "לא"] };
}
function pageUpdated(changes, editUrl, cur) {
  return { text: `${updated(changes, changes.currency || cur).text}\nהדף מעודכן. לעוד שינויים: ${editUrl}` };
}
// Several replies as one WhatsApp bubble; the last one's buttons are kept.
function oneBubble(replies) {
  const last = replies[replies.length - 1];
  return { text: replies.map((x) => x.text).join("\n\n"), ...(last && last.buttons ? { buttons: last.buttons } : {}) };
}
function kept() { return { text: "בסדר, השארתי כמו שהיה." }; }
function priceOff(fields) {
  const as = fields.deal === "sale" ? "מכירה" : "שכירות";
  return { text: `רגע ⚠️ ${money(fields.price, fields.currency)} נראה חריג ל${as}. אם זו טעות: /מחיר … או /עסקה …` };
}

// ── input ──
function videoSaved() { return { text: "קיבלתי את הסרטון 🎬 הדף ישתמש בו במקום סרטון שנוצר אוטומטית." }; }
function videoFailed() { return { text: "לא הצלחתי לשמור את הסרטון (MP4 עד 120MB). אפשר לנסות שוב, או להמשיך בלי — ניצור סרטון מהתמונות." }; }
function heard(transcript) { return `🎙️ שמעתי: ״${transcript}״`; }
function voiceFailed() { return { text: "לא הצלחתי לשמוע את ההקלטה 🙉 אפשר לכתוב?" }; }
function sendAsImage() { return { text: "קיבלתי קובץ, ואת זה אני לא יודעת לקרוא 📎 תמונות של הנכס שלחו כתמונות (לא כקובץ/מסמך)." }; }
function listingPhotosFailed() { return { text: "מצאתי תמונות במודעה אבל לא הצלחתי לשמור אותן 📸 אפשר לשלוח אותן כאן ישירות." }; }
function firstLinkOnly() { return { text: "קראתי את הקישור הראשון. את השני שלחו אחרי שנסיים עם הנכס הזה." }; }
function buildFailed(retry, listing = {}) {
  const which = headline(listing);
  // Resending the listing would only fail the same way (and cost again): the team looks at it.
  const head = `הדף${which ? ` (${which})` : ""} עדיין לא מוכן — הייתה תקלה ביצירת הסרטון 😕 צוות Forly בודק ויחזור אליך בהקדם 🙏`;
  return { text: retry ? `${head}\nאפשר גם לכתוב ״ליצור״ כדי לנסות שוב.` : head };
}
function outOfQuota(message) { return { text: message || "נגמרה המכסה שלך ליצירת דפים. כתבו לנו לחידוש החבילה." }; }
function building(s) { return { text: `קיבלתי! 🏠 ${headline(s)}\nאני בונה את דף הנכס — אשלח לך קישור כשהוא מוכן (כמה דקות).` }; }
function cancelled() { return { text: "ביטלתי את הטיוטה. אפשר להתחיל מחדש עם קישור, טקסט או ״נכס חדש״." }; }
function declined() { return { text: "בסדר, לא בונים דף מהתמונות האלה." }; }
function resumePrompt(s) {
  return { text: `יש לך טיוטה פתוחה: ${summaryLines(s)}.\nלהמשיך אותה, להתחיל נכס חדש, או לבטל?`, buttons: ["המשך", "חדש", "ביטול"] };
}

const SOURCE_ERRORS = {
  facebook_not_connected: "כדי לקרוא פוסטים מפייסבוק צריך קודם לחבר את עמוד הפייסבוק בפאנל.",
  page_unreadable: "את הקישור הזה אי אפשר לקרוא אוטומטית (האתר חוסם, או שהמודעה פרטית או הוסרה).",
  extract_unavailable: "יש לי תקלה זמנית בקריאת מודעות.",
};
function sourceError(code, createUrl) {
  const why = SOURCE_ERRORS[code] || SOURCE_ERRORS.page_unreadable;
  return { text: `${why}\nאפשר להדביק כאן את טקסט המודעה, לשלוח תמונות, או למלא ידנית: ${createUrl}` };
}
function extractLimit(createUrl) { return { text: `הגעת למכסת הקישורים היומית. נסו מחר, או מלאו ידנית: ${createUrl}` }; }
function createFailed(createUrl) { return { text: `משהו השתבש ביצירת הדף. נסו שוב, או מלאו ידנית: ${createUrl}` }; }
function noLinkHint(createUrl) {
  return { text: `שלחו לי קישור למודעה (יד2, מדלן, פייסבוק), את טקסט המודעה, או כתבו ״נכס חדש״.\nאפשר גם ידנית: ${createUrl}` };
}

module.exports = {
  LABELS, ask, invalid, required, opened, offer, askPhotos, photosProgress, photosSaved, choose,
  reviewReady, editLinks, editHeld, confirmPageChanges, pageUpdated, photoChoice, progress, swapPhotos, sendReplacements, recovered, duplicatePage, useEdited, pagePhotosAsk, pagePhotosDone, backToDraft, noPages, stopped, sendForEdit, noUpdate, oneBubble, building, cancelled, declined, resumePrompt, sourceError, extractLimit, createFailed, noLinkHint,
  previewOnly, fieldList, unknownField, updated, confirmChanges, kept, priceOff,
  heard, voiceFailed, sendAsImage, firstLinkOnly, listingPhotosFailed, buildFailed, outOfQuota, videoSaved, videoFailed,
};
