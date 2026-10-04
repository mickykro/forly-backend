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

// NFC, curly quotes → straight, whitespace collapsed, so "you’re" / "you're" /
// "you  re" (odd copy-paste spacing) all match the same pattern.
const norm = (s) => String(s || "").normalize("NFC").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

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
// Each code's phrases (regex sources), in priority order. TEXT_SIGNALS is
// the one-regex-per-code form; ALT_SIGNALS keeps every phrase separate so the
// echo rule (below) can judge each match on its own.
const TEXT_PHRASES = [
  ["feature_blocked", ["can't use this feature right now", "we limit how often you can do this", "לא ניתן להשתמש בתכונה"]],
  ["rate_limited", ["you're temporarily blocked from posting", "temporarily blocked from posting", "posting too fast", "נחסמת באופן זמני", "חסימה זמנית", "חסומה זמנית", "חסומים זמנית", "חסום זמנית"]],
  ["restricted", ["your account is restricted", "you're restricted from posting in groups", "החשבון שלך מוגבל"]],
  ["pending_approval", ["your post is pending approval", "will be reviewed by a group admin", "ממתין לאישור", "ייבדק על ידי מנהל"]],
  ["group_blocked", ["you can't post in this group", "you're no longer able to post in this group", "לא ניתן לפרסם בקבוצה"]],
  ["not_member", ["join (this )?group to post", "הצטרפו לקבוצה כדי לפרסם", "הצטרפות לקבוצה"]],
];
const TEXT_SIGNALS = TEXT_PHRASES.map(([code, ps]) => [code, new RegExp(`(${ps.join("|")})`, "i")]);
const ALT_SIGNALS = TEXT_PHRASES.map(([code, ps]) => [code, ps.map((p) => new RegExp(p, "gi"))]);

const SIGNAL_DISABLES = new Set(["checkpoint", "captcha", "restricted"]);
const SIGNAL_PENALISES = new Set(["rate_limited", "feature_blocked"]);
const SIGNAL_SKIPS = new Set(["group_blocked", "not_member", "pending_approval"]);

// hasCaptchaFrame is optional, structural evidence the driver (Task 18) can
// supply when it actually saw a captcha iframe — a stronger signal than any
// text on the page.
//
// Our own words, echoed back (Task 18, fix rounds 4-5). `regions` (optional):
// the text of each dialog / alert / status region SEPARATELY (the driver has
// already removed any editable content). Detection runs on each region's
// UNSTRIPPED text, one phrase match at a time, every occurrence. A match
// [s,e) is excused only when it lies wholly inside ONE contiguous piece of
// that same region, region[a,b) with a <= s, e <= b and
// b - a >= max(MIN_ECHO, (e - s) + ECHO_CONTEXT), that also occurs in the
// copy — a toast, preview or card repeating a piece of our post, with at
// least ECHO_CONTEXT characters of the copy's own words around the phrase.
// So the phrase alone is never enough, however long (a copy saying
// "You're temporarily blocked from posting" never hides Facebook's "You're
// temporarily blocked from posting in this group"); a run shared with the
// copy that only cuts into Facebook's sentence never hides it; a short
// phrase we happen to share ("הכביש חסום זמנית" vs "אתה חסום זמנית מפרסום")
// is never excused; a region never excuses another. The URL and a captcha
// frame are never excused; the exact captcha sentence is a whole region, so
// it has no room for context and is never excused either.
//
// Accepted (fail-safe): an echo whose phrase sits within ECHO_CONTEXT
// characters of the copy's start or end, with nothing of the copy beyond it
// in the toast, reads as a signal: a false halt, never a hidden one.
//
// Bounded: each region is cut to REGION_CAP characters and the copy to
// OWN_CAP before any matching (Facebook's system alerts are short; a
// comment-thread dialog can be megabytes), and the echo check only looks
// around actual matches.
const MIN_ECHO = 20, ECHO_CONTEXT = 10, REGION_CAP = 4000, OWN_CAP = 5000;
// Whitespace is collapsed BEFORE the raw slice (fix round 5), so a region
// that opens with thousands of blank characters still has its text read. The
// raw input is consumed in chunks until 2n collapsed characters are held, so
// the work stays bounded however long the input.
function capped(s, n) {
  const raw = String(s || ""), step = 4 * n;
  let t = "";
  for (let i = 0; i < raw.length && t.length < 2 * n; i += step) t = (t + raw.slice(i, i + step)).replace(/\s+/g, " ").trimStart();
  return norm(t.slice(0, 2 * n)).slice(0, n);
}

// Does t[s,e) sit inside a run of t that also occurs in o and is at least
// max(MIN_ECHO, (e - s) + ECHO_CONTEXT) long? (t and o already normalised;
// compared case-insensitively.)
function echoed(t, o, s, e) {
  const lt = t.toLowerCase(), lo = o.toLowerCase();
  // never mis-index when case-folding changes a length: compare exactly (a rare
  // character only makes the excuse harder to earn, never easier)
  const [T, O] = lt.length === t.length && lo.length === o.length ? [lt, lo] : [t, o];
  const len = e - s, sub = T.slice(s, e), need = Math.max(MIN_ECHO, len + ECHO_CONTEXT);
  if (!len || need > O.length || need > T.length) return false;
  for (let p = O.indexOf(sub); p !== -1; p = O.indexOf(sub, p + 1)) {
    // extend left, then right, while region and copy agree: a run of `need`
    // exists around this occurrence iff the two extents together reach it
    let l = 0, r = 0;
    while (len + l < need && s - l > 0 && p - l > 0 && T[s - l - 1] === O[p - l - 1]) l++;
    while (len + l + r < need && e + r < T.length && p + len + r < O.length && T[e + r] === O[p + len + r]) r++;
    if (len + l + r >= need) return true;
  }
  return false;
}

// Is there a match of any of `res` in region t that is NOT an echo of o?
function unexcused(t, o, res) {
  for (const re of res) {
    re.lastIndex = 0;
    for (let m = re.exec(t); m; m = re.exec(t)) {
      if (!m[0].length || !o || !echoed(t, o, m.index, m.index + m[0].length)) return true;
      re.lastIndex = m.index + 1; // every occurrence, overlapping ones included
    }
  }
  return false;
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
  const own = capped(ownText, OWN_CAP);
  const rs = regions.map((r) => capped(r, REGION_CAP)).filter(Boolean);
  // CAPTCHA_EXACT is a whole-region phrase: its match is the region itself.
  if (rs.some((r) => CAPTCHA_EXACT.test(r) && !(own && echoed(r, own, 0, r.length)))) return "captcha";
  // The first code in TEXT_SIGNALS order that any region shows wins.
  for (const [code, res] of ALT_SIGNALS) if (rs.some((r) => unexcused(r, own, res))) return code;
  return "ok";
}

module.exports = { classifySignal, echoed, capped, MIN_ECHO, ECHO_CONTEXT, REGION_CAP, OWN_CAP, SIGNAL_DISABLES, SIGNAL_PENALISES, SIGNAL_SKIPS };
