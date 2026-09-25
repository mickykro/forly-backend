/* extract.js — the wizard-side helpers that decide what gets written into
   which input. A fake element map stands in for the DOM. */
const assert = require("assert");
const X = require("./extract");

// ── isUrl ──
assert.equal(X.isUrl("https://www.yad2.co.il/item/1"), true);
assert.equal(X.isUrl("  http://x.co "), true);
assert.equal(X.isUrl("3 חדרים ברחוב הרצל"), false);
assert.equal(X.isUrl("www.yad2.co.il/item/1 3 חדרים"), false);

// ── formatPrice ──
assert.equal(X.formatPrice(2900000), "2,900,000");
assert.equal(X.formatPrice(12000), "12,000");

// fake DOM: {value|checked, type, events[]}
function dom(init) {
  const els = {};
  for (const [id, spec] of Object.entries(init)) {
    els[id] = Object.assign({ events: [], dispatchEvent(e) { this.events.push(e.type); } }, spec);
  }
  return { byId: (sel) => els[sel] || null, els };
}
const fresh = () => dom({
  "#pAddress": { value: "", type: "text" }, "#pCity": { value: "", type: "text" }, "#pHood": { value: "", type: "text" },
  "#pType": { value: "sale", type: "select-one" }, "#pPrice": { value: "", type: "text" }, "#pRooms": { value: "", type: "number" },
  "#pSqm": { value: "", type: "number" }, "#pSqmBuilt": { value: "", type: "number" }, "#pSqmBalcony": { value: "", type: "number" },
  "#pSqmGarden": { value: "", type: "number" }, "#pFloor": { value: "", type: "number" }, "#pParking": { value: "", type: "number" },
  "#pElevator": { checked: false, type: "checkbox" }, "#pShabbatElevator": { checked: false, type: "checkbox" }, "#pStorage": { checked: false, type: "checkbox" },
  "#agName": { value: "", type: "text" }, "#agPhone": { value: "", type: "tel" },
});

// ── fillFields writes only empty inputs, formats price, toggles checkboxes, fires events ──
{
  const d = fresh();
  d.els["#pCity"].value = "חיפה";                     // typed by hand → must survive
  const changed = X.fillFields({
    address: "הרצל 1", city: "תל אביב", price: 2900000, rooms: 3.5, floor: 4, deal: "rent",
    elevator: true, storage: null, parking: null, neighborhood: null,
  }, d.byId);
  assert.equal(d.els["#pAddress"].value, "הרצל 1");
  assert.equal(d.els["#pCity"].value, "חיפה");
  assert.equal(d.els["#pPrice"].value, "2,900,000");
  assert.equal(d.els["#pRooms"].value, "3.5");
  assert.equal(d.els["#pFloor"].value, "4");
  assert.equal(d.els["#pType"].value, "rent");
  assert.equal(d.els["#pElevator"].checked, true);
  assert.equal(d.els["#pStorage"].checked, false);
  assert.deepEqual(changed.sort(), ["#pAddress", "#pElevator", "#pFloor", "#pPrice", "#pRooms", "#pType"].sort());
  assert.deepEqual(d.els["#pPrice"].events, ["input", "change"]);
  assert.deepEqual(d.els["#pType"].events, ["change"]);
  assert.deepEqual(d.els["#pCity"].events, []);
}
// deal is never "empty" (select has a default) — only written when the server says so
{
  const d = fresh();
  X.fillFields({ deal: null }, d.byId);
  assert.equal(d.els["#pType"].value, "sale");
}
// unknown keys and missing elements are ignored
{
  const d = fresh();
  assert.deepEqual(X.fillFields({ nope: 1, address: "x" }, () => null), []);
}

// ── missingFor: only still-empty inputs, in display order, demo agent first ──
{
  const d = fresh();
  d.els["#pAddress"].value = "הרצל 1";
  d.els["#pPrice"].value = "1,000"; d.els["#pRooms"].value = "3"; d.els["#pSqm"].value = "80";
  const sel = X.missingFor(["address", "city", "neighborhood", "deal", "floor"], d.byId, false);
  assert.deepEqual(sel, ["#pType", "#pCity", "#pHood", "#pFloor"]);   // display order, address dropped (filled)
  assert.deepEqual(X.missingFor(["city"], d.byId, true), ["#agName", "#agPhone", "#pCity"]);
  d.els["#agName"].value = "רון";
  assert.deepEqual(X.missingFor([], d.byId, true), ["#agPhone", "#pCity"]);   // city is required even unflagged
}

// ── missingFor: required fields show when empty even if the server didn't flag them ──
{
  const d = fresh();
  d.els["#pCity"].value = "באר שבע"; d.els["#pPrice"].value = "6,000,000";
  assert.deepEqual(X.missingFor(["parking"], d.byId, false), ["#pRooms", "#pSqm", "#pParking"]);
}

// ── errorKey ──
assert.equal(X.errorKey(409, "facebook_not_connected"), "ext_err_fb_connect");
assert.equal(X.errorKey(422, "page_unreadable"), "ext_err_unreadable");
assert.equal(X.errorKey(429, "extract_limit"), "ext_err_limit");
assert.equal(X.errorKey(503, "extract_unavailable"), "ext_err_unavailable");
assert.equal(X.errorKey(500, "whatever"), "ext_err_unavailable");
assert.equal(X.errorKey(0, null), "ext_err_unavailable");

// ── pollJob: keeps asking until the job settles ──
(async () => {
  const states = [{ status: "queued" }, { status: "running" }, { status: "done", fields: { city: "חיפה" }, missing: [], photos: [] }];
  let n = 0;
  const slept = [];
  const out = await X.pollJob("job-1", {
    fetchFn: async () => ({ ok: true, json: async () => states[Math.min(n++, states.length - 1)] }),
    sleep: async (ms) => slept.push(ms),
  });
  assert.equal(out.status, "done");
  assert.deepEqual(out.fields, { city: "חיפה" });
  assert.equal(slept.length, 2, "polled twice before the answer");

  // a failed job comes back as-is, not as a throw — the caller shows its code
  const failed = await X.pollJob("job-2", {
    fetchFn: async () => ({ ok: true, json: async () => ({ status: "failed", error_code: "social_login_required" }) }),
    sleep: async () => {},
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error_code, "social_login_required");

  // a job that never settles gives up rather than polling forever
  let calls = 0;
  await assert.rejects(
    X.pollJob("job-3", {
      fetchFn: async () => { calls++; return { ok: true, json: async () => ({ status: "running" }) }; },
      sleep: async () => {},
      timeoutMs: 0,
    }),
    /timeout/,
  );
  assert.ok(calls >= 1);

  // an HTTP error on the poll is a plain failure, not a silent hang
  await assert.rejects(
    X.pollJob("job-4", { fetchFn: async () => ({ ok: false, status: 404, json: async () => ({}) }), sleep: async () => {} }),
    /404/,
  );

  // ── the new error code maps to its own Hebrew string ──
  assert.equal(X.errorKey(409, "social_login_required"), "ext_err_social_login");
  assert.equal(X.errorKey(409, "facebook_not_connected"), "ext_err_fb_connect");

  console.log("extract.test.js ok");
})();
