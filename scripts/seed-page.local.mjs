/* Seed a full sample property_pages doc — EMULATOR ONLY.
   Usage:
     export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
     node scripts/seed-page.local.mjs
   Prints the page id; open http://127.0.0.1:5000 (nadlan target) /p/{id}. */
import admin from "firebase-admin";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error("Refusing to run: FIRESTORE_EMULATOR_HOST is not set (emulator only).");
  process.exit(1);
}
admin.initializeApp({projectId: "call4li"});
const db = admin.firestore();

const PAGE_ID = "seed-demo-0001";
const IMG = (n) => `https://picsum.photos/seed/forly${n}/800/1000`;

await db.collection("property_pages").doc(PAGE_ID).set({
  page_id: PAGE_ID,
  listing_id: "seed-listing-0001",
  business_phone: "972500000000",
  status: "active",
  created_at: new Date(),
  updated_at: new Date(),
  expires_at: new Date(Date.now() + 30 * 86400000),
  reminder_sent_at: null,
  extension_count: 0,
  edit_count: 0,
  agent: {
    name: "אלון פאר",
    brand_name: "PEER",
    logo_url: null,
    tagline: "Luxury Real Estate",
    phone: "972500000000",
    license: "3142871",
  },
  property: {
    title: "פנטהאוז 5 חד׳ בבבלי",
    address: "ברודצקי 12",
    neighborhood: "בבלי",
    city: "תל אביב",
    price: 14900000,
    rooms: 5,
    size_sqm: 210,
    floor: 32,
    parking: 2,
  },
  hero: {
    phrase: "החיים,\nמקומה 32.",
    video_url: "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4",
    poster_url: IMG(1),
  },
  gallery: {images: [1, 2, 3, 4, 5, 6].map((n) => ({url: IMG(n), caption: "חדר " + n}))},
  carousel: {slides: [
    {num: "01", title: "נוף שאי אפשר לשכפל", body: "קו ראשון לפארק ונוף פתוח לים — ללא בנייה עתידית חוסמת.", tag: "חזית מערבית"},
    {num: "02", title: "סטנדרט של מגדל יוקרה", body: "לובי מלון, קונסיירז׳ 24/7, בריכה וספא לדיירים בלבד.", tag: "שירותי דיירים"},
    {num: "03", title: "מומחה של השכונה", body: "47 עסקאות במגדלי בבלי בעשור האחרון.", tag: "47 עסקאות"},
    {num: "04", title: "תהליך דיסקרטי", body: "ביקורים מתואמים אישית וליווי מלא עד מסירת מפתח.", tag: "ליווי מלא"},
  ]},
  area: {
    blurb: "בבלי היא הסוד הכי גלוי של תל אביב: שכונה ירוקה ושקטה צמוד לפארק הירקון.\nבעשור האחרון הפכה למוקד מגדלי היוקרה של העיר.",
    stops: [
      {label: "פארק הירקון", minutes: "2 דק׳ הליכה"},
      {label: "נמל תל אביב והים", minutes: "6 דק׳ נסיעה"},
      {label: "הרכבת הקלה — ארלוזורוב", minutes: "7 דק׳ נסיעה"},
    ],
    stats: [
      {value: "₪68,863", label: "מחיר ממוצע למ״ר בשכונה", source_url: "https://www.ynet.co.il/economy/article/yokra14443171"},
      {value: "350 דונם", label: "פארק הירקון בפתח הבית", source_url: "https://www.madlan.co.il/"},
    ],
    map_image_url: null,
    profile_slug: "tel-aviv__bavli",
  },
  cta: {
    headline: "הצעד הבא? לראות אותו מקרוב.",
    sub: "השאירו פרטים ואלון יחזור אליכם באופן אישי לתיאום ביקור.",
    bullets: ["מענה אישי בתוך שעתיים", "ביקור בזמן שנוח לכם", "הפרטים נשארים אצלנו בלבד"],
    button_label: "תיאום ביקור בנכס",
  },
  sections: {gallery: true, carousel: true, area: true},
  view_count: 0,
  lead_count: 0,
});

console.log("Seeded page:", PAGE_ID);
process.exit(0);
