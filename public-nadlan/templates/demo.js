/* Demo payload for template previews (used when the server does not inject
   window.__PAGE__). Mirrors the /api/property-page shape. */
window.__DEMO__ = {
  page_id: "", status: "active",
  property: { title: "דירת 4 חדרים · דיזנגוף 156", address: "דיזנגוף 156", neighborhood: "הצפון הישן", city: "תל אביב–יפו", price: 8400000, rooms: 4, size_sqm: 140, floor: 7, parking: 3, listing_type: "sale" },
  agent: { name: "שלום רוזנברג", brand_name: "רוזנברג נכסים", phone: "972505555555", license: "3142871", tagline: "נדל״ן יוקרה · תל אביב", logo_url: null },
  hero: { phrase: "קו ראשון לים, שיפוץ אדריכלי מהיסוד — נכס שמגיעים אליו פעם בעשור.", video_url: "/tpl/tour.mp4", poster_url: null },
  carousel: { slides: [
    { num: "01", title: "נוף שאי אפשר לשכפל", body: "קו ראשון לים מקומה גבוהה, מרפסת שמש הפונה מערבה. את השקיעה רואים מהסלון.", tag: "חזית מערבית" },
    { num: "02", title: "שיפוץ אדריכלי מהיסוד", body: "מטבח מעוצב עם אי מרכזי, סוויטת הורים עם רחצה צמוד, מיזוג מרכזי VRF.", tag: "2023" },
    { num: "03", title: "נדיר באזור", body: "שלוש חניות בטאבו ומחסן צמוד, בבניין מטופח עם מעלית ולובי משופץ.", tag: "3 חניות בטאבו" },
    { num: "04", title: "כניסה מיידית", body: "תהליך דיסקרטי, ליווי אישי עד למסירת מפתח.", tag: "ליווי מלא" }
  ] },
  area: {
    blurb: "בין שדרות בן־גוריון לכיכר דיזנגוף, השכונה משלבת את הבאוהאוס של העיר הלבנה עם בתי הקפה והמסעדות הטובים בעיר — והים תמיד במרחק הליכה.",
    stops: [ { label: "חוף גורדון", minutes: "7 דק׳ הליכה" }, { label: "כיכר דיזנגוף", minutes: "3 דק׳ הליכה" }, { label: "פארק הירקון", minutes: "10 דק׳" }, { label: "נתיבי איילון", minutes: "6 דק׳ נסיעה" } ],
    stats: [ { value: "+42%", label: "עליית ערך בחמש השנים" }, { value: "30+", label: "מסעדות ברדיוס 500 מ׳" }, { value: "9.2", label: "דירוג בתי הספר" }, { value: "7 דק׳", label: "לים ולטיילת גורדון" } ]
  },
  cta: { headline: "הנכסים הטובים באמת לא מחכים", sub: "השאירו פרטים ונחזור אליכם עוד היום לתיאום ביקור פרטי בנכס, בדיסקרטיות מלאה.", bullets: [], button_label: "תיאום ביקור" },
  gallery: { captions: ["הסלון", "המרפסת · נוף לים", "המטבח והאי", "סוויטת ההורים", "פינת האוכל", "הכניסה"] }
};
