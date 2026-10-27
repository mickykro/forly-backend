/*
 * ui-i18n.dom.test.js — the dashboard's language layer in a real Chromium
 * against a stub /api/i18n (no network): whole strings, fragments around a
 * name, attributes, text rendered later, the switcher in the topbar, Hebrew
 * untouched. Skipped, saying so, when no Chromium binary is found.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const express = require("express");

function findChromium() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers"].filter(Boolean)) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse(); } catch { continue; }
    for (const d of dirs) { const exe = path.join(root, d, "chrome-linux", "chrome"); if (fs.existsSync(exe)) return exe; }
  }
  return null;
}

// Every agent page loads the layer; the operator console does not.
{
  const dir = path.join(__dirname, "..", "public-agent");
  for (const f of ["index", "create", "edit", "publish", "autopublish", "distribution", "groups", "portfolio", "profile", "share", "signup"]) {
    assert.ok(fs.readFileSync(path.join(dir, `${f}.html`), "utf8").includes('<script src="/ui-i18n.js" defer></script>'), `${f}.html loads ui-i18n.js`);
  }
  assert.ok(!fs.readFileSync(path.join(dir, "admin.html"), "utf8").includes("ui-i18n.js"), "admin stays Hebrew");
}

(async () => {
  const exe = findChromium();
  if (!exe) { console.log("ui-i18n.dom.test.js skipped (no Chromium binary)"); return; }
  const { chromium } = require("patchright");
  let browser;
  try { browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] }); }
  catch { console.log("ui-i18n.dom.test.js skipped (launch failed)"); return; }

  const entries = { "הנכסים שלי": "My properties", "שם מלא": "Full name", "הפוסט עלה ל": "The post went up to", "נכסים": "properties", "סגירה": "Close" };
  let served = 0;
  const app = express();
  app.get("/api/i18n/:lang", (q, r) => { served++; r.json({ entries: q.params.lang === "en" ? entries : {}, pending: 0 }); });
  app.get("/ui-i18n.js", (q, r) => r.sendFile(path.join(__dirname, "..", "public-agent", "ui-i18n.js")));
  app.get("/", (q, r) => r.type("html").send(`<!doctype html><html lang="he" dir="rtl"><head><script src="/ui-i18n.js" defer></script></head><body>
<header class="topbar"><a class="brand">FORLY</a><div class="topbar-tools"><span class="who">דנה</span></div></header>
<h1 id="h">הנכסים שלי</h1><input id="i" placeholder="שם מלא"><p id="p">הפוסט עלה לקבוצה בכפר סבא</p>
<p id="n">3 נכסים</p><pre id="pre">סגירה</pre><p id="no" translate="no">סגירה</p><button id="later"></button>
<script>setTimeout(function(){document.getElementById("later").textContent="סגירה"},50)</script></body></html>`));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const text = (page, sel) => page.$eval(sel, (el) => el.textContent);

  try {
    // Hebrew (the default): the switcher, nothing else.
    const he = await browser.newPage();
    await he.goto(base);
    await he.waitForSelector(".topbar-tools .lang-switch");
    assert.equal(await text(he, "#h"), "הנכסים שלי");
    assert.equal(served, 0, "Hebrew needs no dictionary");
    assert.equal(await he.$eval("html", (el) => el.getAttribute("dir")), "rtl");
    await he.close();

    // English: chosen the way the create form stores it.
    const en = await browser.newPage();
    await en.addInitScript(() => localStorage.setItem("forly_lang", "en"));
    await en.goto(base);
    await en.waitForFunction(() => document.getElementById("later").textContent === "Close");
    assert.equal(await text(en, "#h"), "My properties", "a whole string");
    assert.equal(await en.$eval("#i", (el) => el.placeholder), "Full name", "an attribute");
    assert.equal(await text(en, "#p"), "The post went up to קבוצה בכפר סבא", "a fragment before a name");
    assert.equal(await text(en, "#n"), "3 properties", "a fragment after a number");
    assert.equal(await text(en, "#pre"), "סגירה", "preformatted text is left alone");
    assert.equal(await text(en, "#no"), "סגירה", "translate=no is honoured");
    assert.deepEqual(await en.$eval("html", (el) => [el.lang, el.dir]), ["en", "ltr"]);
    assert.equal(await text(en, ".lang-btn"), "🇬🇧English▾");
    assert.equal(await text(en, ".who"), "דנה", "a name is not in the dictionary and stays");
    await en.close();
  } finally {
    await browser.close();
    server.close();
  }
  console.log("ui-i18n.dom.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
