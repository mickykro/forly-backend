/*
 * autopublish.dom.test.js — the all-properties publishing page in a real
 * Chromium against a stub API (no network): each property's own groups,
 * the consent gate, switching a property on and off, editing its groups.
 * Skipped, saying so, when no Chromium binary is found.
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

// The dashboard: one "פרסום" button at the top, none on each property card.
{
  const html = fs.readFileSync(path.join(__dirname, "..", "public-agent", "index.html"), "utf8");
  assert.ok(html.includes('href="/autopublish.html">פרסום</a>'), "the top button");
  assert.ok(!/publish\.html\?page=' \+ p\.page_id/.test(html), "no per-property publish button");
}

(async () => {
  const exe = findChromium();
  if (!exe) { console.log("autopublish.dom.test.js skipped (no Chromium binary)"); return; }
  const { chromium } = require("patchright");
  let browser;
  try { browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] }); }
  catch { console.log("autopublish.dom.test.js skipped (launch failed)"); return; }

  const member = (id, name, o = {}) => Object.assign({ group_id: id, name, private: false, membership_state: "member", in_catalog: false, agent_policy: "explicitly_allowed", is_default: false }, o);
  const state = {
    consent: false, calls: [],
    campaigns: {}, // page_id → campaign
  };
  const settings = () => ({
    consent_version: "v1",
    permission: state.consent ? { enabled: true, consent_current: true, consent_version: "v1", default_group_ids: [], targets: ["groups"] } : { enabled: false },
    member_groups: [member("h1", "דירות להשכרה בהוד השרון"), member("k1", "דירות בכפר סבא"), member("k2", "כפר סבא נדלן"), member("x", "אסור", { agent_policy: "no_agents" })],
    hidden_group_ids: [], suggested_groups: [], pages: [], page_target_available: false,
    first_post_estimate: null, first_post_wait_reason: "browse_only", connected: true, halt_state: {},
  });
  const properties = () => [
    { page_id: "pgK", title: "3 חד׳ בכפר סבא", city: "כפר סבא", listing_type: "sale", thumb_url: null, campaign: state.campaigns.pgK || null, fit_group_ids: ["k1", "k2", "x"] },
    { page_id: "pgE", title: "4 חד׳ באילת", city: "אילת", listing_type: "sale", thumb_url: null, campaign: state.campaigns.pgE || null, fit_group_ids: [] },
  ];
  const app = express(); app.use(express.json());
  app.get("/api/posting/settings", (q, r) => r.json(settings()));
  app.get("/api/posting/properties", (q, r) => r.json({ properties: properties(), max_active: 3 }));
  app.put("/api/posting/settings", (q, r) => { state.calls.push(["put", q.body]); if (q.body.consent === true) state.consent = true; r.json({ ok: true, permission: settings().permission }); });
  app.post("/api/posting/campaigns", (q, r) => {
    state.calls.push(["create", q.body]);
    const c = { id: `c-${q.body.page_id}`, page_id: q.body.page_id, status: "running", mode: q.body.mode, groups: q.body.group_ids.map((g) => ({ group_id: g })), posts: [], wait_reason: "browse_only" };
    state.campaigns[q.body.page_id] = c;
    r.status(201).json({ campaign: c });
  });
  app.post("/api/posting/campaigns/:id/stop", (q, r) => {
    state.calls.push(["stop", q.params.id]);
    const c = Object.values(state.campaigns).find((x) => x.id === q.params.id); c.status = "stopped";
    r.json({ campaign: c });
  });
  app.use(express.static(path.join(__dirname, "..", "public-agent")));
  const srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const page = await browser.newPage();
  page.on("dialog", (d) => d.accept());
  await page.route(/fonts\.(googleapis|gstatic)/, (rt) => rt.abort());
  try {
    await page.goto(`http://127.0.0.1:${srv.address().port}/autopublish.html`);
    await page.waitForSelector("#app:not([hidden])");
    const rows = page.locator(".ap-prop");
    assert.equal(await rows.count(), 2);
    // Kfar Saba: its two usable Kfar Saba groups are picked; never the one that bars agents.
    assert.ok((await rows.nth(0).textContent()).includes("קבוצות (2)"));
    assert.ok((await rows.nth(0).textContent()).includes("כבוי"));
    // Eilat: nothing suits it — it says so.
    assert.ok((await rows.nth(1).textContent()).includes("לא מצאנו קבוצה שלכם שמתאימה לאילת"));
    assert.equal(await page.isVisible("#apSettings[open]"), true, "settings open until the consent is given");

    // Switching on without the consent: refused, the switch goes back off, nothing sent.
    await rows.nth(0).locator(".switch i").click();
    await page.waitForFunction(() => /סמנו את האישור/.test(document.getElementById("msg").textContent));
    assert.equal(await rows.nth(0).locator("[data-toggle]").isChecked(), false);
    assert.equal(state.calls.length, 0);

    // Edit Kfar Saba's groups first: drop k2.
    await rows.nth(0).locator("[data-groups]").click();
    await page.locator('input[data-page="pgK"][data-group="k2"]').uncheck();
    assert.ok((await rows.nth(0).textContent()).includes("קבוצות (1)"));

    // With the consent: settings saved, then the campaign, with THIS property's groups.
    await page.check("#apConsent");
    await rows.nth(0).locator(".switch i").click();
    await page.waitForFunction(() => /פעיל/.test(document.querySelector(".ap-prop").textContent));
    const [put, create] = state.calls;
    assert.equal(put[0], "put"); assert.equal(put[1].consent, true); assert.equal(put[1].consent_version, "v1");
    assert.equal(create[0], "create");
    assert.deepEqual([create[1].page_id, create[1].group_ids, create[1].mode, create[1].consent], ["pgK", ["k1"], "per_post", true]);
    assert.ok((await page.textContent("#apCount")).includes("1 מתוך 3"));

    // Eilat: switching on with no group opens its panel instead of starting.
    await rows.nth(1).locator(".switch i").click();
    await page.waitForFunction(() => /בחרו לפחות קבוצה אחת/.test(document.getElementById("msg").textContent));
    assert.equal(await page.locator('input[data-page="pgE"]').count(), 3, "its group list is open (usable groups only)");
    assert.equal(state.calls.filter((c) => c[0] === "create").length, 1);

    // A running property's groups: saved as a new pass — stop, then create with the new set.
    await rows.nth(0).locator("[data-groups]").click();
    await page.locator('input[data-page="pgK"][data-group="k2"]').check();
    await page.click('button[data-save="pgK"]');
    await page.waitForFunction(() => /הקבוצות נשמרו/.test(document.getElementById("msg").textContent));
    const tail = state.calls.slice(-3).map((c) => c[0]);
    assert.deepEqual(tail, ["stop", "put", "create"]);
    assert.deepEqual(state.calls[state.calls.length - 1][1].group_ids.sort(), ["k1", "k2"]);

    // Switching off: STOP.
    await rows.nth(0).locator(".switch i").click();
    await page.waitForFunction(() => /נעצר/.test(document.getElementById("msg").textContent));
    assert.equal(state.calls[state.calls.length - 1][0], "stop");
    assert.ok((await rows.nth(0).textContent()).includes("כבוי"));

    // Manual sharing and details stay per property.
    assert.equal(await rows.nth(0).locator('a:has-text("שיתוף ידני")').getAttribute("href"), "/publish.html?page=pgK");
    console.log("autopublish.dom.test.js ok");
  } finally { await browser.close(); srv.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
