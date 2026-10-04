/*
 * publish-campaign-why.js — the campaign card's "why" texts: why a post did
 * not go up (its error_code), and why a group takes no post right now
 * (GET /api/posting/campaigns/:id → blocked_groups, posting-campaign.explainGroups).
 * Loaded before publish-campaign.js; under node it is module.exports.
 * Only Hebrew per code — never a raw message.
 */
(function (root) {
  "use strict";
  const FAILED = {
    not_member: "פייסבוק הציגה \"הצטרפות לקבוצה\" — נראה שאינכם חברים בה",
    group_blocked: "פייסבוק לא מאפשרת לכם לפרסם בקבוצה הזו",
    identity_mismatch: "החשבון שהיה מחובר לא היה החשבון שלכם — לא פורסם",
    destination_mismatch: "לא הצלחנו לוודא שזו הקבוצה הנכונה — לא פורסם",
    copy_mismatch: "הטקסט בחלון הפרסום לא תאם את מה שאישרתם — לא פורסם",
    composer_not_found: "לא נמצא בקבוצה חלון לכתיבת פוסט",
    submit_unavailable: "כפתור הפרסום בפייסבוק לא היה מוכן — לא פורסם",
    navigation_failed: "דף הקבוצה לא נטען",
    markers_missing: "לא הצלחנו לקרוא את דף הקבוצה",
    selector_failure: "פייסבוק שינתה את המסך — הצוות שלנו בודק",
    media_unavailable: "לא הצלחנו להוריד את סרטון הנכס",
    media_too_large: "סרטון הנכס גדול מדי לפייסבוק (מעל 48MB)",
    media_not_found: "לא נמצא בפייסבוק הכפתור להוספת סרטון",
    media_upload_failed: "העלאת הסרטון לפייסבוק לא הסתיימה",
    reconciled_absent: "בבדיקה חוזרת הפוסט לא נמצא בקבוצה",
    login_required: "פייסבוק ביקשה להתחבר מחדש",
    checkpoint: "פייסבוק ביקשה לאמת את החשבון", captcha: "פייסבוק ביקשה לאמת את החשבון",
    restricted: "החשבון מוגבל בפייסבוק",
    rate_limited: "פייסבוק ביקשה להאט", feature_blocked: "פייסבוק ביקשה להאט",
    posting_disabled: "הפרסום כובה באמצע",
  };
  const failedText = (code) => FAILED[code] || "תקלה טכנית";

  // Which check stopped the post (error_check, posting-diag): what happened, and what to do.
  const CHECKS = {
    open_feed: "דף הבית של פייסבוק לא נטען. ננסה שוב בסבב הבא; אם זה חוזר — בדקו שהחשבון מחובר.",
    open_group: "דף הקבוצה לא נטען. ננסה שוב; אם זה חוזר — בדקו שהקבוצה עדיין קיימת ופתוחה לכם.",
    page_signal: "פייסבוק הציגה הודעה שעוצרת פעולות (אימות, הגבלה או בקשה להאט). הפרסום הושהה כדי לשמור על החשבון.",
    join_text_on_page: "בדף הקבוצה הופיע \"הצטרפות לקבוצה\". אם אתם חברים בה — רעננו את רשימת הקבוצות; ייתכן שזו קבוצה מוצעת אחרת שהופיעה בדף.",
    join_button_on_group_page: "בדף הקבוצה הופיע כפתור \"הצטרפות לקבוצה\" — פייסבוק מציגה שאינכם חברים. אם אתם חברים — רעננו את רשימת הקבוצות.",
    join_button_in_composer: "רגע לפני הפרסום הופיע \"הצטרפות לקבוצה\" — לא פרסמנו. אם אתם חברים — רעננו את רשימת הקבוצות.",
    join_button_unreadable: "לא הצלחנו לקרוא אם אתם חברים בקבוצה, ולכן לא פרסמנו. ננסה שוב.",
    group_blocked_text: "פייסבוק כתבה שאי אפשר לפרסם בקבוצה הזו מהחשבון שלכם.",
    page_unreadable: "לא הצלחנו לקרוא את דף הקבוצה, ולכן לא פרסמנו. ננסה שוב.",
    group_id_on_page: "הדף שנפתח היה של קבוצה אחרת מזו שבחרתם — לא פרסמנו.",
    group_id_unresolved: "לא הצלחנו לזהות את מספר הקבוצה בדף — לא פרסמנו.",
    group_name: "שם הקבוצה בדף לא תאם לשם שבחרתם — לא פרסמנו. אם שם הקבוצה השתנה — רעננו את רשימת הקבוצות.",
    composer_button: "לא נמצא בקבוצה הכפתור \"כתבו משהו\". ייתכן שבקבוצה הזו רק מנהלים מפרסמים.",
    editor_did_not_open: "לחצנו על \"כתבו משהו\" אבל חלון הכתיבה לא נפתח.",
    composer_count: "נפתחו כמה חלונות כתיבה במקביל (אולי טיוטה ישנה) — לא פרסמנו כדי לא לפרסם במקום הלא נכון.",
    submit_button: "כפתור \"פרסום\" לא היה זמין רגע לפני הלחיצה. לא ניסינו לפרסם ונבדוק את המסך לפני ניסיון נוסף.",
    composer_target_name: "חלון הכתיבה היה מכוון לקבוצה אחרת — לא פרסמנו.",
    header_name: "השם שמופיע בפייסבוק לא תאם לחשבון שחיברתם — ייתכן שפייסבוק מחוברת לחשבון אחר. חברו מחדש את החשבון.",
    composer_author: "הפוסט היה יוצא בשם אחר מהחשבון שלכם — לא פרסמנו. חברו מחדש את החשבון.",
    no_identity_label: "חסר אצלנו שם החשבון המחובר. חברו מחדש את החשבון.",
    copy_hash: "הטקסט לא תאם למה שאושר — לא פרסמנו. אשרו את הפוסט מחדש.",
    editor_text: "הטקסט שהוקלד בחלון הכתיבה לא יצא זהה לטקסט שאושר — לא פרסמנו.",
    typing_focus: "חלון הכתיבה איבד את הפוקוס באמצע ההקלדה — עצרנו כדי שהטקסט לא יוקלד במקום אחר.",
    video_download: "לא הצלחנו להוריד את סרטון הנכס מהשרת. בדקו שהסרטון מתנגן בדף הנכס.",
    video_attach: "לא הצלחנו לצרף את הסרטון בחלון הכתיבה של פייסבוק.",
    video_upload: "הסרטון התחיל לעלות לפייסבוק אבל ההעלאה לא הסתיימה בזמן.",
    target_address: "כתובת הקבוצה שמורה אצלנו בצורה לא תקינה. רעננו את רשימת הקבוצות.",
    target_url: "כתובת הקבוצה השתנתה מאז שתוכנן הפוסט — לא פרסמנו.", target_kind: "סוג היעד לא תאם — לא פרסמנו.", preflight: "בדיקה מקדימה נכשלה — לא פרסמנו.",
  };
  const STEPS = {
    reserved: "לפני שנפתח הדפדפן", session_started: "אחרי שנפתח הדפדפן, לפני חלון הכתיבה", composer_ready: "אחרי שנפתח חלון הכתיבה, לפני לחיצה על \"פרסום\"",
    submit_started: "בזמן הלחיצה על \"פרסום\"", verification_pending: "אחרי הלחיצה, בזמן הבדיקה שהפוסט עלה",
  };
  // The failed row's second line: what happened, where it stopped, and nothing was posted unless after Post.
  function failDetail(p) {
    if (!p || (p.status !== "failed" && p.status !== "unknown")) return "";
    const what = CHECKS[p.error_check] || "";
    const where = STEPS[p.failed_step] ? `נעצר ${STEPS[p.failed_step]}.` : "";
    return [what, where].filter(Boolean).join(" ");
  }
  const SKIPPED = {
    stopped: "בוטל בעצירה", agent: "דילגתם", not_member: "אינכם חברים בקבוצה", group_blocked: "הקבוצה לא מאפשרת פרסום",
    ineligible: "הקבוצה לא זמינה לפרסום", duplicate: "כבר פורסם שם לאחרונה", expired: "תקופת הפרסום הסתיימה",
  };
  const STATUS = {
    scheduled: "מתוכנן", pending_approval: "ממתין לאישור שלכם", posting: "מפרסמים עכשיו…", posted: "פורסם",
    pending_group_approval: "ממתין לאישור מנהלי הקבוצה", failed: "לא עלה", unknown: "בבדיקה",
  };
  const statusText = (p) => (p.status === "skipped" ? SKIPPED[p.error_code] || "דולג"
    : p.status === "failed" ? `לא עלה — ${failedText(p.error_code)}` : STATUS[p.status] || "בבדיקה");

  const WHY = {
    this_round: "כבר קיבלה פוסט בסבב הזה",
    seen_not_member: "בניסיון האחרון פייסבוק הציגה \"הצטרפות לקבוצה\". אם אתם חברים בה — רעננו את רשימת הקבוצות",
    not_member: "לא מופיעה ברשימת הקבוצות שאתם חברים בהן — רעננו את הרשימה",
    hidden: "הסתרתם את הקבוצה",
    policy: "הקבוצה לא מאפשרת פרסום של מתווכים",
    listing_type: "הקבוצה לא מתאימה לסוג העסקה של הנכס",
    group_blocked: "פייסבוק לא מאפשרת לכם לפרסם בה",
    group_penalty: "מושהית אחרי חסימה של פייסבוק",
    cooldown: "קיבלה מכם פוסט לאחרונה",
    property_cooldown: "הנכס הזה פורסם בה לאחרונה",
    group_daily_cap: "קיבלה היום מספיק פוסטים מפורלי — ממשיכים מחר",
    duplicate: "נכס זהה פורסם בה לאחרונה", duplicate_review: "נכס דומה מאוד פורסם בה לאחרונה",
    available: "פנויה — תתוזמן בדקה הקרובה",
  };
  // → "<reason>[ — שוב אפשר ב<date>]"; fmt formats an ISO date for the card.
  const whyText = (b, fmt) => {
    const t = WHY[b && b.why] || "לא זמינה כרגע";
    const until = b && b.until && typeof fmt === "function" ? fmt(b.until) : "";
    return until ? `${t} — שוב אפשר ב${until}` : t;
  };

  const Why = { FAILED, WHY, SKIPPED, STATUS, CHECKS, STEPS, failedText, statusText, whyText, failDetail };
  if (typeof module === "object" && module.exports) { module.exports = Why; return; }
  root.ForlyCampaignWhy = Why;
})(typeof window !== "undefined" ? window : globalThis);
