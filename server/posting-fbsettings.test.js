/* posting-fbsettings.js — once per account, recorded; a page without the control is tried again, at most 3 times. */
const assert = require("assert");
const F = require("./posting-fbsettings");

function page({ text = null, flipsTo = null } = {}) {
  let current = text;
  const visited = [];
  const loc = (role) => ({
    count: async () => (role === "option" && flipsTo ? 1 : 0),
    click: async () => { if (role === "option" && flipsTo) current = flipsTo; },
    first() { return this; }, or() { return this; },
  });
  return {
    visited,
    goto: async (u) => { visited.push(u); },
    waitForLoadState: async () => {}, waitForTimeout: async () => {},
    evaluate: async () => current,
    getByText: () => ({ first: () => ({ click: async () => {} }) }),
    getByRole: (role) => loc(role),
    screenshot: async () => Buffer.from(""),
  };
}
const dbOf = () => { const writes = []; return { writes, setConnection: async (p, patch) => { writes.push(patch); } }; };
const allow = async () => {};

(async () => {
  {
    const db = dbOf();
    assert.equal(await F.ensureAutoplayOff(page({ text: "הפעלה אוטומטית של סרטונים פועל", flipsTo: "הפעלה אוטומטית של סרטונים כבוי" }), { phone: "9725", conn: {}, db, guard: allow, env: {} }), "off");
    assert.ok(db.writes[0].facebook_autoplay_off_at, "recorded");
  }
  {
    const db = dbOf();
    assert.equal(await F.ensureAutoplayOff(page({ text: "Autoplay videos Off" }), { phone: "9725", conn: {}, db, guard: allow, env: {} }), "off", "already off");
  }
  {
    const db = dbOf();
    const p = page();
    assert.equal(await F.ensureAutoplayOff(p, { phone: "9725", conn: { facebook_autoplay_tries: 1 }, db, guard: allow, env: { POSTING_SHOTS: "0" } }), "not_found");
    assert.equal(db.writes[0].facebook_autoplay_tries, 2, "counted, tried again in a later session");
    assert.equal(p.visited.length, 2, "both candidate pages looked at");
  }
  assert.equal(await F.ensureAutoplayOff(page(), { phone: "9725", conn: { facebook_autoplay_off_at: "x" }, db: dbOf(), guard: allow }), "skip", "done once: never again");
  assert.equal(await F.ensureAutoplayOff(page(), { phone: "9725", conn: { facebook_autoplay_tries: 3 }, db: dbOf(), guard: allow }), "skip", "three misses: stop trying");
  const denied = async () => { throw Object.assign(new Error("x"), { denied: true }); };
  const db = dbOf();
  assert.equal(await F.ensureAutoplayOff(page(), { phone: "9725", conn: {}, db, guard: denied }), "denied");
  assert.equal(db.writes.length, 0, "a denial is not a miss");
  console.log("posting-fbsettings.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
