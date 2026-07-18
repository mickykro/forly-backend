/* E2E for the in-page text edit mode ("magic edit link"). LOCAL ONLY.
 *
 * Usage:
 *   1. start the server (in-memory is fine): PORT=8787 node server/index.js
 *   2. create a page and grab edit_url from GET /api/listing-status?id=...
 *   3. npm i playwright-core (anywhere on NODE_PATH), then:
 *      CHROMIUM=/path/to/chrome node scripts/edit-mode-e2e.local.js "<edit_url>"
 *
 * Verifies: toolbar boot, token stripped from the address bar, editable
 * coverage, client-side caps, nav blocking, save round-trip, persistence on
 * the public view, zero editor traces without a token, bad-token fallback.
 */
const { chromium } = require("playwright-core");
const EDIT_URL = process.argv[2];
if (!EDIT_URL || !EDIT_URL.includes("#edit=")) { console.error("usage: node edit-mode-e2e.local.js '<page_url>#edit=<token>'"); process.exit(2); }
const PAGE_URL = EDIT_URL.split("#")[0];
const TOKEN = EDIT_URL.split("#edit=")[1];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const fails = [];
  const check = (name, ok) => { console.log((ok ? "✓" : "✗ FAIL"), name); if (!ok) fails.push(name); };

  // ── 1. edit mode boots ──
  await page.goto(EDIT_URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".edit-toolbar", { timeout: 8000 });
  check("toolbar appears", true);
  check("hash token stripped from URL", !page.url().includes("edit="));
  check("body has edit-mode class", await page.evaluate(() => document.body.classList.contains("edit-mode")));
  const editableCount = await page.evaluate(() => document.querySelectorAll('[data-edit][contenteditable]').length);
  console.log("  editable elements:", editableCount);
  check("30+ editable elements", editableCount >= 30);
  check("save disabled before edits", await page.evaluate(() => document.getElementById("etSave").disabled));

  // ── 2. edit several fields ──
  const setText = async (sel, txt) => page.evaluate(([s, t]) => {
    const el = document.querySelector(s);
    el.focus(); el.textContent = t;
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  }, [sel, txt]);
  await setText('[data-edit="hero.phrase"]', "פנטהאוז חדש,\nעם נוף לפארק.");
  await setText('[data-edit="carousel.slides.0.title"]', "מיקום שאין שני לו");
  await setText('[data-edit="cta.headline"]', "מתי נוח לכם לבקר?");
  await setText('[data-edit="texts.top_cta"]', "קביעת סיור");
  await setText('[data-edit="texts.why_kicker"]', "היתרונות");
  await setText('[data-edit="gallery.captions.1"]', "חדר רחצה מעוצב");
  check("save enabled after edits", await page.evaluate(() => !document.getElementById("etSave").disabled));

  // cap enforcement: try to overflow a 40-char field
  await setText('[data-edit="cta.button_label"]', "א".repeat(90));
  const capped = await page.evaluate(() => document.querySelector('[data-edit="cta.button_label"]').innerText.length);
  check("client cap truncates (≤40): " + capped, capped <= 40);

  // links don't navigate in edit mode
  await page.click('[data-edit="texts.top_cta"]');
  check("editable link click doesn't navigate", page.url() === PAGE_URL);

  // ── 3. save ──
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/page/edit-text")),
    page.click("#etSave"),
  ]);
  check("save → 200", resp.status() === 200);
  await page.waitForFunction(() => document.getElementById("etHint").textContent.includes("נשמר"));
  check("saved hint shown", true);
  check("save disabled again (clean)", await page.evaluate(() => document.getElementById("etSave").disabled));

  // ── 4. reload as a public visitor ──
  await page.goto(PAGE_URL, { waitUntil: "networkidle" });
  await page.waitForSelector("body:not(.is-loading)");
  const pub = await page.evaluate((t) => ({
    h1: document.querySelector(".hero-copy h1").innerText,
    h1HasEm: !!document.querySelector(".hero-copy h1 em"),
    slide0: document.querySelector("#carousel .card h3").textContent,
    ctaHead: document.querySelector(".cta-info h2").textContent,
    topCta: document.querySelector(".top-cta").textContent,
    whyKicker: document.querySelector("#why .kicker").textContent,
    cap1: document.querySelectorAll("#gal .gal-item .cap")[1] ? document.querySelectorAll("#gal .gal-item .cap")[1].textContent : "(none)",
    editables: document.querySelectorAll("[contenteditable]").length,
    toolbar: !!document.querySelector(".edit-toolbar"),
    tokenInDom: document.documentElement.outerHTML.includes(t),
  }), TOKEN);
  check("hero persisted + em markup back", pub.h1.includes("פנטהאוז חדש") && pub.h1HasEm);
  check("slide title persisted", pub.slide0 === "מיקום שאין שני לו");
  check("cta headline persisted", pub.ctaHead === "מתי נוח לכם לבקר?");
  check("texts.top_cta override applied", pub.topCta === "קביעת סיור");
  check("texts.why_kicker override applied", pub.whyKicker === "היתרונות");
  check("empty caption now set", pub.cap1.includes("חדר רחצה"));
  check("no contenteditable on public view", pub.editables === 0);
  check("no toolbar on public view", !pub.toolbar);
  check("token nowhere in public DOM", !pub.tokenInDom);

  // ── 5. wrong token → read-only + notice ──
  await page.goto("about:blank"); // force a fresh document (hash-only nav wouldn't reload)
  await page.goto(PAGE_URL + "#edit=deadbeefdeadbeefdeadbeefdeadbeef", { waitUntil: "networkidle" });
  await page.waitForSelector("body:not(.is-loading)");
  await page.waitForTimeout(400);
  const bad = await page.evaluate(() => ({
    toolbar: !!document.querySelector(".edit-toolbar"),
    notice: document.body.innerText.includes("קישור העריכה אינו תקף"),
  }));
  check("bad token: no toolbar", !bad.toolbar);
  check("bad token: notice shown", bad.notice);

  await page.screenshot({ path: "/tmp/edit-mode.png", fullPage: false });
  await browser.close();
  if (fails.length) { console.error("\nFAILURES:", fails); process.exit(1); }
  console.log("\nALL PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
