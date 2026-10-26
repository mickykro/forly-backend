/* A visitor's language on a property page (routes/pages.js inLanguage): only a
   multilingual page, translated once per language and kept on the doc, the
   original when the translator fails; the picker only where it applies. */
const assert = require("assert");
const express = require("express");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const createPagesRouter = require("./routes/pages");

(async () => {
  const calls = [];
  const translatePage = async (doc) => {
    calls.push(doc.language);
    if (doc.language === "ru") return { skipped: "error" };
    doc.property.title = `${doc.language.toUpperCase()}:${doc.property.title}`;
    doc.hero.phrase = `${doc.language.toUpperCase()}:${doc.hero.phrase}`;
    doc.place_i18n = { city: `${doc.language.toUpperCase()}:${doc.property.city}` };
    return { translated: 3 };
  };
  const app = express();
  app.use(express.json());
  app.use(createPagesRouter({ uploadDir: "/tmp", baseUrl: "https://srv", pageBaseUrl: "https://pg", authSecret: "s", translatePage,
    templatesDir: path.join(__dirname, "..", "public-nadlan", "templates"),
    verifySession: () => null, readToken: () => null, normalizeAuthPhone: (p) => p, adminPhones: [],
    requireAuth: () => (req, res, next) => next() }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = (id, extra) => ({ page_id: id, status: "active", business_phone: "972500000009", language: "he",
    property: { title: "4 חד׳ בבבלי", city: "תל אביב", rooms: 4 }, agent: { name: "דנה", phone: "972501234567" },
    hero: { phrase: "בית מואר", video_url: null, poster_url: null }, gallery: { images: [] }, carousel: { slides: [] }, area: {}, cta: {}, sections: {},
    theme: { template: "nocturne" }, ...extra });
  await db.savePage(page("ML1", { multilingual: true }));
  await db.savePage(page("HE1", {}));
  const api = async (q) => (await fetch(`${base}/api/property-page?${q}`)).json();

  // ── the page's own language, untouched; the picker is announced ──
  const he = await api("id=ML1");
  assert.equal(he.language, "he"); assert.equal(he.property.title, "4 חד׳ בבבלי"); assert.equal(he.multilingual, true);
  assert.deepEqual(calls, [], "no call for the page's own language");

  // ── ?lang=en: translated once, then from the doc ──
  const en = await api("id=ML1&lang=en");
  assert.deepEqual([en.language, en.property.title, en.hero.phrase, en.property.city], ["en", "EN:4 חד׳ בבבלי", "EN:בית מואר", "EN:תל אביב"], "words and places in English");
  assert.deepEqual(calls, ["en"]);
  const again = await api("id=ML1&lang=en");
  assert.equal(again.property.title, "EN:4 חד׳ בבבלי");
  assert.deepEqual(calls, ["en"], "the second visit costs nothing");
  const stored = await db.getPage("ML1");
  assert.equal(stored.property.title, "4 חד׳ בבבלי", "the doc itself stays in its language");
  assert.equal(stored.i18n.en.fields["property.title"], "EN:4 חד׳ בבבלי");
  assert.equal(stored.language, "he");

  // ── a translator that fails serves the original; an unknown language is ignored ──
  assert.equal((await api("id=ML1&lang=ru")).language, "he");
  assert.equal((await api("id=ML1&lang=xx")).language, "he");
  assert.deepEqual(calls, ["en", "ru"]);

  // ── a page not marked multilingual: never translated, no picker ──
  const plain = await api("id=HE1&lang=en");
  assert.equal(plain.language, "he"); assert.equal(plain.multilingual, false);
  assert.deepEqual(calls, ["en", "ru"]);

  // ── the rendered page carries the translated payload ──
  const html = await (await fetch(`${base}/p/ML1?lang=en`)).text();
  assert.ok(html.includes('"language":"en"') && html.includes("EN:4 חד׳ בבבלי"), "the server template is served in the visitor's language");
  assert.ok(html.includes('"multilingual":true'));

  // ── a page with no agent block shows the agent's profile, not the design's placeholder ──
  {
    const bc = require("./business-cache");
    const realGet = bc.get;
    bc.get = async (phone) => (phone === "972500000009" ? { full_name: "דנה לוי", business_name: "לוי נדל״ן", logo_url: "https://f/logo.png" } : null);
    await db.savePage(page("NA1", { agent: { name: "", phone: "" } }));
    const na = await api("id=NA1");
    assert.deepEqual([na.agent.name, na.agent.brand_name, na.agent.logo_url, na.agent.phone], ["דנה לוי", "לוי נדל״ן", "https://f/logo.png", "972500000009"]);
    const kept = await api("id=ML1");
    assert.equal(kept.agent.name, "דנה", "a page with its own agent keeps it");
    bc.get = realGet;
  }

  // ── the editor's toggle marks an older page ──
  await db.updatePage("HE1", { multilingual: true });
  assert.equal((await api("id=HE1&lang=en")).language, "en");

  server.close();

  // The picker lives in the shared template i18n; both runtimes call it.
  const tpl = (f) => fs.readFileSync(path.join(__dirname, "..", "public-nadlan", f), "utf8");
  assert.ok(tpl("templates/i18n.js").includes("function picker(data)"));
  assert.ok(tpl("templates/i18n.js").includes('localStorage.getItem(KEY)') && tpl("templates/i18n.js").includes('"forly_lang"'), "follows the dashboard's language");
  assert.ok(tpl("templates/runtime.js").includes("window.I18N.picker(DATA)"));
  assert.ok(tpl("templates/runtime.js").includes("never the design's placeholder agent"), "an empty agent field clears the template's placeholder");
  assert.ok(tpl("p/page.js").includes("window.I18N.picker(d)") && tpl("p/page.js").includes('"&lang="'));
  console.log("pages-i18n.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
