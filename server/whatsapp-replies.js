/*
 * whatsapp-replies.js — every message the property chat sends, in one place.
 * Each function returns { text, buttons? }. Button texts ARE the command words
 * property-draft.command() understands, so a tap and a typed word behave the
 * same. Green API: max 3 buttons, 25 chars each (utils.sendWhatsAppButtons).
 */
const ils = (n) => `₪${Number(n).toLocaleString("en-US")}`;

const LABELS = {
  city: "עיר", price: "מחיר", rooms: "מספר חדרים", deal: "סוג עסקה", size_sqm: "שטח במ״ר",
  floor: "קומה", parking: "חניות", neighborhood: "שכונה", description: "תיאור",
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
};
const REQUIRED = new Set(["city", "price", "rooms"]);

function ask(field) {
  const optional = !REQUIRED.has(field);
  const r = { text: QUESTIONS[field] + (optional ? "\n(או דלג)" : "") };
  if (field === "deal") r.buttons = ["למכירה", "להשכרה"];
  return r;
}
function invalid(field) { return { text: `לא הצלחתי להבין את ה${LABELS[field]}. ${QUESTIONS[field]}` }; }
function required(field) { return { text: `${LABELS[field]} הוא שדה חובה לדף. ${QUESTIONS[field]}` }; }

function headline(f) {
  const where = f.neighborhood || f.city;
  const parts = [];
  if (f.rooms) parts.push(`${f.rooms} חד׳${where ? ` ב${where}` : ""}`);
  else if (where) parts.push(where);
  if (f.price) parts.push(ils(f.price));
  return parts.join(", ");
}

function opened(kind, fields) {
  if (kind === "keyword") return { text: "מתחילים דף נכס חדש 🏠 אשאל כמה שאלות קצרות." };
  const h = headline(fields || {});
  return { text: h ? `קראתי את המודעה: ${h}. אשלים איתך את מה שחסר.` : "קראתי את המודעה אבל לא מצאתי בה פרטים ברורים. נשלים ביחד." };
}

function offer(n) { return { text: `ערכתי ${n} תמונות ✨ לבנות מהן דף נכס?`, buttons: ["כן", "לא"] }; }
function askPhotos() { return { text: "עכשיו התמונות 📸 שלחו לפחות 3 תמונות של הנכס." }; }
function photosProgress(n) {
  if (n < 3) return { text: `יש לי ${n} תמונות. צריך לפחות 3 — שלחו עוד.` };
  return { text: `יש לי ${n} תמונות. עוד תמונות, או ממשיכים?`, buttons: ["ממשיכים"] };
}
function photosSaved(n) { return { text: `שמרתי ${n} תמונות לנכס.` }; }

function summaryLines(s) {
  const lines = [];
  if (s.rooms) lines.push(`${s.rooms} חד׳`);
  if (s.city) lines.push(s.neighborhood ? `${s.neighborhood}, ${s.city}` : s.city);
  if (s.price) lines.push(ils(s.price));
  if (s.deal) lines.push(s.deal === "rent" ? "להשכרה" : "למכירה");
  if (s.size_sqm) lines.push(`${s.size_sqm} מ״ר`);
  if (s.floor !== null && s.floor !== undefined) lines.push(`קומה ${s.floor}`);
  if (s.parking) lines.push(`${s.parking} חניות`);
  lines.push(`${s.photos} תמונות`);
  return lines.join(" · ");
}
function reviewReady(link) {
  return { text: `כל הפרטים מוכנים ✅\nבדקו, ערכו אם צריך ובנו את דף הנכס כאן:\n${link}` };
}
function building(s) { return { text: `קיבלתי! 🏠 ${headline(s)}\nאני בונה את דף הנכס — אשלח לך קישור כשהוא מוכן (כמה דקות).` }; }
function cancelled() { return { text: "ביטלתי את הטיוטה. אפשר להתחיל מחדש עם קישור, טקסט או ״נכס חדש״." }; }
function declined() { return { text: "בסדר, לא בונים דף מהתמונות האלה." }; }
function resumePrompt(s) {
  return { text: `יש לך טיוטה פתוחה: ${summaryLines(s)}.\nלהמשיך אותה או להתחיל נכס חדש?`, buttons: ["המשך", "חדש"] };
}

const SOURCE_ERRORS = {
  facebook_not_connected: "כדי לקרוא פוסטים מפייסבוק צריך קודם לחבר את עמוד הפייסבוק בפאנל.",
  page_unreadable: "לא הצלחתי לקרוא את הדף בקישור. אולי המודעה פרטית או הוסרה.",
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
  LABELS, ask, invalid, required, opened, offer, askPhotos, photosProgress, photosSaved,
  reviewReady, building, cancelled, declined, resumePrompt, sourceError, extractLimit, createFailed, noLinkHint,
};
