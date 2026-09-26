/*
 * listing-driver-dom.test.js — reading a Facebook post in a real Chromium
 * (the page is served by page.route; no network). Only the post's text and
 * its own photos; not the menu, stories, feed, avatars, icons or comments.
 * Skipped, saying so, when no Chromium binary is found.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const LD = require("./listing-driver");

function findChromium() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers"].filter(Boolean)) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse(); } catch { continue; }
    for (const d of dirs) { const exe = path.join(root, d, "chrome-linux", "chrome"); if (fs.existsSync(exe)) return exe; }
  }
  return null;
}

const img = (name, px) => `<img src="https://scontent.test.fbcdn.net/v/${name}.jpg?size=${px}">`;
const MSG = 'data-ad-rendering-role="story_message"';
const PAGE = `<html><body>
  <div role="navigation">תפריט פייסבוק<br>חברים<br>קבוצות<br>${img("me-avatar", 40)}</div>
  <div role="main">
    <div>סטוריז ${img("story1", 160)} ${img("story2", 160)}</div>
    <div role="article"><div ${MSG}>פוסט אחר בפיד על פוטושופ</div>${img("feed-photo", 500)}</div>
  </div>
  <div role="dialog">
    <div>הפוסט של יונתן ${img("poster-avatar", 40)}</div>
    <div ${MSG}>להשכרה דירת 3 חדרים מרווחת בהוד השרון.<br>שכ"ד: 6800 ש"ח<span id="more" hidden><br>חניה מקורה, כניסה מיידית.</span>
      <div role="button" onclick="document.getElementById('more').hidden=false;this.remove()">ראה עוד</div></div>
    <div>${img("post1", 600)}${img("post2", 400)}<img src="https://static.xx.fbcdn.net/rsrc.php/yE/r/icon.webp?size=300"></div>
    <div role="article" aria-label="תגובה">נטלי ${img("commenter", 32)} היי מה המחיר?</div>
  </div>
</body></html>`;

(async () => {
  const exe = findChromium();
  if (!exe) { console.log("listing-driver-dom.test.js skipped (no Chromium binary)"); return; }
  const { chromium } = require("patchright");
  let browser;
  try { browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] }); }
  catch { console.log("listing-driver-dom.test.js skipped (launch failed)"); return; }
  try {
    const page = await browser.newPage();
    await page.route("https://www.facebook.com/**", (r) => r.fulfill({ contentType: "text/html; charset=utf-8", body: PAGE }));
    await page.route("https://scontent.test.fbcdn.net/**", (r) => {
      const px = Number(new URL(r.request().url()).searchParams.get("size"));
      r.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}"/>` });
    });
    await page.route("https://static.xx.fbcdn.net/**", (r) => r.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"/>` }));

    const url = "https://www.facebook.com/groups/123/posts/456/";
    const out = await LD.fromDriver({ url }, { withPage: async (o, fn) => fn(page, {}) });
    assert.equal(out.text, 'להשכרה דירת 3 חדרים מרווחת בהוד השרון.\nשכ"ד: 6800 ש"ח\nחניה מקורה, כניסה מיידית.', "only the post, opened past ראה עוד");
    assert.equal(out.description, out.text);
    const names = out.photos.map((p) => new URL(p.url).pathname.split("/").pop());
    assert.deepEqual(names, ["post1.jpg", "post2.jpg"], "the post's own photos only");

    // The same post on its own page (no dialog): the article's text and photo, not the stories.
    const solo = `<html><body><div role="main"><div>סטוריז ${img("story1", 160)}</div>
      <div role="article">${img("poster-avatar", 40)}<div ${MSG}>למכירה דירת 4 חדרים בגבעתיים</div>${img("solo-photo", 500)}
      <div role="article" aria-label="תגובה">${img("commenter", 32)} מחיר?</div></div></div></body></html>`;
    await page.unroute("https://www.facebook.com/**");
    await page.route("https://www.facebook.com/**", (r) => r.fulfill({ contentType: "text/html; charset=utf-8", body: solo }));
    const out2 = await LD.fromDriver({ url }, { withPage: async (o, fn) => fn(page, {}) });
    assert.equal(out2.text, "למכירה דירת 4 חדרים בגבעתיים");
    assert.deepEqual(out2.photos.map((p) => new URL(p.url).pathname.split("/").pop()), ["solo-photo.jpg"]);

    // No post message found: the whole page is read as before.
    await page.unroute("https://www.facebook.com/**");
    await page.route("https://www.facebook.com/**", (r) => r.fulfill({ contentType: "text/html; charset=utf-8", body: "<html><body><div role='main'>דירה 3 חדרים להשכרה בהוד השרון</div></body></html>" }));
    const out3 = await LD.fromDriver({ url }, { withPage: async (o, fn) => fn(page, {}) });
    assert.equal(out3.text, "דירה 3 חדרים להשכרה בהוד השרון");
    console.log("listing-driver-dom.test.js ok");
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
