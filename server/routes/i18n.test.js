/* routes/i18n.js — which strings make the dictionary, and how it fills: cached
   entries now, the rest in the background, Hebrew and unknown languages, no key. */
process.env.ANTHROPIC_API_KEY = "test-key";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const http = require("http");
const db = require("../db");
const createRouter = require("./i18n");

const { literals } = createRouter({ db })._test;

// ── markup text and attributes; scripts as code; fragments of templates; no code, no agent data ──
{
  const html = `<html><body><h1 class="x">הנכסים שלי</h1><input placeholder="שם מלא" title="ok">
<p>a <b>לא</b> — קריאה בלבד</p><script>
  var s = "הטקסט הועתק"; var t = 'סגירה'; var u = \`טוענים את הפוסט ל\${esc(name)}…\`;
  var w = "<button class=\\"b\\">העתקה</button>"; var m = "שורה אחת\\nשורה שתיים";
  var n = \`\${iso ? \`יעלה \${x}\` : "יעלה בהקדם"}\`; var v = \`\${/^https?:\\/\\//.test(u) ? "קישור" : ""} <i>סוף</i>\`;
</script></body></html>`;
  const got = [...literals(html, true)].sort();
  assert.deepEqual(got, ["— קריאה בלבד", "הנכסים שלי", "הטקסט הועתק", "העתקה", "טוענים את הפוסט ל", "יעלה", "יעלה בהקדם", "לא", "סגירה", "קישור", "סוף", "שורה אחת", "שורה שתיים", "שם מלא"].sort());
  assert.deepEqual([...literals('x("שלום עולם"); y(\'ab\'); z("a > b")', false)], ["שלום עולם"], "a js file: strings only");
}

// ── the route: cached now, the missing ones filled behind it, one language at a time ──
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-"));
  fs.writeFileSync(path.join(dir, "index.html"), '<p>הנכסים שלי</p><script>FLY.toast("הטקסט הועתק")</script>');
  fs.writeFileSync(path.join(dir, "admin.html"), "<p>מנהל</p>"); // the console stays Hebrew
  fs.writeFileSync(path.join(dir, "x.test.js"), 'assert("בדיקה")');
  const asked = [];
  const translate = async (lang, strings) => { asked.push([lang, strings]); return lang === "ru" ? null : Object.fromEntries(strings.map((s) => [s, `${lang}:${s}`])); };
  const router = createRouter({ db, dir, translate });
  const app = express(); app.use("/api/i18n", router);
  const server = await new Promise((r) => { const s = http.createServer(app); s.listen(0, () => r(s)); });
  const get = (p) => new Promise((resolve, reject) => http.get({ port: server.address().port, path: p }, (res) => {
    let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(d), cache: res.headers["cache-control"] }));
  }).on("error", reject));

  assert.equal((await get("/api/i18n/xx")).status, 404);
  assert.deepEqual((await get("/api/i18n/he")).body, { entries: {}, pending: 0 }, "Hebrew is the source");

  const first = await get("/api/i18n/en");
  assert.deepEqual(first.body, { entries: {}, pending: 2, reason: "filling" }, "nothing cached yet; both strings on their way");
  assert.equal(first.cache, "no-store");
  await router._test.whenFilled("en");
  assert.deepEqual(asked, [["en", ["הנכסים שלי", "הטקסט הועתק"]]], "the page's strings, not the console's or a test's");
  assert.equal(JSON.parse((await db.getSetting("ui_i18n_en")).json)["הטקסט הועתק"], "en:הטקסט הועתק", "kept as one JSON string");
  const second = await get("/api/i18n/en");
  assert.deepEqual(second.body, { entries: { "הנכסים שלי": "en:הנכסים שלי", "הטקסט הועתק": "en:הטקסט הועתק" }, pending: 0 });
  assert.equal(asked.length, 1, "a cached language costs nothing");

  // A new string after a deploy: only it is asked for, the rest stays.
  const again = createRouter({ db, dir: (() => { fs.writeFileSync(path.join(dir, "new.js"), 'FLY.toast("חדש לגמרי")'); return dir; })(), translate });
  const app2 = express(); app2.use("/api/i18n", again);
  const server2 = await new Promise((r) => { const s = http.createServer(app2); s.listen(0, () => r(s)); });
  await new Promise((resolve, reject) => http.get({ port: server2.address().port, path: "/api/i18n/en" }, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject));
  await again._test.whenFilled("en");
  assert.deepEqual(asked[1], ["en", ["חדש לגמרי"]]);
  assert.equal(Object.keys(JSON.parse((await db.getSetting("ui_i18n_en")).json)).length, 3);
  server2.close();

  // A translator that answers nothing (no key, a refusal): what is cached stays, nothing is stored.
  const ru = await get("/api/i18n/ru");
  assert.equal(ru.body.pending, 2, "this router read the files before new.js existed");
  await router._test.whenFilled("ru");
  assert.equal(await db.getSetting("ui_i18n_ru"), null);

  // No key on the server: Hebrew, and the client is not told to wait.
  delete process.env.ANTHROPIC_API_KEY;
  assert.deepEqual((await get("/api/i18n/fr")).body, { entries: {}, pending: 0, reason: "no_api_key" }, "says why, for whoever opens the URL");

  server.close();
  console.log("routes/i18n.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
