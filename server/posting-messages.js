/*
 * posting-messages.js — the WhatsApp side of a campaign.
 *
 * Reached only through posting-account.say(deps, phone, kind, fallback, ...args),
 * which calls deps.messages[kind](...args) with exactly the arguments the
 * call sites pass — grep `say(` across posting-*.js for the ground truth.
 * The kinds in use today: approve, posted, paused, halted, penalty,
 * reconnect, removed, stopped, completed.
 *
 * Each is a button message { header, body, footer, buttons } (Green API
 * sendInteractiveButtons): links sit behind buttons, never in the text;
 * utils.sendWhatsAppRich falls back to the text with the links spelled out.
 *
 * Same rules as distribution/jobs.js's M: user-facing Hebrew only, vendor
 * error text NEVER, and the approval shows the EXACT copy that will go out
 * under the agent's name. Links are Task 19's signed one-tap links
 * (routes/posting-shared.js actionLink) — a tap needs no login, the token is
 * the proof. A link never carries the phone, a group name or a profile name.
 *
 * A group is named only when the campaign kept a name for it (Task 14
 * privacy); otherwise it is "קבוצה" — never its URL.
 */
const { actionLink } = require("./routes/posting-shared");

const FENCE = "──────────";
const GROUP = "קבוצה";

const when = (iso) => (iso
  ? new Date(iso).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })
  : "");

// The post's target as it reads in a sentence: never the group's URL.
const nameOf = (p) => (p && p.target === "page" ? "הדף העסקי" : p && p.group_name ? `קבוצה "${p.group_name}"` : GROUP);

// Facebook's own halt codes never reach the agent — only the class's Hebrew line.
const HALT = {
  checkpoint: "⚠️ פייסבוק ביקשה לוודא שזה אתם. הפרסום מושהה עד שתשלימו את האימות בפורלי, ואז הצוות שלנו יפעיל אותו מחדש.",
  captcha: "⚠️ פייסבוק ביקשה לוודא שזה אתם. הפרסום מושהה עד שתשלימו את האימות בפורלי, ואז הצוות שלנו יפעיל אותו מחדש.",
  restricted: "⚠️ פייסבוק הגבילה את החשבון. הפרסום מושהה — הצוות שלנו כבר בודק ויחזור אליכם.",
  suspected_compromise: "⚠️ פייסבוק זיהתה פעילות חריגה בחשבון. הפרסום מושהה עד שהצוות שלנו יבדוק את זה יחד איתכם.",
};
const HALT_DEFAULT = HALT.checkpoint;
const PENALTY = {
  rate_limited: "🐢 פייסבוק ביקשה להאט. פורלי כבר האטה את קצב הפרסום אוטומטית — נחזור לקצב הרגיל בעוד שבועיים.",
  feature_blocked: "🐢 פייסבוק חסמה זמנית את הפרסום. פורלי כבר האטה את הקצב אוטומטית — נחזור לקצב הרגיל בעוד שבועיים.",
};
const PENALTY_DEFAULT = PENALTY.rate_limited;

function build({ pageBaseUrl, authSecret }) {
  const link = (c, p, a) => actionLink({ campaignId: c, postId: p, action: a }, { authSecret, pageBaseUrl });
  const base = String(pageBaseUrl || "").replace(/\/+$/, "");
  const btn = (buttonText, url) => ({ type: "url", buttonText, url });
  const stopBtn = (c, p) => (c && c.id ? [btn("לעצירת הפרסום", link(c.id, p, "stop"))] : []);
  const publishBtn = btn("לעמוד הפרסום", `${base}/autopublish.html`);
  // A button message; never without a button (the publishing page, at least).
  const msg = (header, body, buttons, footer = "") => ({
    header: header.length > 60 ? `${header.slice(0, 59)}…` : header, body, footer,
    buttons: buttons.length ? buttons.slice(0, 3) : [publishBtn],
  });

  return {
    // A post is ready for a tap — the exact copy Forly will post under the agent's name.
    approve: (c, p) => msg(`פוסט מוכן ל${nameOf(p)}`,
      `יעלה ${when(p.scheduled_at)} — אחרי האישור שלכם.\n${FENCE}\n${p.copy}\n`,
      [btn("לאישור", link(c.id, p.id, "approve")),
        btn(p.target === "page" ? "לדילוג על הפוסט" : "לדילוג על הקבוצה", link(c.id, p.id, "skip")),
        ...stopBtn(c, p.id)],
      "לא מפרסמים בלי האישור שלכם"),

    // A post went out on its own (standing mode) — a stop button, no approval needed.
    posted: (c, p) => msg("✅ הפוסט עלה", `הפוסט עלה ל${nameOf(p)}.`,
      [...(p && /^https:\/\//.test(p.post_url || "") ? [btn("לצפייה בפוסט", p.post_url)] : []), ...stopBtn(c)]),

    // Two posts in a row didn't land: Forly paused itself rather than keep guessing.
    paused: (c) => msg("⏸ הפרסום הושהה",
      "שני פוסטים ברצף לא עלו, אז פורלי עצרה לבדוק. בדקו שאתם עדיין חברים בקבוצות, ואז אפשר להמשיך מעמוד הפרסום.",
      [publishBtn, ...stopBtn(c)]),

    // R5: the account itself was disabled by Facebook (captcha/checkpoint/restricted/suspected_compromise).
    halted: (c, code) => msg("הפרסום מושהה", HALT[code] || HALT_DEFAULT, stopBtn(c)),

    // R5: a temporary Facebook-side rate limit — Forly already slowed down on its own.
    penalty: (c, code) => msg("הפרסום הואט", PENALTY[code] || PENALTY_DEFAULT, [publishBtn]),

    // R5: the Facebook connection needs to be re-established.
    reconnect: () => msg("🔑 צריך לחבר מחדש",
      "החיבור לחשבון הפייסבוק פג. כדי שהפרסום ימשיך, צריך לחבר אותו מחדש מעמוד ההפצה.",
      [btn("לחיבור מחדש", `${base}/distribution.html`)]),

    // R5: a group admin removed a post — that group is off for a while.
    removed: () => msg("ℹ️ פוסט הוסר", "מנהלי אחת הקבוצות הסירו פוסט. לא נפרסם בקבוצה הזו בחודש הקרוב.", [publishBtn]),

    // The agent (or a one-tap link) stopped the campaign.
    stopped: () => msg("✋ הפרסום נעצר", "מה שכבר פורסם נשאר בקבוצות. אפשר להתחיל שוב מתי שתרצו, מעמוד הפרסום.", [publishBtn]),

    // Every group (and the Page, if included) got its post — nothing left to schedule.
    completed: () => msg("🎉 הפרסום הושלם", "פורלי סיימה לפרסם את הנכס בכל הקבוצות שבחרתם. אפשר להפעיל שוב אחרי שבועיים, מעמוד הפרסום.", [publishBtn]),
  };
}

module.exports = { build };
