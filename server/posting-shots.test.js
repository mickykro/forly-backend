/* posting-shots.js: a failed post's screenshot on local/staging only, kept
   small and short-lived, served to an admin only; the driver captures one
   when an attempt fails and never lets the capture change the outcome. */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const shots = require("./posting-shots");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shots-test-"));
const LOCAL = { FORLY_ENV: "local", POSTING_SHOTS_DIR: dir };
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const page = { screenshot: async (o) => { assert.equal(o.type, "jpeg"); return JPG; } };
const meta = { kind: "group", error_code: "composer_not_found", step: "session_started", attempt_key: "k-abcdef123456", campaign_id: "c1", phone: "972501234567" };

function call(app, p) {
  return new Promise((resolve, reject) => {
    const s = app.listen(0, () => http.get({ port: s.address().port, path: p }, (r) => {
      const b = []; r.on("data", (c) => b.push(c)); r.on("end", () => { s.close(); resolve({ status: r.statusCode, type: r.headers["content-type"], cache: r.headers["cache-control"], body: Buffer.concat(b) }); });
    }).on("error", reject));
  });
}

(async () => {
  try {
    // ── prod never captures; staging and local do; POSTING_SHOTS=0 turns it off ──
    assert.equal(shots.enabled({ FORLY_ENV: "prod" }), false);
    assert.equal(shots.enabled({}), false);
    assert.equal(shots.enabled({ FORLY_ENV: "staging" }), true);
    assert.equal(shots.enabled({ FORLY_ENV: "local", POSTING_SHOTS: "0" }), false);
    assert.equal(await shots.capture(page, meta, { FORLY_ENV: "prod", POSTING_SHOTS_DIR: dir }), null);
    assert.deepEqual(fs.readdirSync(dir), [], "nothing written in prod");

    // ── a capture: the image and a note with no full phone, no URL ──
    const id = await shots.capture(page, meta, LOCAL);
    assert.match(id, /^\d{13}-[0-9a-f]{8}$/);
    assert.deepEqual(await shots.read(id, LOCAL), JPG);
    const [doc] = await shots.list(LOCAL);
    assert.deepEqual({ ...doc, at: undefined }, { id, at: undefined, kind: "group", error_code: "composer_not_found", step: "session_started", image: true, key_tail: "…123456", campaign_id: "c1", phone_tail: "…4567" });
    assert.ok(!fs.readFileSync(path.join(dir, `${id}.json`), "utf8").includes("972501234567"), "no full phone on disk");
    for (const bad of ["../x", `${id}/../x`, "x", ""]) assert.equal(await shots.read(bad, LOCAL), null, bad);
    assert.equal(await shots.read(id, { ...LOCAL, FORLY_ENV: "prod" }), null, "never served in prod");

    // ── a screenshot that fails, or no page at all (failed before the browser opened): the note alone ──
    const quiet = console.error; console.error = () => {};
    let broken;
    try { broken = await shots.capture({ screenshot: async () => { throw new Error("closed"); } }, meta, LOCAL); }
    finally { console.error = quiet; }
    const noPage = await shots.capture(null, { ...meta, error_code: "media_unavailable", step: "session_started" }, LOCAL);
    const notes = await shots.list(LOCAL);
    assert.deepEqual([notes[0].id, notes[0].image, notes[0].error_code], [noPage, false, "media_unavailable"], "a pre-browser failure is listed");
    assert.equal(notes.find((n) => n.id === broken).image, false);
    assert.equal(await shots.read(noPage, LOCAL), null, "no image to serve");
    assert.equal(doc.image, true, "a real screenshot says so");

    // ── kept small: the newest MAX_SHOTS; older than 3 days dropped ──
    const old = `${Date.now() - shots.MAX_AGE_MS - 60000}-00000000`;
    fs.writeFileSync(path.join(dir, `${old}.jpg`), JPG); fs.writeFileSync(path.join(dir, `${old}.json`), "{}");
    await shots.prune(LOCAL);
    assert.ok(!fs.existsSync(path.join(dir, `${old}.jpg`)) && !fs.existsSync(path.join(dir, `${old}.json`)), "expired shot removed");
    for (let i = 0; i < shots.MAX_SHOTS + 3; i++) await shots.capture(page, meta, LOCAL);
    assert.equal((await shots.list(LOCAL)).length, shots.MAX_SHOTS);

    // ── the route: admin only; step-up off a local box; never cached ──
    const deny = (req, res) => res.status(401).json({ error: "stepup_required" });
    const pass = (req, res, next) => next();
    const route = (env, stepUp) => express().use("/s", require("./routes/driver-shots")({ requireAdmin: pass, requireStepUp: stepUp, env }));
    const listed = await call(route(LOCAL, deny), "/s/");
    assert.equal(listed.status, 200, "local: admin is enough");
    assert.equal(listed.cache, "no-store");
    const first = JSON.parse(listed.body).shots[0];
    const img = await call(route(LOCAL, deny), `/s/${first.id}.jpg`);
    assert.equal(img.status, 200); assert.match(img.type, /image\/jpeg/); assert.deepEqual(img.body, JPG);
    assert.equal((await call(route(LOCAL, deny), "/s/..%2Fx.jpg")).status, 404);
    assert.equal((await call(route({ ...LOCAL, FORLY_ENV: "staging" }, deny), "/s/")).status, 401, "staging: step-up required");
    assert.equal((await call(route({ ...LOCAL, FORLY_ENV: "staging" }, pass), "/s/")).status, 200);

    // ── the driver: a failed attempt leaves a screenshot with its reason and the step it reached ──
    const F = require("./posting-driver-fakes");
    const PD = require("./posting-driver");
    const before = (await shots.list(LOCAL)).length;
    const h = F.harness({ page: { texts: { [PD.SELECTORS.identity]: "Someone Else" } } });
    h.page.screenshot = page.screenshot;
    h.deps.env = LOCAL;
    const out = await PD.postToGroup(F.argsOf(), h.deps);
    assert.equal(out.state, "verified_failed"); assert.equal(out.error_code, "identity_mismatch", "the outcome is unchanged");
    const [last] = await shots.list(LOCAL);
    assert.equal(last.error_code, "identity_mismatch");
    assert.equal(last.step, "composer_ready", "the step it reached");
    assert.equal((await shots.list(LOCAL)).length, Math.min(before + 1, shots.MAX_SHOTS));
    // a video that cannot be fetched fails before any browser opens: listed, without an image
    const h2 = F.harness();
    h2.deps.env = LOCAL;
    h2.deps.fetchMedia = async () => { throw Object.assign(new Error("x"), { code: "media_unavailable" }); };
    const out2 = await PD.postToGroup({ ...F.argsOf(), videoUrl: "https://example.test/v.mp4" }, h2.deps);
    assert.deepEqual([out2.state, out2.error_code], ["verified_failed", "media_unavailable"]);
    const [pre] = await shots.list(LOCAL);
    assert.deepEqual([pre.error_code, pre.image, pre.step], ["media_unavailable", false, "session_started"]);
    console.log("posting-shots.test.js ok");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
