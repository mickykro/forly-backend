/*
 * posting-signals.js — what the page is telling us, and how conservative we
 * are about believing it. Split out of posting-safety.js to keep that file
 * under its line budget; imported and re-exported from there unchanged.
 *
 * Scoped input only: the DIALOG and ALERT regions, never the feed. A member
 * who writes "אתם חסומים זמנית" in a post must not halt every Forly agent
 * who lands there — classifySignal never even accepts feed text as a field.
 *
 * Conservative about disabling: URL patterns anchor on the path from its
 * start (via `new URL`, not a substring search), so `/groups/login/` is a
 * group, not a login wall. Text patterns anchor to Facebook's own full
 * phrases, not fragments that also appear in a group's rules dialog
 * ("...security check...", "...לוודא שאת..."). `captcha` in particular
 * needs structural evidence — an iframe the driver (Task 18) actually saw,
 * passed as `hasCaptchaFrame` — or Facebook's own exact captcha sentence;
 * a page merely mentioning "verification" is not a captcha.
 */

// Curly quotes → straight, whitespace collapsed, so "you’re" / "you're" /
// "you  re" (odd copy-paste spacing) all match the same pattern.
const norm = (s) => String(s || "").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

function pathOf(url) {
  try { return new URL(String(url)).pathname; } catch { return ""; }
}

// Anchored at the start of the path, not a substring search anywhere in the
// URL — a path like /groups/login/ is a group, not a login wall.
const URL_SIGNALS = [
  ["restricted", /^\/checkpoint\/block(\/|\?|$)/i],
  ["checkpoint", /^\/checkpoint(\/|\?|$)/i],
  ["login_required", /^\/(login(\.php)?|recover)(\/|\?|$)/i],
];

// Facebook's own exact captcha sentence — not "any mention of verification".
// Structural evidence (hasCaptchaFrame, from the driver) is the other, more
// reliable route to the same code; see classifySignal below.
const CAPTCHA_EXACT = /^confirm you're human\.?$/i;

// Each pattern anchors to Facebook's own full phrase, not a loose fragment: a
// fragment like "security check" or "לוודא שאת" also appears in a group's
// own rules dialog ("every post passes a security check", "מנהלי הקבוצה
// רוצים לוודא שאתם מכירים את הכללים") and must never read as a real signal.
const TEXT_SIGNALS = [
  ["feature_blocked", /(can't use this feature right now|we limit how often you can do this|לא ניתן להשתמש בתכונה)/i],
  ["rate_limited", /(you're temporarily blocked from posting|temporarily blocked from posting|posting too fast|נחסמת באופן זמני|חסימה זמנית|חסומה זמנית|חסומים זמנית|חסום זמנית)/i],
  ["restricted", /(your account is restricted|you're restricted from posting in groups|החשבון שלך מוגבל)/i],
  ["pending_approval", /(your post is pending approval|will be reviewed by a group admin|ממתין לאישור|ייבדק על ידי מנהל)/i],
  ["group_blocked", /(you can't post in this group|you're no longer able to post in this group|לא ניתן לפרסם בקבוצה)/i],
  ["not_member", /(join (this )?group to post|הצטרפו לקבוצה כדי לפרסם|הצטרפות לקבוצה)/i],
];

const SIGNAL_DISABLES = new Set(["checkpoint", "captcha", "restricted"]);
const SIGNAL_PENALISES = new Set(["rate_limited", "feature_blocked"]);
const SIGNAL_SKIPS = new Set(["group_blocked", "not_member", "pending_approval"]);

// hasCaptchaFrame is optional, structural evidence the driver (Task 18) can
// supply when it actually saw a captcha iframe — a stronger signal than any
// text on the page.
// Our own words, echoed back (Task 18). `regions` (optional): the text of
// each dialog / alert / status region SEPARATELY (the driver has already
// removed any editable content). From each region, every maximal substring
// of at least MIN_ECHO characters that also occurs in `ownText` (the copy we
// typed) is removed — a toast, preview or card repeating a piece of our post
// — and only what REMAINS of that region is classified. A region never
// excuses another; a short phrase we happen to share ("הכביש חסום זמנית" vs
// "אתה חסום זמנית מפרסום", a real 16-character "נחסמת באופן זמני") is never
// removed. Structural evidence (the URL, a captcha frame) always counts.
const MIN_ECHO = 20;
function stripEcho(text, own, min = MIN_ECHO) {
  const t = norm(text), o = norm(own);
  if (!t || o.length < min) return t;
  const lt = t.toLowerCase(), lo = o.toLowerCase();
  if (lt.length !== t.length || lo.length !== o.length) return t; // never mis-index (rare case-folding)
  // O(n·m) longest common suffix at every (i, j); mark each maximal run >= min.
  const cut = new Uint8Array(t.length);
  let prev = new Uint16Array(o.length + 1), cur = new Uint16Array(o.length + 1);
  for (let i = 1; i <= t.length; i++) {
    let best = 0;
    for (let j = 1; j <= o.length; j++) {
      cur[j] = lt[i - 1] === lo[j - 1] ? Math.min(prev[j - 1] + 1, 65535) : 0;
      if (cur[j] > best) best = cur[j];
    }
    if (best >= min) cut.fill(1, i - best, i);
    [prev, cur] = [cur, prev];
  }
  let out = "";
  for (let i = 0; i < t.length; i++) out += cut[i] ? " " : t[i];
  return norm(out);
}

function classifyText(dialog, alert) {
  if (CAPTCHA_EXACT.test(dialog) || CAPTCHA_EXACT.test(alert)) return "captcha";
  const t = `${dialog}\n${alert}`;
  for (const [code, re] of TEXT_SIGNALS) if (re.test(t)) return code;
  return "ok";
}

function classifySignal({ landedUrl, dialogText, alertText, hasCaptchaFrame, ownText, regions } = {}) {
  const path = pathOf(landedUrl);
  for (const [code, re] of URL_SIGNALS) if (re.test(path)) return code;
  if (hasCaptchaFrame) return "captcha";
  if (!Array.isArray(regions)) return classifyText(norm(dialogText), norm(alertText));
  // Each region on its own, echo-stripped; the first code in TEXT_SIGNALS
  // order that any region shows wins (the same priority as above).
  const rest = regions.map((r) => stripEcho(r, ownText)).filter(Boolean);
  if (rest.some((r) => CAPTCHA_EXACT.test(r))) return "captcha";
  for (const [code, re] of TEXT_SIGNALS) if (rest.some((r) => re.test(r))) return code;
  return "ok";
}

module.exports = { classifySignal, stripEcho, MIN_ECHO, SIGNAL_DISABLES, SIGNAL_PENALISES, SIGNAL_SKIPS };
