/*
 * admin-rules.js — the posting rules' labels, groups and form fields, shared
 * by the global rules (admin-posting.js) and one agent's own (admin-agent-panel.js).
 * The server owns the rules and their ranges (posting-safety RULES).
 */
window.FORLY_RULES = (function () {
  var GROUPS = [
    { title: "מגבלות", fields: ["daily_cap", "daily_min", "weekly_cap", "group_daily_cap", "group_global_daily_cap", "max_consecutive_failures"] },
    { title: "כפילויות", fields: ["property_group_cooldown_days", "fingerprint_window_days"] },
    { title: "שעות וקצב", fields: ["active_start", "active_end", "window1_start", "window1_end", "window2_start", "window2_end", "min_gap_minutes", "gap_jitter_pct", "long_break_pct", "day_start_jitter_min", "skip_day_pct"] },
    { title: "אחרי אזהרה מפייסבוק", fields: ["penalty_days", "penalty_cap_divisor", "halts_to_disable", "halts_window_days"] },
  ];
  var LABELS = {
    daily_cap: "פוסטים ביום לחשבון", daily_min: "מינימום פוסטים ביום לחשבון", weekly_cap: "פוסטים בשבוע לחשבון", group_daily_cap: "פוסטים ביום לקבוצה (לחשבון)",
    group_global_daily_cap: "פוסטים ביום לקבוצה (כל הסוכנים)", max_consecutive_failures: "כשלונות ברצף עד עצירה",
    property_group_cooldown_days: "ימים עד אותו נכס באותה קבוצה", fingerprint_window_days: "ימים עד אותה מודעה (מכל מקור) באותה קבוצה",
    active_start: "שעת התחלה", active_end: "שעת סיום",
    window1_start: "חלון 1 — מ", window1_end: "חלון 1 — עד", window2_start: "חלון 2 — מ", window2_end: "חלון 2 — עד",
    min_gap_minutes: "דקות בין סשנים", gap_jitter_pct: "תוספת אקראית לפער", long_break_pct: "סיכוי להפסקה ארוכה",
    day_start_jitter_min: "עיכוב אקראי לפוסט הראשון", skip_day_pct: "סיכוי ליום בלי פרסום",
    penalty_days: "ימי עונש אחרי אזהרה", penalty_cap_divisor: "המגבלות מחולקות ב־", halts_to_disable: "עצירות עד השבתת החשבון",
    halts_window_days: "בתוך כמה ימים",
  };
  // Each rule's unit, shown next to its field and in its explanation.
  var UNIT = {
    daily_cap: "פוסטים", daily_min: "פוסטים", weekly_cap: "פוסטים", group_daily_cap: "פוסטים", group_global_daily_cap: "פוסטים",
    max_consecutive_failures: "כשלונות", property_group_cooldown_days: "תאריכים", fingerprint_window_days: "תאריכים",
    active_start: "שעה (0–23)", active_end: "שעה (1–24)", window1_start: "שעה", window1_end: "שעה", window2_start: "שעה", window2_end: "שעה",
    min_gap_minutes: "דקות", gap_jitter_pct: "% מהפער", long_break_pct: "%", day_start_jitter_min: "דקות", skip_day_pct: "%",
    penalty_days: "ימים", penalty_cap_divisor: "פי", halts_to_disable: "עצירות", halts_window_days: "ימים",
  };
  // What each rule does, with its unit and an example — shown next to its ⓘ button.
  var HELP = {
    daily_cap: "מספר הפוסטים המרבי שהחשבון של הסוכן מפרסם ביום אחד (לפי תאריך בישראל), בכל הקבוצות יחד. כשמגיעים אליו — הפרסום ממשיך מחר. דוגמה: 20 = עד 20 פוסטים ביום.",
    daily_min: "אם עד סוף החלון האחרון של היום החשבון פרסם פחות מזה — הפרסום ממשיך אחרי החלון, עד חצות, עד שמגיעים למינימום (לא בשבת ובחג, ולא מעל המגבלה היומית). דוגמה: 5 = לפחות 5 פוסטים ביום. 0 = כבוי.",
    weekly_cap: "מספר הפוסטים המרבי ב־7 הימים האחרונים, בכל הקבוצות יחד. בולם שבוע עמוס גם אם כל יום לחוד בתוך המגבלה. דוגמה: 100 = עד 100 פוסטים בשבוע.",
    group_daily_cap: "מספר הפוסטים המרבי שהחשבון של הסוכן מעלה לאותה קבוצה ביום אחד — כל אחד נכס אחר. דוגמה: 3 = עד 3 נכסים שונים לאותה קבוצה ביום.",
    group_global_daily_cap: "מספר הפוסטים המרבי שנכנסים לאותה קבוצה ביום מכל הסוכנים של פורלי יחד, כדי שהקבוצה לא תוצף מאיתנו. דוגמה: 5 = לא יותר מ־5 פוסטים של פורלי בקבוצה ביום.",
    max_consecutive_failures: "אחרי כמה ניסיונות פרסום שנכשלו ברצף (בלי הצלחה ביניהם) הקמפיין נעצר, כדי שנבדוק מה קרה. דוגמה: 2 = עוצר אחרי שני כשלונות רצופים.",
    property_group_cooldown_days: "כמה תאריכים חייבים לעבור עד שאותו נכס עולה שוב לאותה קבוצה. סופרים תאריכים ולא שעות: 1 = לא פעמיים באותו תאריך (לילה ואז בוקר — מותר). דוגמה: 3 = פוסט ב־1 בחודש יכול לחזור מה־4.",
    fingerprint_window_days: "כמו הכלל הקודם, אבל לפי תוכן המודעה: אותה דירה לא תעלה לאותה קבוצה גם מסוכן אחר או מדף אחר, לפני שעברו כמה תאריכים. דוגמה: 3 = שלושה תאריכים.",
    active_start: "השעה (שעון ישראל) שממנה מותר לפרסם ביום. דוגמה: 9 = לא לפני 09:00.",
    active_end: "השעה (שעון ישראל) שעד אליה מותר לפרסם. דוגמה: 21 = לא אחרי 21:00. 24 = עד חצות.",
    window1_start: "שעת ההתחלה של חלון הפרסום הראשון. בתוך שעות הפעילות הפוסטים מתוזמנים רק בתוך החלונות. דוגמה: 10 עד 13 = רק בין 10:00 ל־13:00. אם \"מ\" גדול או שווה ל\"עד\" — החלון כבוי.",
    window1_end: "שעת הסיום של חלון הפרסום הראשון. דוגמה: 13 = עד 13:00.",
    window2_start: "שעת ההתחלה של חלון הפרסום השני (למשל ערב). אם שני החלונות כבויים — מפרסמים בכל שעות הפעילות. דוגמה: 18.",
    window2_end: "שעת הסיום של חלון הפרסום השני. דוגמה: 21 = עד 21:00.",
    min_gap_minutes: "כמה דקות לפחות בין סיום סשן פרסום אחד לתחילת הבא. בתוך סשן (עד 10 פוסטים) הפוסטים עולים ברצף, בלי המתנה ביניהם — קריאת פיד לפני הראשון ומעט אחרי האחרון. דוגמה: 120 = לפחות שעתיים בין סשנים.",
    gap_jitter_pct: "תוספת אקראית לפער בין סשנים, באחוזים מהפער, כדי שהקצב לא יהיה קבוע כמו של רובוט. דוגמה: 50 עם פער של 120 דקות = בין 120 ל־180 דקות.",
    long_break_pct: "באחוז מהפעמים הפער בין סשנים הופך להפסקה ארוכה של 3–5 שעות, כמו אדם שעסוק בעבודה. דוגמה: 5 = בערך פעם אחת מתוך 20.",
    day_start_jitter_min: "עיכוב אקראי בדקות לפוסט הראשון של היום, אחרי שעת ההתחלה, כדי שהיום לא יתחיל תמיד באותה דקה. דוגמה: 150 עם התחלה ב־9 = הפוסט הראשון בין 09:00 ל־11:30.",
    skip_day_pct: "הסיכוי באחוזים שיום שבו מותר לפרסם יעבור בלי שום פוסט, כמו אדם שלא מפרסם כל יום. דוגמה: 20 = בערך יום אחד מכל חמישה בלי פרסום. 0 = מפרסמים כל יום.",
    penalty_days: "כשפייסבוק מזהיר (הגבלת קצב או חסימת פעולה) החשבון נכנס לתקופת עונש: ביום הראשון לא מפרסמים בכלל, ובשאר הימים במגבלות מוקטנות. זה מספר הימים. דוגמה: 14.",
    penalty_cap_divisor: "בתקופת העונש המגבלות היומית והשבועית מחולקות במספר הזה. דוגמה: 2 = חצי (20 ביום הופכים ל־10).",
    halts_to_disable: "כמה עצירות מפייסבוק (אזהרה, בקשת אימות, חסימה) בתוך התקופה שבשדה הבא משביתות את החשבון לגמרי, עד שמנהל מפעיל אותו מחדש. דוגמה: 2.",
    halts_window_days: "התקופה בימים שבה סופרים את העצירות לפני השבתה. דוגמה: 30 = שתי עצירות בתוך 30 יום משביתות.",
  };
  var LIMITS = { daily_cap: 1, weekly_cap: 1, group_daily_cap: 1, group_global_daily_cap: 1, max_consecutive_failures: 1 };
  var esc = function (v) { return FLY.esc(v == null ? "" : String(v)); };
  var shown = function (f, n) { return LIMITS[f] && n === 0 ? "ללא הגבלה" : esc(n); };

  // The form: one field per rule, grouped. opts.inherit: a field left empty takes c.global (an agent), else c.default.
  function form(rules, opts) {
    opts = opts || {};
    return GROUPS.map(function (g) {
      var fields = g.fields.filter(function (f) { return rules[f]; }).map(function (f) {
        var c = rules[f], base = opts.inherit ? c.global : c.default;
        return "<label>" + '<span class="rule-name">' + esc(LABELS[f] || f) + (UNIT[f] ? ' <small class="rule-unit">(' + esc(UNIT[f]) + ")</small>" : "") + (HELP[f] ? ' <button type="button" class="rule-i" aria-label="מה זה?" aria-expanded="false" data-help="' + f + '">i</button>' : "") + "</span>" + '<input type="number" step="1" inputmode="numeric" data-rule="' + f + '" min="' + esc(c.min) + '" max="' + esc(c.max) +
          '" value="' + (c.set == null ? "" : esc(c.set)) + '" placeholder="' + esc(base) + '"><span class="posting-note">' +
          (opts.inherit ? "כללי " + shown(f, c.global) : "ברירת מחדל " + shown(f, c.default)) + " · חל: " + shown(f, c.applies) + " · " + esc(c.min) + "–" + esc(c.max) + "</span></label>";
      }).join("");
      return fields ? '<h3 class="rules-group">' + esc(g.title) + '</h3><div class="caps-grid">' + fields + "</div>" : "";
    }).join("");
  }
  // → { field: number|null } from a form, or { bad: input } for a value out of its range.
  function read(box) {
    var rules = {}, bad = null;
    Array.prototype.forEach.call(box.querySelectorAll("input[data-rule]"), function (i) {
      var v = i.value.trim();
      if (v === "") { rules[i.dataset.rule] = null; return; }
      var n = Number(v);
      if (!Number.isInteger(n) || n < Number(i.min) || n > Number(i.max)) bad = bad || i;
      rules[i.dataset.rule] = n;
    });
    return bad ? { bad: bad } : { rules: rules };
  }
  // A tap on ⓘ shows the explanation (a hover title does not exist on a phone).
  // The explanation opens right next to its button; a tap elsewhere or Esc closes it.
  var pop = null;
  var close = function () { if (pop) { pop.remove(); pop = null; } };
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest && e.target.closest(".rule-i");
    if (!b) { if (pop && !pop.contains(e.target)) close(); return; }
    e.preventDefault();
    if (pop && pop.dataset.for === b.dataset.help) return close();
    close();
    pop = document.createElement("div");
    pop.className = "rule-pop"; pop.dataset.for = b.dataset.help; pop.setAttribute("role", "tooltip");
    pop.innerHTML = "<b>" + esc(LABELS[b.dataset.help] || "") + "</b>" + (UNIT[b.dataset.help] ? " <small>(" + esc(UNIT[b.dataset.help]) + ")</small>" : "") + "<p>" + esc(HELP[b.dataset.help] || "") + "</p>";
    document.body.appendChild(pop);
    var r = b.getBoundingClientRect(), w = Math.min(320, window.innerWidth - 24);
    pop.style.width = w + "px";
    pop.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.right - w)) + "px";
    var below = r.bottom + 8, h = pop.offsetHeight;
    pop.style.top = (below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 8) : below) + "px";
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  window.addEventListener("scroll", close, true);
  return { form: form, read: read };
})();
