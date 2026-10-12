// server/admin-campaigns.dom.test.js
/* The "קמפיינים" admin tab in real Chromium against a stub API: the list
   renders, create sends the recorded consent, a refused change shows its
   Hebrew reason, stop asks first. Skips cleanly without a Chromium binary. */
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

(async () => {
  const exe = findChromium();
  if (!exe) { console.log("admin-campaigns.dom.test.js skipped (no Chromium binary)"); return; }
  const { chromium } = require("patchright");
  let browser;
  try { browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] }); }
  catch { console.log("admin-campaigns.dom.test.js skipped (launch failed)"); return; }

  const ROW = { id: "c1", ref: "acct_1", phone_tail: "…0001", agent_name: "דנה לוי", page_id: "pg1", page_title: "דירה בחיפה", status: "running",
    pause_reason: null, mode: "standing", repeat: false, repeat_days: null, targets: ["groups"], expires_at: new Date(Date.now() + 5 * 86400000 - 3600000).toISOString(), run_days: 7,
    groups: [{ group_id: "111", name: "A" }], counts: { owed: 1, posted: 0, skipped: 0 }, created_by: "agent", consent_by: { by: "agent" }, version: "v1" };
  const seen = { creates: [], patches: [], starts: [], stops: 0 };
  let cur = ROW;
  let editAnswer = { status: 409, body: { error: "stale_version" } };
  const app = express(); app.use(express.json());
  app.get("/api/admin/me", (q, r) => r.json({ ok: true }));
  app.get("/api/admin/campaigns/campaigns", (q, r) => r.json({ campaigns: [cur] }));
  app.get("/api/admin/campaigns/agents", (q, r) => r.json({ agents: [{ ref: "acct_1", phone_tail: "…0001", name: "דנה לוי" }] }));
  app.get("/api/admin/campaigns/agents/:ref/properties", (q, r) => r.json({ properties: [{ page_id: "pg1", title: "דירה בחיפה" }] }));
  let defaultsAnswer = [];
  app.get("/api/admin/campaigns/agents/:ref/groups", (q, r) => r.json({ default_group_ids: defaultsAnswer, groups: [{ group_id: "111", name: "A", url: "https://www.facebook.com/groups/111", in_catalog: true }, { group_id: "222", name: "B", url: "https://www.facebook.com/groups/222", in_catalog: true }, { group_id: "333", name: "", url: "https://www.facebook.com/groups/333", in_catalog: false }, { group_id: "555", name: "דירות בחיפה", url: "https://www.facebook.com/groups/555", in_catalog: false, real_estate: true }] }));
  const applies = [];
  app.post("/api/admin/campaigns/campaigns/c1/apply-to-all", (q, r) => { applies.push(q.body); r.json({ defaults_set: true, default_group_ids: ["111"], created: [{ page_id: "pg2" }], skipped: [{ page_id: "pg3", reason: "has_campaign" }] }); });
  let refreshes = 0; // the first refresh is refused (posting off), the second reads one more group
  app.post("/api/admin/campaigns/agents/:ref/groups/refresh", (q, r) => (++refreshes === 1 ? r.status(409).json({ error: "posting_disabled", reason: "env_off" })
    : r.json({ synced_at: "2026-10-12T09:00:00.000Z", groups: [{ group_id: "111", name: "A", in_catalog: true }, { group_id: "222", name: "B", in_catalog: true }, { group_id: "444", name: "D", in_catalog: true }] })));
  let estimateAnswer = { posts: 200, per_week: 64, days: 22, fits: true, days_left: 30, warmup: false };
  app.post("/api/admin/campaigns/estimate", (q, r) => r.json(estimateAnswer));
  let createAnswer = null; // null: 201; else { status, body } once
  app.post("/api/admin/campaigns/campaigns", (q, r) => { seen.creates.push(q.body); if (createAnswer) { const a = createAnswer; createAnswer = null; return r.status(a.status).json(a.body); } r.status(201).json({ campaign: ROW }); });
  let fitAnswer = { listing_type: "sale", fit: {} };
  app.get("/api/admin/campaigns/agents/:ref/groups/fit", (q, r) => r.json(fitAnswer));
  app.patch("/api/admin/campaigns/campaigns/c1", (q, r) => { seen.patches.push(q.body); r.status(editAnswer.status).json(editAnswer.body); });
  app.post("/api/admin/campaigns/campaigns/c1/start", (q, r) => { seen.starts.push(q.body); cur = ROW; r.json({ campaign: ROW }); });
  app.post("/api/admin/campaigns/campaigns/c1/stop", (q, r) => { seen.stops++; cur = Object.assign({}, ROW, { status: "stopped" }); r.json({ campaign: cur }); });
  app.use("/api", (q, r) => r.json({}));
  app.use(express.static(path.join(__dirname, "..", "public-agent")));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await browser.newPage();
    page.on("dialog", (d) => d.accept());
    await page.goto(`${base}/admin.html`);
    await page.click("#tabCampaigns");
    await page.waitForSelector("#campList [data-camp='c1']");
    assert.ok((await page.innerText("#campList")).includes("דנה לוי"));

    // create with recorded consent
    await page.click("#campNew");
    await page.selectOption("#campFormAgent", "acct_1");
    await page.waitForSelector("#campFormProperty option[value='pg1']", { state: "attached" });
    await page.selectOption("#campFormProperty", "pg1");
    await page.waitForSelector("#campFormGroups input[value='111']");
    await page.check("#campFormGroups input[value='111']");
    await page.waitForFunction(() => /22 ימים/.test(document.querySelector("#campFormEstimate").textContent));
    // a halted account (no posts per week): no "null days"
    estimateAnswer = { posts: 10, per_week: 0, days: null, fits: false, days_left: 30, warmup: false };
    await page.uncheck("#campFormGroups input[value='111']");
    await page.waitForFunction(() => /אי אפשר להעריך כרגע/.test(document.querySelector("#campFormEstimate").textContent));
    assert.ok(!/null|⚠️/.test(await page.textContent("#campFormEstimate")));
    estimateAnswer = { posts: 200, per_week: 64, days: 22, fits: true, days_left: 30, warmup: false };
    await page.check("#campFormGroups input[value='111']");
    await page.waitForFunction(() => /22 ימים/.test(document.querySelector("#campFormEstimate").textContent));
    await page.selectOption("#campFormConsentMethod", "phone");
    await page.fill("#campFormConsentNote", "אישר בטלפון");
    await page.click("#campFormSave");
    await page.waitForFunction(() => document.querySelector("#campForm").hidden);
    assert.equal(seen.creates.length, 1);
    assert.deepEqual(seen.creates[0].consent, { method: "phone", note: "אישר בטלפון" });
    assert.deepEqual(seen.creates[0].group_ids, ["111"]);
    assert.equal(seen.creates[0].days, 14);
    assert.equal(seen.creates[0].mode, "standing");
    assert.deepEqual(seen.creates[0].targets, ["groups"]);
    assert.equal(seen.creates[0].set_defaults, undefined, "defaults are saved only when asked");

    // the agent's default groups: a new campaign starts from them, and a create can save the chosen ones
    defaultsAnswer = ["222"];
    await page.click("#campNew");
    await page.selectOption("#campFormAgent", "acct_1");
    await page.waitForSelector("#campFormGroups input[value='222']", { state: "attached" });
    assert.equal(await page.isChecked("#campFormGroups input[value='222']"), true, "the default group is ticked");
    assert.equal(await page.isChecked("#campFormGroups input[value='111']"), false);
    assert.match(await page.textContent("#campFormGroups label:has(input[value='222'])"), /ברירת מחדל/);
    assert.match(await page.textContent("#campFormDefaultsHint"), /סומנו 1 קבוצות ברירת המחדל/);
    await page.click("#campFormNone");
    await page.click("#campFormUseDefaults");
    assert.equal(await page.isChecked("#campFormGroups input[value='222']"), true, "one click brings the defaults back");
    await page.check("#campFormGroups input[value='111']");
    await page.check("#campFormSetDefaults");
    await page.selectOption("#campFormProperty", "pg1");
    await page.fill("#campFormConsentNote", "אישר בטלפון");
    await page.click("#campFormSave");
    await page.waitForFunction(() => document.querySelector("#campForm").hidden);
    assert.equal(seen.creates[1].set_defaults, true);
    assert.deepEqual(seen.creates[1].group_ids.slice().sort(), ["111", "222"]);
    defaultsAnswer = [];

    // a property's misfits are marked with why: a blocked group is unticked and locked, a warning only shown
    fitAnswer = { listing_type: "sale", fit: { "222": { block: "listing_type", listing_types: ["rent"] }, "555": { warn: "deal_name" } } };
    await page.click("#campNew");
    await page.selectOption("#campFormAgent", "acct_1");
    await page.waitForSelector("#campFormProperty option[value='pg1']", { state: "attached" });
    await page.selectOption("#campFormProperty", "pg1");
    await page.waitForSelector("#campFormGroups .cf-bad-g input[value='222']", { state: "attached" });
    assert.match(await page.textContent("#campFormGroups label:has(input[value='222']) .cf-why"), /הקבוצה רק להשכרה — והנכס למכירה/);
    assert.equal(await page.isDisabled("#campFormGroups input[value='222']"), true);
    assert.equal(await page.isChecked("#campFormGroups input[value='222']"), false);
    assert.match(await page.textContent("#campFormGroups label:has(input[value='555']) .cf-why"), /כדאי לבדוק/);
    assert.equal(await page.isDisabled("#campFormGroups input[value='555']"), false, "a warning does not lock");
    assert.match(await page.textContent("#campFormFit"), /1 קבוצות לא מתאימות/);
    await page.click("#campFormAll");
    assert.equal(await page.isChecked("#campFormGroups input[value='222']"), false, "select-all skips a blocked group");
    // a refused save marks the groups the server named and unticks them
    fitAnswer = { listing_type: "sale", fit: {} };
    createAnswer = { status: 422, body: { error: "listing_type_not_allowed", group_ids: ["111"] } };
    await page.fill("#campFormConsentNote", "אישר בטלפון");
    await page.click("#campFormSave");
    await page.waitForSelector("#campFormGroups .cf-bad-g input[value='111']", { state: "attached" });
    assert.equal(await page.isChecked("#campFormGroups input[value='111']"), false);
    assert.match(await page.textContent("#campFormError"), /סומנו באדום 1 קבוצות שנדחו/);
    await page.click("#campFormCancel");

    // a refused edit (stale version) shows its reason, sends the row's version and the changed days, and closes the form
    await page.click("[data-camp='c1'] [data-act='edit']");
    await page.waitForSelector("#campFormGroups input[value='222']", { state: "attached" });
    assert.equal(await page.inputValue("#campFormDays"), "5", "edit prefills the remaining days, not 14");
    await page.fill("#campFormDays", "7");
    await page.click("#campFormSave");
    await page.waitForFunction(() => /השתנה/.test(document.body.innerText));
    assert.equal(seen.patches.length, 1);
    assert.equal(seen.patches[0].version, "v1");
    assert.equal(seen.patches[0].days, 7);
    await page.waitForFunction(() => document.querySelector("#campForm").hidden);

    // a successful edit of only the groups sends the group diff and no days/repeat/mode/targets
    editAnswer = { status: 200, body: { campaign: ROW } };
    await page.click("[data-camp='c1'] [data-act='edit']");
    await page.waitForSelector("#campFormGroups input[value='222']", { state: "attached" });
    assert.equal(await page.locator("#campFormGroups input[value='333']").count(), 0, "a group that doesn't read as real estate is not offered");
    assert.match(await page.textContent("#campFormGroups label:has(input[value='555'])"), /לא בקטלוג/, "a real-estate group outside the catalog is offered, tagged");
    assert.match(await page.textContent("#campFormGroupsHidden"), /עוד 1 קבוצות/);
    // refresh from Facebook: a refusal says why; a success re-lists the groups and keeps what is ticked
    assert.match(await page.textContent("#campFormSynced"), /עוד לא נקראו/);
    await page.click("#campFormRefresh");
    await page.waitForFunction(() => /הפרסום האוטומטי כבוי/.test((document.getElementById("toast") || {}).textContent || ""));
    await page.waitForFunction(() => !document.getElementById("campFormRefresh").disabled);
    await page.click("#campFormRefresh");
    await page.waitForSelector("#campFormGroups input[value='444']", { state: "attached" });
    assert.equal(await page.isChecked("#campFormGroups input[value='111']"), true, "a ticked group stays ticked");
    assert.match(await page.textContent("#campFormSynced"), /נקראו מפייסבוק ב-/);
    await page.check("#campFormGroups input[value='222']");
    await page.uncheck("#campFormGroups input[value='111']");
    await page.click("#campFormSave");
    await page.waitForFunction(() => /נשמר/.test((document.getElementById("toast") || {}).textContent || ""));
    assert.equal(seen.patches.length, 2);
    const p2 = seen.patches[1];
    assert.deepEqual(p2.add_group_ids, ["222"]);
    assert.deepEqual(p2.remove_group_ids, ["111"]);
    for (const k of ["days", "repeat_days", "mode", "targets"]) assert.ok(!(k in p2), k + " must not be sent when unchanged");
    await page.waitForFunction(() => document.querySelector("#campForm").hidden);

    // a new campaign after an edit starts clean
    await page.click("#campNew");
    assert.equal(await page.inputValue("#campFormAgent"), "");
    assert.equal(await page.inputValue("#campFormDays"), "14");
    assert.equal(await page.locator("#campFormGroups input").count(), 0);
    assert.equal(await page.isDisabled("#campFormAgent"), false);
    await page.click("#campFormCancel");

    // a 401 stepup_required shows the banner
    editAnswer = { status: 401, body: { error: "stepup_required" } };
    await page.click("[data-camp='c1'] [data-act='edit']");
    await page.waitForSelector("#campFormGroups input[value='222']", { state: "attached" });
    await page.fill("#campFormDays", "9");
    await page.click("#campFormSave");
    await page.waitForFunction(() => !document.getElementById("campStepUp").classList.contains("hidden"));
    await page.click("#campFormCancel");

    // the campaign's groups for all the agent's properties: consent, then a summary
    await page.click("[data-camp='c1'] [data-act='all']");
    assert.equal(await page.isChecked("#campFormDefaults"), true);
    await page.fill("#campFormConsentNote", "ביקשה בטלפון לכל הנכסים");
    await page.click("#campFormSave");
    await page.waitForFunction(() => /נפתחו 1 קמפיינים · דולגו: 1 כבר יש קמפיין/.test((document.getElementById("toast") || {}).textContent || ""));
    assert.deepEqual(applies[0], { consent: { method: "phone", note: "ביקשה בטלפון לכל הנכסים" }, days: 7, set_defaults: true });

    // stop asks (dialog accepted), then really stops
    await page.click("[data-camp='c1'] [data-act='stop']");
    await page.waitForFunction(() => /הקמפיין נעצר/.test((document.getElementById("toast") || {}).textContent || ""));
    assert.equal(seen.stops, 1);

    // restart of a stopped campaign records the chosen consent method and note
    await page.waitForSelector("[data-camp='c1'] [data-act='start']");
    await page.click("[data-camp='c1'] [data-act='start']");
    await page.selectOption("#campFormConsentMethod", "whatsapp");
    await page.fill("#campFormConsentNote", "   ");
    await page.click("#campFormSave");
    await page.waitForFunction(() => /חובה לכתוב/.test((document.getElementById("toast") || {}).textContent || ""));
    assert.equal(seen.starts.length, 0, "an empty note is refused client-side");
    await page.fill("#campFormConsentNote", "אישר בוואטסאפ");
    await page.click("#campFormSave");
    await page.waitForFunction(() => document.querySelector("#campForm").hidden);
    assert.equal(seen.starts.length, 1);
    assert.deepEqual(seen.starts[0], { consent: { method: "whatsapp", note: "אישר בוואטסאפ" }, days: 7 }, "a restart runs as long as the run it repeats");
    console.log("admin-campaigns.dom.test.js ok");
  } finally { server.close(); await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
