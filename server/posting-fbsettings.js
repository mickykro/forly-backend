/*
 * posting-fbsettings.js — the agent's Facebook set to stop playing videos by
 * itself (2 Oct 2026). Driver bills every byte a session moves, and the feed's
 * autoplaying videos are most of a session's traffic; "Autoplay: Off" is a
 * setting any user may choose, made once per account: in its warm-up session,
 * or — an account the operator cleared of warm-up — its first posting session.
 *
 * Best effort, never in the way: not found → noted, tried again in a later
 * session, at most MAX_TRIES times; a failure is captured for calibration on a
 * local/staging box. [Unverified] The settings page and its wording are
 * guesses until a live run (Hebrew and English both); the failure note says
 * what the page held.
 */
const shots = require("./posting-shots");

const MAX_TRIES = 3;
const URLS = ["https://www.facebook.com/settings/?tab=media", "https://www.facebook.com/settings?tab=videos"];
const AUTOPLAY = /הפעלה אוטומטית|ניגון אוטומטי|הפעלה אוטו|Autoplay|Auto-play/i;
const OFF = /^\s*(כבוי|כבויה|מושבת|לעולם לא|Off|Never)\s*$/i;

// \b is ASCII-only: a Hebrew word needs a Unicode letter check after it.
const IS_OFF = /(כבוי|Off|Never)(?!\p{L})/iu;
const due = (conn) => !!conn && !conn.facebook_autoplay_off_at && (conn.facebook_autoplay_tries || 0) < MAX_TRIES;

// In the page: the autoplay control's own text (its label and current value).
const controlText = (page) => page.evaluate((src) => {
  const re = new RegExp(src, "i");
  const el = [...document.querySelectorAll('[role="combobox"], [role="button"], select, [role="radio"], label')].find((e) => re.test(e.textContent || "") || re.test(e.getAttribute("aria-label") || ""));
  return el ? (el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 120) : null;
}, AUTOPLAY.source).catch(() => null);

// → "off" (done now or already), "not_found". guard(action) as the driver's (R2).
async function setAutoplayOff(page, guard) {
  for (const url of URLS) {
    await guard("navigate");
    const ok = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).then(() => true, () => false);
    if (!ok) continue;
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    const before = await controlText(page);
    if (!before) continue;
    if (IS_OFF.test(before.replace(AUTOPLAY, ""))) return "off";
    await page.getByText(AUTOPLAY).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    const off = page.getByRole("option", { name: OFF }).or(page.getByRole("radio", { name: OFF })).or(page.getByRole("menuitemradio", { name: OFF })).first();
    if ((await off.count().catch(() => 0)) === 0) continue;
    await off.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const after = await controlText(page);
    if (after && IS_OFF.test(after.replace(AUTOPLAY, ""))) return "off";
  }
  return "not_found";
}

// Once per account, recorded on the connection. Never throws.
async function ensureAutoplayOff(page, { phone, conn, db, guard, env } = {}) {
  if (!due(conn) || !db || typeof guard !== "function") return "skip";
  let r = "not_found";
  try { r = await setAutoplayOff(page, guard); } catch (e) { r = e && e.denied ? "denied" : "error"; }
  if (r === "off") await db.setConnection(phone, { facebook_autoplay_off_at: new Date().toISOString() }).catch(() => {});
  else if (r !== "denied") {
    await db.setConnection(phone, { facebook_autoplay_tries: (conn.facebook_autoplay_tries || 0) + 1 }).catch(() => {});
    await shots.capture(page, { kind: "settings", error_code: "autoplay_not_set", step: "settings", check: "autoplay_control", phone }, env || process.env).catch(() => {});
  }
  return r;
}

module.exports = { ensureAutoplayOff, setAutoplayOff, due, MAX_TRIES };
