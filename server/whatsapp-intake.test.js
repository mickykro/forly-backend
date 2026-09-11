/* whatsapp-intake.js — link detection, the decision ladder and the replies.
   Deps are injected; no Express, Firestore or network. */
const assert = require("assert");
const { intake, findUrl, _test } = require("./whatsapp-intake");
const { listingBody } = _test;

// ── findUrl: first http(s) link, phone-keyboard punctuation stripped ──
assert.equal(findUrl("תראה את זה https://www.yad2.co.il/item/abc123."), "https://www.yad2.co.il/item/abc123");
assert.equal(findUrl("(http://madlan.co.il/x?y=1)"), "http://madlan.co.il/x?y=1");
assert.equal(findUrl("a https://a.co/1 and https://b.co/2"), "https://a.co/1");
assert.equal(findUrl("no link here"), null);
assert.equal(findUrl("ftp://x.co/a"), null);
assert.equal(findUrl(""), null);
assert.equal(findUrl(null), null);

// ── listingBody: extractor keys → create-form keys ──
const fields = { city: "תל אביב", price: 2900000, rooms: 3.5, address: null, neighborhood: "פלורנטין", deal: "rent",
  size_sqm: 80, sqm_built: 70, sqm_balcony: 10, sqm_garden: null, floor: 2, parking: 1, elevator: true, shabbat_elevator: null, storage: null };
const body = listingBody(fields, { description: "d", text: "t" }, ["p1", "p2", "p3"]);
assert.equal(body.listing_type, "rent");
assert.equal(body.address, "");
assert.equal(body.size_built, 70);
assert.equal(body.elevator, true);
assert.equal(body.shabbat_elevator, false);
assert.equal(body.description, "d");
assert.deepEqual(body.photos_urls, ["p1", "p2", "p3"]);
assert.equal(listingBody({ ...fields, deal: null }, { text: "t" }, []).listing_type, "sale");
assert.equal(listingBody(fields, { text: "t" }, []).description, "t");

// ── intake ladder ──
const CREATE = "https://agent/create.html";
function deps(over = {}) {
  const calls = { created: [], consumed: [], imported: [] };
  const d = {
    getBusiness: async () => ({ phone: "972501234567" }),
    resolve: async ({ url }) => ({ source: "scrape", text: "listing " + url, description: "desc",
      photos: [{ url: "https://c/1.jpg" }, { url: "https://c/2.jpg" }, { url: "https://c/3.jpg" }] }),
    parseListing: async () => ({ fields, missing: [] }),
    importPhoto: async (u) => { calls.imported.push(u); return "https://files/" + u.split("/").pop(); },
    quota: { consume: async (phone, kind, n, opts) => { calls.consumed.push({ kind, n, source: opts.source }); return { ok: true }; } },
    createListing: async (phone, listing) => { calls.created.push({ phone, listing }); return { listing_id: "L1" }; },
    createUrl: CREATE,
    ...over,
  };
  return { d, calls };
}
const msg = { phone: "972501234567", text: "https://www.yad2.co.il/item/abc" };
const fail = (code) => { const e = new Error(code); e.code = code; return e; };

(async () => {
  // happy path: photos re-hosted, quota consumed as whatsapp, listing created, building reply
  let { d, calls } = deps();
  let out = await intake(msg, d);
  assert.equal(out.status, "building");
  assert.equal(out.listing_id, "L1");
  assert.match(out.reply, /3\.5 חד׳ בפלורנטין/);
  assert.match(out.reply, /2,900,000/);
  assert.deepEqual(calls.consumed, [{ kind: "walkthroughs", n: 1, source: "whatsapp" }]);
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].phone, "972501234567");
  assert.deepEqual(calls.created[0].listing.photos_urls, ["https://files/1.jpg", "https://files/2.jpg", "https://files/3.jpg"]);
  assert.equal(calls.created[0].listing.city, "תל אביב");

  // strangers get nothing — no reply, no scrape
  ({ d, calls } = deps({ getBusiness: async () => null, resolve: async () => { throw new Error("must not scrape"); } }));
  out = await intake(msg, d);
  assert.deepEqual(out, { status: "unknown_agent", reply: null });

  // no link → hint with the form
  ({ d } = deps());
  out = await intake({ phone: msg.phone, text: "היי" }, d);
  assert.equal(out.status, "no_link");
  assert.ok(out.reply.includes(CREATE));

  // source errors map to their own replies; unknown codes fall back to page_unreadable
  for (const code of ["page_unreadable", "facebook_not_connected", "extract_unavailable"]) {
    ({ d } = deps({ resolve: async () => { throw fail(code); } }));
    out = await intake(msg, d);
    assert.equal(out.status, code);
    assert.ok(out.reply.includes(CREATE));
  }
  ({ d } = deps({ parseListing: async () => { throw fail("weird"); } }));
  assert.equal((await intake(msg, d)).status, "page_unreadable");

  // missing city/price/rooms → named in Hebrew, nothing consumed or created
  ({ d, calls } = deps({ parseListing: async () => ({ fields: { ...fields, price: null, rooms: null }, missing: [] }) }));
  out = await intake(msg, d);
  assert.equal(out.status, "missing_fields");
  assert.deepEqual(out.missing, ["price", "rooms"]);
  assert.match(out.reply, /מחיר, מספר חדרים/);
  assert.equal(calls.consumed.length + calls.created.length, 0);

  // fewer than 3 usable photos (one import fails) → ask for photos, nothing consumed
  ({ d, calls } = deps({ importPhoto: async (u) => { if (u.endsWith("2.jpg")) throw new Error("404"); return u; } }));
  out = await intake(msg, d);
  assert.equal(out.status, "few_photos");
  assert.equal(out.photos, 2);
  assert.equal(calls.consumed.length, 0);

  // quota blocked → the ledger's own message, nothing created
  ({ d, calls } = deps({ quota: { consume: async () => ({ ok: false, message: "נגמרה החבילה" }) } }));
  out = await intake(msg, d);
  assert.equal(out.status, "quota_blocked");
  assert.equal(out.reply, "נגמרה החבילה");
  assert.equal(calls.created.length, 0);

  // no quota module (local dev) → still creates
  ({ d, calls } = deps({ quota: null }));
  assert.equal((await intake(msg, d)).status, "building");

  // create rejected (validation) → failure reply
  ({ d } = deps({ createListing: async () => ({ error: "x", code: 400 }) }));
  assert.equal((await intake(msg, d)).status, "create_failed");

  console.log("whatsapp-intake.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
