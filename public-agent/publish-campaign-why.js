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

  const Why = { FAILED, WHY, SKIPPED, STATUS, failedText, statusText, whyText };
  if (typeof module === "object" && module.exports) { module.exports = Why; return; }
  root.ForlyCampaignWhy = Why;
})(typeof window !== "undefined" ? window : globalThis);
