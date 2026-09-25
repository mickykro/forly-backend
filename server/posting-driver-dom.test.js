/* posting-driver-proof.js's DOM reads, in real Chromium (local HTML via
   setContent — no network). Skipped, saying so, when no Chromium binary is
   found (CHROMIUM_PATH, or PLAYWRIGHT_BROWSERS_PATH / /opt/pw-browsers). */
process.env.FORLY_ENV = "local";
process.env.PROFILE_KEY = "test-profile-key";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const P = require("./posting-driver-proof");
const PD = require("./posting-driver");
const S = P.SELECTORS;

function findChromium() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers"].filter(Boolean)) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse(); } catch { continue; }
    for (const d of dirs) {
      const exe = path.join(root, d, "chrome-linux", "chrome");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

const EN = "Great flat. You're restricted from posting in groups? No! You're temporarily blocked from posting — joke";
const HE = "דירה בחיפה 4 חדרים. נחסמת באופן זמני? לא! החשבון שלך מוגבל — בדיחה";
const PLAIN = "דירה בחיפה 4 חדרים, מרפסת וחניה";
const R3 = "דירה ברחוב הנביאים. הכביש חסום זמנית בגלל עבודות, חניה בשפע";
const R3P = "דירה חדשה מקבלן. היתר הבנייה ממתין לאישור הוועדה, כניסה מיידית";
const editor = (c) => `<div contenteditable="true" role="textbox">${c.split(". ").map((s) => `<p>${s}</p>`).join("")}</div>`;

(async () => {
  const exe = findChromium();
  if (!exe) { console.log("posting-driver-dom.test.js skipped (no Chromium binary)"); return; }
  const { chromium } = require("patchright");
  let browser;
  try { browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] }); }
  catch { console.log("posting-driver-dom.test.js skipped (launch failed)"); return; }
  try {
    const page = await browser.newPage();
    const sig = async (html, copy) => { await page.setContent(`<html><body>${html}</body></html>`); return P.readSignal(page, copy); };

    // ── the copy never reads as a signal, wherever it sits ──
    for (const [label, copy, html] of [
      ["EN copy in the composer", EN, `<div role="dialog">${editor(EN)}</div>`],
      ["HE copy in the composer", HE, `<div role="dialog">${editor(HE)}</div>`],
      ["composer inside a dialog, copy echoed in a status", HE, `<div role="dialog"><h2>Create post</h2><div role="dialog">${editor(HE)}<div role="status">${HE}</div></div></div>`],
      ["composer wrapping an inner dialog/alert with the copy", EN, `<div role="dialog">${editor(EN)}<div role="dialog"><span role="alert">${EN}</span></div></div>`],
      ["a toast that IS a cut of the copy (Minor 10)", HE, `<div role="status">${HE.slice(0, 40)}…</div>`],
      ["a toast holding a cut of the copy in its own element", HE, `<div role="status">Posted: <span>${HE.slice(0, 40)}…</span></div>`],
      ["'Posted: <cut of the copy>' as plain text (round-1 Minor 10)", HE, `<div role="status">Posted: ${HE.slice(0, 40)}…</div>`],
      ["a link-preview card in the composer repeating our listing text", R3P, `<div role="dialog">${editor(R3P)}<a><div>f.ly</div><div>היתר הבנייה ממתין לאישור</div></a></div>`],
      // deferred (Task 24): a copy containing Facebook's exact sentence hides that sentence
      ["a dialog repeating a whole sentence of our copy", EN, `<div role="dialog">${editor(EN)}</div><div role="dialog">You're temporarily blocked from posting</div>`],
      ["a toast with the copy, emoji as <img alt>", `🏠 ${HE}`, `<div role="status"><img alt="🏠">${HE}</div>`],
      ["after submit: the editor gone, a preview of the copy remains", HE, `<div role="dialog"><div>${HE}</div></div>`],
    ]) assert.equal(await sig(html, copy), "ok", label);

    // ── real signals still count: the composer's chrome is read, only its editor is not ──
    for (const [label, copy, html, want] of [
      ["an inline error in the composer chrome, outside the editor", PLAIN, `<div role="dialog">${editor(PLAIN)}<div role="alert">You can't post in this group</div></div>`, "group_blocked"],
      ["a restriction dialog wrapping the composer", PLAIN, `<div role="dialog"><div>Your account is restricted</div><div role="dialog">${editor(PLAIN)}</div></div>`, "restricted"],
      ["a real block dialog beside the composer", PLAIN, `<div role="dialog">${editor(PLAIN)}</div><div role="dialog">You're temporarily blocked from posting</div>`, "rate_limited"],
      ["the same pattern, a phrase NOT in the copy", EN, `<div role="dialog">${editor(EN)}</div><div role="dialog">Your account is restricted</div>`, "restricted"],
      // fix round 3: echo toasts are stripped PER REGION — one never excuses another
      ["an echo toast next to the real alert", R3, `<div role="status">הכביש חסום זמנית בגלל עבודות</div><div role="alert">אתה חסום זמנית מפרסום בקבוצות עד מחר</div>`, "rate_limited"],
      ["span-wrapped echo toast and alert", R3, `<div role="status">פורסם: <span>הכביש חסום זמנית בגלל עבודות…</span></div><div role="alert"><span>אתה חסום זמנית מפרסום בקבוצות עד מחר</span></div>`, "rate_limited"],
      ["a real 16-character alert whose words are in our copy", "דירה יפה. נחסמת באופן זמני? לא אצלנו", `<div role="alert">נחסמת באופן זמני</div>`, "rate_limited"],
      ["a real pending alert beside an echo of our pending-sounding copy", "דירה חדשה מקבלן. היתר הבנייה ממתין לאישור הוועדה, כניסה מיידית", `<div role="status"><span>היתר הבנייה ממתין לאישור הוועדה</span></div><div role="status"><span>הפוסט שלך ממתין לאישור מנהל</span></div>`, "pending_approval"],
      ["ordinary copy sharing a short phrase (HE, rate_limited)", "דירה ברחוב הנביאים. הכביש חסום זמנית בגלל עבודות", `<div role="alert">אתה חסום זמנית מפרסום בקבוצות</div>`, "rate_limited"],
      ["ordinary copy sharing a short phrase (HE, pending)", "הנכס ממתין לאישור טאבו, כניסה מיידית", `<div role="status">הפוסט שלך ממתין לאישור מנהל הקבוצה</div>`, "pending_approval"],
      ["a short bolded fragment that is also in our copy", "הכביש חסום זמנית בגלל עבודות", `<div role="alert">אתה <b>חסום זמנית</b> מפרסום</div>`, "rate_limited"],
      ["a captcha frame is structural, whatever the copy says", "Confirm you're human", `<div role="dialog">${editor("Confirm you're human")}</div><iframe title="captcha"></iframe>`, "captcha"],
    ]) assert.equal(await sig(html, copy), want, label);

    // ── fix round 2 A: only INNERMOST composer roots count ──
    for (const [label, html, n] of [
      ["a restriction dialog wrapping the composer", `<div role="dialog"><div>Your account is restricted</div><div role="dialog">${editor(PLAIN)}</div></div>`, 1],
      ["a nested Create-post layer", `<div role="dialog" aria-label="layer"><div role="dialog" aria-label="Create post"><h2>Create post</h2>${editor(PLAIN)}</div></div>`, 1],
    ]) {
      await page.setContent(html);
      assert.equal(await P.countOf(page, S.composerRoot), n, label);
      assert.equal(await P.textOf(page, S.editor), P.norm(PLAIN), label);
    }

    // ── M5: the composer root, and what is scoped to it ──
    await page.setContent(`<div role="dialog">${editor("stale draft")}</div><div role="dialog">${editor(PLAIN)}</div>`);
    assert.equal(await P.countOf(page, S.composerRoot), 2, "two composers are seen as two");
    await page.setContent(`<div role="dialog"><div aria-label="Post" role="button">outside</div></div><div role="dialog">${editor(PLAIN)}<div aria-label="Post" role="button">ours</div></div>`);
    assert.equal(await P.countOf(page, S.composerRoot), 1);
    assert.equal(await page.locator(S.submit).count(), 1, "the Post button outside the composer is not ours");
    assert.equal(await page.locator(S.submit).first().innerText(), "ours");
    assert.equal(await P.textOf(page, S.editor), P.norm(PLAIN));

    // ── M8: typing goes through the editor even when something steals focus between words ──
    await page.setContent(`<div role="dialog"><div contenteditable="true" role="textbox" id="ed"></div></div><input id="other">
      <script>document.getElementById("ed").addEventListener("keyup", (e) => { if (e.key === " " || e.key === "Enter") document.getElementById("other").focus(); });</script>`);
    const text = "דירה בחיפה\nמרפסת גדולה וחניה";
    const x = { typingDelay: () => 0, rand: () => 0.5, wait: async () => {} };
    await PD._test.humanType(page, page.locator(S.editor).first(), text, x);
    assert.equal(await page.inputValue("#other"), "", "nothing reached the element that stole focus");
    assert.equal(await P.textOf(page, S.editor), P.norm(text), "the editor holds exactly the copy");
    // a newline is never pressed unless focus is inside the target: a focus
    // thief that wins every time makes typing stop, not type elsewhere
    await page.setContent(`<div role="dialog"><div contenteditable="true" role="textbox" id="ed"></div></div><input id="other">
      <script>document.getElementById("ed").addEventListener("focus", () => document.getElementById("other").focus());</script>`);
    await assert.rejects(PD._test.humanType(page, page.locator(S.editor).first(), "a\nb", x), (e) => e.code === "composer_focus_lost");
    assert.ok(!(await page.inputValue("#other")).includes("\n"));
  } finally {
    await browser.close();
  }
  console.log("posting-driver-dom.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
