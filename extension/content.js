/*
 * content.js — fills the group composer, then gets out of the way.
 *
 * Risk posture, deliberately conservative:
 *  • DEFAULT MODE IS "assist": we open the composer and type the post, then
 *    stop. A human reads it and presses Facebook's own Post button. That is a
 *    typing shortcut, not an automated poster.
 *  • Typing is chunked with pauses and preceded by scrolling/dwell, because a
 *    composer that fills instantly is the clearest automation tell there is.
 *  • Anything unexpected — no composer, a checkpoint, a block notice — stops
 *    and hands control back to the agent instead of guessing.
 *  • Nothing is scraped: we touch the composer and the post button, and read
 *    nothing else off the page.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

// Facebook's UI is localized and its DOM changes often, so every lookup is a
// list of strategies and every failure is survivable.
const LABELS = {
  composer: [/write something/i, /create a public post/i, /כתוב משהו/, /כתבו משהו/, /צור פוסט/, /כתיבת פוסט/],
  post: [/^post$/i, /^פרסם$/, /^פרסמי$/, /^פרסום$/],
};

const matchesAny = (text, patterns) => patterns.some((p) => p.test((text || "").trim()));

function findByLabel(patterns) {
  const nodes = document.querySelectorAll('[role="button"],[aria-label],button,span');
  for (const el of nodes) {
    const label = el.getAttribute("aria-label") || el.textContent;
    if (label && label.length < 80 && matchesAny(label, patterns)) {
      if (el.offsetParent !== null || el.getClientRects().length) return el;
    }
  }
  return null;
}

const findTextbox = () =>
  document.querySelector('[role="dialog"] [role="textbox"][contenteditable="true"]') ||
  document.querySelector('[role="textbox"][contenteditable="true"]');

// Facebook's editor (Lexical) ignores textContent writes; execCommand is the
// one path that produces the same internal state as real typing.
async function typeInto(el, text) {
  el.focus();
  const chunks = text.match(/[\s\S]{1,24}/g) || [];
  for (const chunk of chunks) {
    document.execCommand("insertText", false, chunk);
    await sleep(rand(35, 110));
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function blocked() {
  if (/\/checkpoint\//.test(location.pathname)) return "checkpoint";
  const body = document.body.innerText || "";
  if (/temporarily blocked|you can't post|חסום זמנית|אינך יכול לפרסם|הפעולה נחסמה/i.test(body)) {
    return "blocked_notice";
  }
  return null;
}

// ── the Forly banner: status, and the agent's own confirmation ────────────
function banner(html, buttons = []) {
  document.getElementById("forly-bar")?.remove();
  const bar = document.createElement("div");
  bar.id = "forly-bar";
  bar.setAttribute("dir", "rtl");
  bar.style.cssText = `position:fixed;z-index:2147483647;inset-inline:0;bottom:0;
    background:#17140F;color:#fff;font:14px/1.5 -apple-system,'Segoe UI',sans-serif;
    padding:12px 16px;display:flex;gap:10px;align-items:center;justify-content:center;
    flex-wrap:wrap;box-shadow:0 -6px 24px rgba(0,0,0,.35)`;
  const span = document.createElement("span");
  span.textContent = html;
  bar.appendChild(span);
  for (const b of buttons) {
    const btn = document.createElement("button");
    btn.textContent = b.label;
    btn.style.cssText = `background:${b.primary ? "#B98A2F" : "transparent"};
      color:#fff;border:1px solid ${b.primary ? "#B98A2F" : "rgba(255,255,255,.4)"};
      border-radius:100px;padding:8px 16px;font:inherit;font-weight:600;cursor:pointer`;
    btn.onclick = (e) => b.onClick(e);
    bar.appendChild(btn);
  }
  document.body.appendChild(bar);
  return bar;
}

let reported = false;
function report(status, detail) {
  if (reported) return;
  reported = true;
  chrome.runtime.sendMessage({ forly: "result", status, detail });
  document.getElementById("forly-bar")?.remove();
}

async function run(task, mode) {
  const early = blocked();
  if (early) {
    banner("פייסבוק הציגה חסימה — עוצרים כדי להגן על החשבון.");
    return report("blocked", early);
  }

  banner("Forly מכין את הפוסט…");
  // Dwell and scroll like a person who just opened a group.
  await sleep(rand(1800, 3500));
  window.scrollBy({ top: rand(200, 500), behavior: "smooth" });
  await sleep(rand(900, 1800));

  const trigger = findByLabel(LABELS.composer);
  if (!trigger) {
    banner("לא הצלחנו לפתוח את תיבת הכתיבה. אפשר להדביק ידנית — הטקסט הועתק.",
      [{ label: "פרסמתי ✓", primary: true, onClick: () => report("posted") },
       { label: "דילוג", onClick: () => report("skipped") }]);
    navigator.clipboard?.writeText(task.text).catch(() => {});
    return;
  }
  trigger.click();
  await sleep(rand(1200, 2200));

  let box = findTextbox();
  for (let i = 0; i < 10 && !box; i++) { await sleep(400); box = findTextbox(); }
  if (!box) {
    navigator.clipboard?.writeText(task.text).catch(() => {});
    banner("תיבת הכתיבה לא נמצאה. הטקסט הועתק — אפשר להדביק ולפרסם.",
      [{ label: "פרסמתי ✓", primary: true, onClick: () => report("posted") },
       { label: "דילוג", onClick: () => report("skipped") }]);
    return;
  }

  await typeInto(box, task.text);
  // A person re-reads what they wrote before posting; the pause scales with
  // how much text there is.
  await sleep(rand(1500, 2600) + Math.min(4000, task.text.length * 8));

  if (blocked()) {
    banner("פייסבוק הציגה חסימה — עוצרים.");
    return report("blocked", "blocked_after_type");
  }

  const postBtn = findByLabel(LABELS.post);

  if (mode === "auto" && postBtn) {
    // Opt-in mode. Still paced, still one group at a time, and still stops
    // on the first sign of trouble.
    banner("מפרסם…");
    await sleep(rand(2500, 5000));
    postBtn.click();
    await sleep(rand(3000, 5000));
    if (blocked()) return report("blocked", "blocked_after_post");
    return report(findTextbox() ? "failed" : "posted", "auto");
  }

  // Assist mode (default): the human presses Post. We watch for that click
  // so the agent doesn't have to confirm twice, and keep manual buttons for
  // when the DOM doesn't cooperate.
  const buttons = [
    { label: "פרסמתי ✓", primary: true, onClick: () => report("posted") },
    { label: "דילוג", onClick: () => report("skipped") },
  ];
  // When the link stays out of the post body, the agent needs it for the
  // first comment — one tap to copy, no hunting.
  if (task.comment_url) {
    buttons.unshift({
      label: "העתקת הקישור לתגובה",
      onClick: (e) => {
        navigator.clipboard?.writeText(task.comment_url).catch(() => {});
        e.target.textContent = "הועתק ✓";
      },
    });
  }
  const bar = banner(task.comment_url
    ? "הטקסט מוכן — פרסמו, ואז הדביקו את הקישור בתגובה הראשונה."
    : "הטקסט מוכן — בדקו ולחצו «פרסום» בפייסבוק.", buttons);

  if (postBtn) {
    postBtn.addEventListener("click", async () => {
      bar.firstChild.textContent = "מאמת פרסום…";
      await sleep(3500);
      if (blocked()) return report("blocked", "blocked_after_post");
      if (!findTextbox()) report("posted", "assist");
    }, { once: true });
  }
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg && msg.forly === "task") {
    reported = false;
    run(msg.task, msg.mode).catch((e) => report("failed", String(e && e.message).slice(0, 80)));
    reply({ ok: true });
  }
  return true;
});
