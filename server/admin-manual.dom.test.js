// server/admin-manual.dom.test.js
/* The "פרסום ידני" admin tab in real Chromium against a stub API: properties
   are collapsed and least-posted first, the open group offers the agent's
   other properties that fit it, and leaving a group asks whether it was
   posted. Skips cleanly without a Chromium binary. */
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
  if (!exe) { console.log("admin-manual.dom.test.js skipped (no Chromium binary)"); return; }
  const { chromium } = require("patchright");
  let browser;
  try { browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] }); }
  catch { console.log("admin-manual.dom.test.js skipped (launch failed)"); return; }

  const G = (id, status) => ({ group_id: id, kind: "group", name: "קבוצה " + id, url: "https://www.facebook.com/groups/" + id, status, copy: status === "owed" ? "טקסט " + id : null });
  const head = { ref: "acct_1", phone_tail: "…0001", agent_name: "דנה" };
  const queue = [
    { ...head, campaign_id: "c1", page_id: "pg1", title: "נכס מפורסם", page_url: "/p/pg1", groups: [G("g1", "posted"), G("g2", "owed")] },
    { ...head, campaign_id: "c2", page_id: "pg2", title: "נכס חדש", page_url: "/p/pg2", groups: [G("g2", "owed"), G("g3", "owed")] },
  ];
  const seen = { done: [], property: [] };
  const app = express(); app.use(express.json());
  const M = "/api/admin/manual";
  app.get("/api/admin/me", (q, r) => r.json({ ok: true }));
  app.get(M + "/agents", (q, r) => r.json({ agents: [{ ref: "acct_1", name: "דנה", phone_tail: "…0001" }] }));
  app.get(M + "/queue", (q, r) => r.json({ campaigns: queue }));
  app.post(M + "/agents/:ref/browser", (q, r) => r.json({ at_group: true }));
  app.get(M + "/agents/:ref/browser/state", (q, r) => r.json({ property: null }));
  app.post(M + "/agents/:ref/browser/property", (q, r) => { seen.property.push(q.body.page_id); r.json({ property: { page_id: q.body.page_id, title: q.body.page_id } }); });
  app.get(M + "/agents/:ref/properties", (q, r) => r.json({ properties: [] }));
  app.get(M + "/agents/:ref/properties/:pid", (q, r) => r.json({ campaign: null, groups: [], versions: [] }));
  app.post(M + "/campaigns/:id/groups/:gid/done", (q, r) => { seen.done.push(q.params.id + "|" + q.params.gid); r.json({ ok: true, completed: false }); });
  app.use("/api", (q, r) => r.json({}));
  app.get("/connect-viewer.js", (q, r) => r.type("js").send("window.ForlyViewer={create:function(){return{unmount:function(){}}}};"));
  app.use(express.static(path.join(__dirname, "..", "public-agent")));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await browser.newPage();
    page.on("dialog", (d) => d.accept());
    await page.goto(`${base}/admin.html`);
    await page.click("#tabManual");
    await page.waitForSelector("#manualQueue details[data-cid]");

    // least posted first, every property collapsed
    assert.deepEqual(await page.$$eval("#manualQueue details[data-cid]", (ds) => ds.map((d) => [d.dataset.cid, d.open])), [["c2", false], ["c1", false]]);

    // expand c1 and open its owed group g2
    await page.click("details[data-cid='c1'] > summary .manual-chip");
    await page.click("[data-act='open'][data-k='c1|g2']");
    await page.waitForSelector("#manualAlso [data-also='c2|g2']");
    assert.ok(await page.$eval("details[data-cid='c1']", (d) => d.open), "the property being posted stays open across redraws");
    assert.deepEqual(seen.property, ["pg1"]);

    // the other property that fits this group: "still editing" stays put, nothing marked
    await page.click("#manualAlso [data-also='c2|g2']");
    await page.click("#manualAsk [data-ans='editing']");
    await page.waitForFunction(() => !document.querySelector("#manualAsk").open);
    assert.ok(/פורסם\?/.test(await page.innerText("#manualAsk")), "asked whether the post went up");
    assert.deepEqual(seen.done, []);
    assert.deepEqual(seen.property, ["pg1"]);

    // "posted": marks c1|g2, then shares pg2 in the same group
    await page.click("#manualAlso [data-also='c2|g2']");
    await page.click("#manualAsk [data-ans='posted']");
    await page.waitForFunction(() => document.querySelector("details[data-cid='c2']").open);
    assert.deepEqual(seen.done, ["c1|g2"]);
    assert.deepEqual(seen.property, ["pg1", "pg2"]);

    // "couldn't post": moves on to another group without marking c2|g2
    await page.click("[data-act='open'][data-k='c2|g3']");
    await page.click("#manualAsk [data-ans='failed']");
    await page.waitForFunction(() => document.querySelector("#manualQueue li.on [data-k='c2|g3']"));
    assert.deepEqual(seen.done, ["c1|g2"]);
    console.log("admin-manual.dom.test.js ok");
  } finally { server.close(); await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
