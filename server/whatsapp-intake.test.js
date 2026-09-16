/* whatsapp-intake.js — handleTurn: claim rules and the conversation, with fake deps. */
const assert = require("assert");
const { handleTurn } = require("./whatsapp-intake");
const D = require("./property-draft");

const PHONE = "972501234567";
const CREATE = "https://agent/create.html";
const T0 = new Date("2026-09-12T10:00:00Z");
const FIELDS = { city: "תל אביב", price: 2900000, rooms: 3.5, address: null, neighborhood: "פלורנטין", deal: "sale",
  size_sqm: 80, sqm_built: null, sqm_balcony: null, sqm_garden: null, floor: 2, parking: 1, elevator: true, shabbat_elevator: null, storage: null };
const fail = (code) => { const e = new Error(code); e.code = code; return e; };

function deps(over = {}) {
  const calls = { created: [], consumed: [], imported: [] };
  const d = {
    business: { phone: PHONE },
    resolve: async ({ url }) => ({ source: "scrape", text: "t " + url, description: "desc",
      photos: [1, 2, 3].map((i) => ({ url: `https://c/${i}.jpg` })) }),
    parseListing: async () => ({ fields: { ...FIELDS }, missing: [] }),
    importPhoto: async (u) => { calls.imported.push(u); return "https://files/" + u.split("/").pop(); },
    quota: { consume: async (phone, kind, n, o) => { calls.consumed.push({ kind, n, source: o.source }); return { ok: true }; } },
    createListing: async (phone, body) => { calls.created.push({ phone, body }); return { listing_id: "L1" }; },
    createUrl: CREATE,
    extractAllowed: () => true,
    ...over,
  };
  return { d, calls };
}
// handleTurn mutates the draft it is given; clone so a test can branch from one draft.
const turn = (input, d) => handleTurn({ phone: PHONE, now: T0, ...input, draft: input.draft ? structuredClone(input.draft) : null }, d);
const texts = (t) => t.replies.map((r) => r.text).join("\n");

(async () => {
  // ── not ours ──
  let { d } = deps({ business: null });
  let t = await turn({ text: "https://x.co/1" }, d);
  assert.deepEqual([t.handled, t.status, t.replies.length], [false, "unknown_agent", 0]);

  ({ d } = deps());
  t = await turn({ text: "היי" }, d);
  assert.deepEqual([t.handled, t.status], [false, "not_ours"]);
  t = await turn({ fileUrl: "https://green/1.jpg" }, d);
  assert.equal(t.handled, false, "a photo with no draft goes to image editing");

  // ── link opener: extract, import photos, ask the first missing field ──
  let calls;
  ({ d, calls } = deps());
  t = await turn({ text: "תראה https://www.yad2.co.il/item/abc" }, d);
  assert.equal(t.handled, true);
  assert.equal(t.status, "asked:description", "every extractor field came from the link; only description is empty");
  assert.equal(t.draft.source, "link");
  assert.equal(t.draft.fields.city, "תל אביב");
  assert.deepEqual(t.draft.photos, ["https://files/1.jpg", "https://files/2.jpg", "https://files/3.jpg"]);
  assert.equal(t.draft.fields.description, null, "description is asked, not auto-filled");
  assert.match(texts(t), /קראתי את המודעה: 3\.5 חד׳ בפלורנטין/);
  assert.match(texts(t), /תיאור/);

  // description answered → photos are already 3 → confirm
  let draft = t.draft;
  t = await turn({ text: "דירה מהממת", draft }, d);
  assert.equal(t.draft.fields.description, "דירה מהממת");
  assert.equal(t.status, "confirm");
  assert.deepEqual(t.replies[t.replies.length - 1].buttons, ["כן", "ביטול"]);

  // ── keyword opener: empty draft, ask city ──
  ({ d } = deps());
  t = await turn({ text: "נכס חדש" }, d);
  assert.deepEqual([t.handled, t.status, t.draft.source], [true, "asked:city", "keyword"]);
  draft = t.draft;
  t = await turn({ text: "חיפה", draft }, d);
  assert.equal(t.draft.fields.city, "חיפה");
  assert.equal(t.status, "asked:price");
  draft = t.draft;
  t = await turn({ text: "לא יודע", draft }, d);
  assert.equal(t.status, "invalid:price");
  assert.equal(t.draft.fields.price, null);
  t = await turn({ text: "דלג", draft }, d);
  assert.equal(t.status, "required:price", "cannot skip a required field");
  t = await turn({ text: "1.5 מיליון", draft }, d);
  assert.equal(t.draft.fields.price, 1500000);
  draft = t.draft;
  t = await turn({ text: "4", draft }, d); draft = t.draft;           // rooms
  t = await turn({ text: "להשכרה", draft }, d); draft = t.draft;     // deal (button text)
  assert.equal(draft.fields.deal, "rent");
  t = await turn({ text: "דלג", draft }, d); draft = t.draft;         // size_sqm skipped
  assert.deepEqual(draft.skipped, ["size_sqm"]);
  assert.equal(t.status, "asked:floor");

  // ── text opener with extraction failure keeps an empty draft open ──
  ({ d } = deps({ resolve: async () => { throw fail("page_unreadable"); } }));
  t = await turn({ text: "https://dead.link/1" }, d);
  assert.equal(t.handled, true);
  assert.equal(t.status, "source_error:page_unreadable");
  assert.equal(t.draft.fields.city, null);
  assert.match(texts(t), /לא הצלחתי לקרוא/);
  assert.match(texts(t), /באיזו עיר/);

  // ── daily extraction cap ──
  ({ d } = deps({ extractAllowed: () => false }));
  t = await turn({ text: "https://x.co/1" }, d);
  assert.deepEqual([t.handled, t.status, t.draft], [true, "extract_limit", undefined]);

  // ── listing-like text opener goes through the extractor with text ──
  ({ d, calls } = deps({ resolve: async (i) => { assert.equal(i.text.includes("חדרים"), true); return { source: "text", text: i.text, description: i.text, photos: [] }; } }));
  t = await turn({ text: "למכירה בפלורנטין 3 חדרים 70 מ״ר קומה 2 מחיר 2,200,000 ₪ משופצת" }, d);
  assert.equal(t.draft.source, "text");
  assert.equal(t.draft.photos.length, 0);

  console.log("whatsapp-intake.test.js (openers + questions) ok");
})().catch((e) => { console.error(e); process.exit(1); });
