/* page-translate.js: which texts go out, what comes back, and that it never breaks a page. */
const assert = require("assert");
const T = require("./page-translate");

const page = () => ({
  language: "en",
  property: { title: "4 חד׳ בפלורנטין", address: "הרצל 12", neighborhood: "פלורנטין", city: "תל אביב", tags: ["מרפסת"] },
  hero: { phrase: "בית מואר עם מרפסת" },
  carousel: { slides: [{ num: "01", title: "מטבח", body: "מטבח חדש", tag: "חדש" }] },
  gallery: { images: [{ url: "https://x/1.jpg", description: "סלון" }, { url: "https://x/2.jpg", description: "" }] },
  area: { blurb: "שכונה תוססת", stops: [{ name: "פארק", minutes: 5 }], stats: [] },
  cta: { headline: "רוצים לראות?", sub: "השאירו פרטים", bullets: ["ביקור מהיר"], button_label: "תיאום ביקור" },
  agent: { name: "שיראל כהן", brand_name: "כהן נדל״ן", tagline: "הבית הבא שלך" },
  texts: null,
});
const reply = (obj, stop = "end_turn") => ({ stop_reason: stop, content: [{ type: "text", text: JSON.stringify(obj) }] });
const fake = (fn) => ({ beta: { messages: { create: fn } } });

(async () => {
  // ── what is sent: every visible text; never tags, URLs, numbers or people's names ──
  const fields = T.collect(page());
  assert.deepEqual(Object.keys(fields).sort(), [
    "agent.tagline", "area.blurb", "area.stops.0.name", "carousel.slides.0.body", "carousel.slides.0.tag",
    "carousel.slides.0.title", "cta.bullets.0", "cta.button_label", "cta.headline", "cta.sub",
    "gallery.images.0.description", "hero.phrase", "property.address", "property.city", "property.neighborhood", "property.title",
  ].sort());

  // ── a Hebrew page whose text is all Hebrew needs no call ──
  {
    let calls = 0;
    const d = { ...page(), language: "he" };
    assert.deepEqual(await T.translatePage(d, { client: fake(async () => { calls++; }) }), { skipped: "already_in_language" });
    assert.equal(calls, 0);
  }

  // ── translated in place; place names go to place_i18n, the stored ones stay ──
  {
    let req;
    const d = page();
    const out = Object.fromEntries(Object.keys(fields).map((k) => [k, `EN:${k}`]));
    const r = await T.translatePage(d, { client: fake(async (body) => { req = body; return reply(out); }) });
    assert.deepEqual(r, { translated: Object.keys(fields).length });
    assert.equal(d.hero.phrase, "EN:hero.phrase");
    assert.equal(d.carousel.slides[0].title, "EN:carousel.slides.0.title");
    assert.equal(d.gallery.images[0].description, "EN:gallery.images.0.description");
    assert.equal(d.gallery.images[1].description, "", "an empty caption stays empty");
    assert.equal(d.area.stops[0].name, "EN:area.stops.0.name");
    assert.equal(d.area.stops[0].minutes, 5);
    assert.equal(d.cta.bullets[0], "EN:cta.bullets.0");
    assert.equal(d.property.title, "EN:property.title");
    assert.deepEqual([d.property.city, d.property.address, d.property.neighborhood], ["תל אביב", "הרצל 12", "פלורנטין"],
      "the stored place names stay: group matching and the chat bot read them");
    assert.deepEqual(d.place_i18n, { address: "EN:property.address", neighborhood: "EN:property.neighborhood", city: "EN:property.city" });
    assert.deepEqual(d.property.tags, ["מרפסת"], "tags are keys, never translated");
    assert.equal(d.agent.name, "שיראל כהן");
    // the request: one call, schema with exactly the sent keys, fallback on
    assert.deepEqual(req.output_config.format.schema.required.sort(), Object.keys(fields).sort());
    assert.equal(req.output_config.format.schema.additionalProperties, false);
    assert.equal(req.fallbacks, "default");
    assert.ok(req.betas.includes("server-side-fallback-2026-07-01"));
    assert.match(req.system, /English/);
  }

  // ── a partial reply applies what it has; unknown keys are ignored ──
  {
    const d = page();
    const r = await T.translatePage(d, { client: fake(async () => reply({ "hero.phrase": "Bright", "evil.key": "x", "cta.sub": "  " })) });
    assert.deepEqual(r, { translated: 1 });
    assert.equal(d.hero.phrase, "Bright");
    assert.equal(d.cta.sub, "השאירו פרטים", "a blank value keeps the original");
    assert.ok(!("evil" in d));
  }

  // ── fail-open: errors, refusals, truncation and junk leave the page as built ──
  for (const [client, why] of [
    [fake(async () => { throw new Error("down"); }), "error"],
    [fake(async () => reply({}, "refusal")), "refusal"],
    [fake(async () => reply({ "hero.phrase": "x" }, "max_tokens")), "bad_reply"],
    [fake(async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] })), "bad_reply"],
  ]) {
    const d = page();
    const errLog = console.error; console.error = () => {};
    const r = await T.translatePage(d, { client });
    console.error = errLog;
    assert.deepEqual(r, { skipped: why });
    assert.equal(d.hero.phrase, "בית מואר עם מרפסת");
    assert.ok(!d.place_i18n);
  }

  // ── no key, unknown language, nothing to translate ──
  {
    const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    assert.deepEqual(await T.translatePage(page()), { skipped: "no_api_key" });
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    assert.deepEqual(await T.translatePage({ ...page(), language: "xx" }), { skipped: "language" });
    assert.deepEqual(await T.translatePage({ language: "en", property: {} }), { skipped: "empty" });
  }

  console.log("page-translate.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
