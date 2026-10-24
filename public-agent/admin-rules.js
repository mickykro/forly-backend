/*
 * admin-rules.js — the posting rules' labels, groups and form fields, shared
 * by the global rules (admin-posting.js) and one agent's own (admin-agent-panel.js).
 * The server owns the rules and their ranges (posting-safety RULES).
 */
window.FORLY_RULES = (function () {
  var GROUPS = [
    { title: "מגבלות", fields: ["daily_cap", "weekly_cap", "group_daily_cap", "group_global_daily_cap", "max_consecutive_failures"] },
    { title: "כפילויות", fields: ["property_group_cooldown_days", "fingerprint_window_days"] },
    { title: "שעות וקצב", fields: ["active_start", "active_end", "window1_start", "window1_end", "window2_start", "window2_end", "min_gap_minutes", "gap_jitter_pct", "long_break_pct", "day_start_jitter_min", "skip_day_pct"] },
    { title: "אחרי אזהרה מפייסבוק", fields: ["penalty_days", "penalty_cap_divisor", "halts_to_disable", "halts_window_days"] },
  ];
  var LABELS = {
    daily_cap: "פוסטים ביום לחשבון", weekly_cap: "פוסטים בשבוע לחשבון", group_daily_cap: "פוסטים ביום לקבוצה (לחשבון)",
    group_global_daily_cap: "פוסטים ביום לקבוצה (כל הסוכנים)", max_consecutive_failures: "כשלונות ברצף עד עצירה",
    property_group_cooldown_days: "ימים עד אותו נכס באותה קבוצה", fingerprint_window_days: "ימים עד אותה מודעה (מכל מקור) באותה קבוצה",
    active_start: "שעת התחלה", active_end: "שעת סיום",
    window1_start: "חלון 1 — מ", window1_end: "חלון 1 — עד", window2_start: "חלון 2 — מ", window2_end: "חלון 2 — עד",
    min_gap_minutes: "דקות בין סשנים", gap_jitter_pct: "תוספת אקראית לפער (%)", long_break_pct: "סיכוי להפסקה ארוכה (%)",
    day_start_jitter_min: "עיכוב אקראי לפוסט הראשון (דקות)", skip_day_pct: "סיכוי ליום בלי פרסום (%)",
    penalty_days: "ימי עונש אחרי אזהרה", penalty_cap_divisor: "המגבלות מחולקות ב־", halts_to_disable: "עצירות עד השבתת החשבון",
    halts_window_days: "בתוך כמה ימים",
  };
  // What each rule does, shown by its ⓘ button.
  var HELP = {
    daily_cap: "כמה פוסטים לכל היותר החשבון של הסוכן מפרסם ביום, בכל הקבוצות יחד.",
    weekly_cap: "כמה פוסטים לכל היותר החשבון מפרסם ב־7 ימים, בכל הקבוצות יחד.",
    group_daily_cap: "כמה פוסטים לכל היותר החשבון של הסוכן מפרסם באותה קבוצה ביום (נכסים שונים).",
    group_global_daily_cap: "כמה פוסטים לכל היותר נכנסים לאותה קבוצה ביום מכל הסוכנים של פורלי יחד — כדי לא להציף קבוצה.",
    max_consecutive_failures: "אחרי כמה כשלונות פרסום ברצף הקמפיין נעצר לבדיקה.",
    property_group_cooldown_days: "אותו נכס לא יעלה שוב לאותה קבוצה לפני שעברו כמה תאריכים. 1 = לא באותו תאריך.",
    fingerprint_window_days: "אותה מודעה (גם מסוכן אחר או מדף אחר של אותו נכס) לא תעלה לאותה קבוצה לפני שעברו כמה תאריכים.",
    active_start: "מאיזו שעה ביום מותר לפרסם (שעון ישראל).",
    active_end: "עד איזו שעה ביום מותר לפרסם (שעון ישראל).",
    window1_start: "חלון פרסום ראשון: הפוסטים מתוזמנים רק בתוך החלונות. חלון שבו \"מ\" גדול או שווה ל\"עד\" — כבוי.",
    window1_end: "סוף חלון הפרסום הראשון.",
    window2_start: "חלון פרסום שני (למשל ערב). כבוי אם \"מ\" גדול או שווה ל\"עד\". בלי אף חלון — כל שעות הפעילות.",
    window2_end: "סוף חלון הפרסום השני.",
    min_gap_minutes: "כמה דקות לפחות בין סשן פרסום אחד לבא (בתוך סשן הפוסטים עולים ברצף).",
    gap_jitter_pct: "תוספת אקראית לפער בין סשנים, באחוזים מהפער — כדי שהקצב לא ייראה כמו של רובוט.",
    long_break_pct: "באיזה אחוז מהפעמים הפער בין סשנים הופך להפסקה ארוכה של 3–5 שעות, כמו אדם עם עבודה.",
    day_start_jitter_min: "עיכוב אקראי (בדקות) לפוסט הראשון של היום מאז שעת ההתחלה, כדי שהיום לא יתחיל תמיד באותה דקה.",
    skip_day_pct: "סיכוי (באחוזים) שיום פעיל יעבור בלי פרסום בכלל — כמו אדם שלא מפרסם כל יום.",
    penalty_days: "אחרי אזהרה מפייסבוק (הגבלת קצב או חסימת פעולה): כמה ימים החשבון בעונש.",
    penalty_cap_divisor: "בזמן העונש המגבלות היומיות והשבועיות מחולקות במספר הזה (2 = חצי).",
    halts_to_disable: "אחרי כמה עצירות מפייסבוק (אזהרה, אימות וכו') בתוך התקופה החשבון מושבת עד שמנהל מפעיל אותו מחדש.",
    halts_window_days: "התקופה (בימים) שבה סופרים את העצירות לפני השבתה.",
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
        return "<label>" + '<span class="rule-name">' + esc(LABELS[f] || f) + (HELP[f] ? ' <button type="button" class="rule-i" aria-label="מה זה?" title="' + esc(HELP[f]) + '" data-help="' + f + '">i</button>' : "") + "</span>" + '<input type="number" step="1" inputmode="numeric" data-rule="' + f + '" min="' + esc(c.min) + '" max="' + esc(c.max) +
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
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest && e.target.closest(".rule-i");
    if (!b) return;
    e.preventDefault();
    FLY.toast(HELP[b.dataset.help] || "");
  });
  return { form: form, read: read };
})();
