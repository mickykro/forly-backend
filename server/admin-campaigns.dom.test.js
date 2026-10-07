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
    pause_reason: null, mode: "standing", repeat: false, repeat_days: null, targets: ["groups"], expires_at: "2026-10-20T10:00:00.000Z",
    groups: [{ group_id: "111", name: "A" }], counts: { owed: 1, posted: 0, skipped: 0 }, created_by: "agent", consent_by: { by: "agent" }, version: "v1" };
  const seen = { creates: [], stops: 0 };
  let editAnswer = { status: 409, body: { error: "stale_version" } };
  const app = express(); app.use(express.json());
  app.get("/api/admin/me", (q, r) => r.json({ ok: true }));
  app.get("/api/admin/campaigns/campaigns", (q, r) => r.json({ campaigns: [ROW] }));
  app.get("/api/admin/campaigns/agents", (q, r) => r.json({ agents: [{ ref: "acct_1", phone_tail: "…0001", name: "דנה לוי" }] }));
  app.get("/api/admin/campaigns/agents/:ref/properties", (q, r) => r.json({ properties: [{ page_id: "pg1", title: "דירה בחיפה" }] }));
  app.get("/api/admin/campaigns/agents/:ref/groups", (q, r) => r.json({ groups: [{ group_id: "111", name: "A", url: "https://www.facebook.com/groups/111" }] }));
  app.post("/api/admin/campaigns/campaigns", (q, r) => { seen.creates.push(q.body); r.status(201).json({ campaign: ROW }); });
  app.patch("/api/admin/campaigns/campaigns/c1", (q, r) => r.status(editAnswer.status).json(editAnswer.body));
  app.post("/api/admin/campaigns/campaigns/c1/stop", (q, r) => { seen.stops++; r.json({ campaign: Object.assign({}, ROW, { status: "stopped" }) }); });
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
    await page.selectOption("#campFormConsentMethod", "phone");
    await page.fill("#campFormConsentNote", "אישר בטלפון");
    await page.click("#campFormSave");
    await page.waitForFunction(() => document.querySelector("#campForm").hidden);
    assert.equal(seen.creates.length, 1);
    assert.deepEqual(seen.creates[0].consent, { method: "phone", note: "אישר בטלפון" });
    assert.deepEqual(seen.creates[0].group_ids, ["111"]);

    // a refused edit shows its reason
    await page.click("[data-camp='c1'] [data-act='edit']");
    await page.fill("#campFormDays", "7");
    await page.click("#campFormSave");
    await page.waitForFunction(() => /השתנה/.test(document.body.innerText));

    // stop asks, then stops
    await page.click("[data-camp='c1'] [data-act='stop']");
    await page.waitForFunction(() => document.body.innerText.includes("נעצר"));
    assert.equal(seen.stops, 1);
    console.log("admin-campaigns.dom.test.js ok");
  } finally { server.close(); await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
