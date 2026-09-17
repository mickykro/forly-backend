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
  const calls = { imported: [] };
  const d = {
    business: { phone: PHONE },
    resolve: async ({ url }) => ({ source: "scrape", text: "t " + url, description: "desc",
      photos: [1, 2, 3].map((i) => ({ url: `https://c/${i}.jpg` })) }),
    parseListing: async () => ({ fields: { ...FIELDS }, missing: [] }),
    importPhoto: async (u) => { calls.imported.push(u); return "https://files/" + u.split("/").pop(); },
    createUrl: CREATE,
    extractAllowed: () => true,
    reviewLink: (phone) => `https://review/${phone}`,
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

  // description answered → photos are already 3 → confirm sends the review link
  let draft = t.draft;
  t = await turn({ text: "דירה מהממת", draft }, d);
  assert.equal(t.draft.fields.description, "דירה מהממת");
  assert.equal(t.status, "confirm");
  assert.equal(t.replies[t.replies.length - 1].buttons, undefined);
  assert.match(texts(t), new RegExp(`https://review/${PHONE}`));

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

  // ── photos: silent accumulation, timer prompt, continue, confirm ──
  ({ d, calls } = deps());
  t = await turn({ text: "נכס חדש" }, d); draft = t.draft;
  for (const [f, v] of [["city", "חיפה"], ["price", "1,500,000"], ["rooms", "4"]]) { t = await turn({ text: v, draft }, d); draft = t.draft; }
  for (let i = 0; i < 6; i++) { t = await turn({ text: "דלג", draft }, d); draft = t.draft; }
  assert.equal(t.status, "photos");
  t = await turn({ fileUrl: "https://green/a.jpg", draft }, d);
  assert.deepEqual([t.handled, t.replies.length, t.armPhotoTimer], [true, 0, true], "a photo is stored silently and arms the timer");
  draft = t.draft;
  assert.deepEqual(draft.photos, ["https://files/a.jpg"]);
  t = await turn({ event: "photo_timer", draft }, d);
  assert.equal(t.status, "photos_progress:1");
  assert.match(texts(t), /יש לי 1 תמונות/);
  assert.equal(t.replies[0].buttons, undefined);
  for (const n of ["b", "c", "d"]) { t = await turn({ fileUrl: `https://green/${n}.jpg`, draft }, d); draft = t.draft; }
  t = await turn({ text: "עוד אחת בדרך", draft }, d);
  assert.equal(t.status, "confirm", "enough photos already: any text sends the review link");
  assert.match(texts(t), new RegExp(`https://review/${PHONE}`));
  t = await turn({ text: "ממשיכים", draft }, d);
  assert.equal(t.status, "confirm");
  assert.equal(t.draft, undefined, "confirm prompt does not change the draft");

  // failed import is skipped, not counted
  ({ d } = deps({ importPhoto: async () => { throw new Error("404"); } }));
  t = await turn({ fileUrl: "https://green/bad.jpg", draft: { ...draft, photos: [] } }, d);
  assert.equal(t.draft.photos.length, 0);

  // n8n's burst debounce bundles several photos sent together into one webhook
  ({ d } = deps());
  t = await turn({ text: "נכס חדש" }, d); draft = t.draft;
  for (const [f, v] of [["city", "חיפה"], ["price", "1,500,000"], ["rooms", "4"]]) { t = await turn({ text: v, draft }, d); draft = t.draft; }
  for (let i = 0; i < 6; i++) { t = await turn({ text: "דלג", draft }, d); draft = t.draft; }
  t = await turn({ fileUrls: ["https://green/burst1.jpg", "https://green/burst2.jpg", "https://green/burst3.jpg"], draft }, d);
  assert.deepEqual([t.handled, t.replies.length, t.armPhotoTimer], [true, 0, true], "a bundled burst is stored in one turn");
  draft = t.draft;
  assert.deepEqual(draft.photos, ["https://files/burst1.jpg", "https://files/burst2.jpg", "https://files/burst3.jpg"]);

  // photo while a question is open: stored, timer prompt says saved + repeats the question
  ({ d } = deps());
  t = await turn({ text: "נכס חדש" }, d); draft = t.draft;
  t = await turn({ fileUrl: "https://green/z.jpg", draft }, d); draft = t.draft;
  assert.equal(draft.photos.length, 1);
  t = await turn({ event: "photo_timer", draft }, d);
  assert.match(texts(t), /שמרתי 1 תמונות/);
  assert.match(texts(t), /באיזו עיר/);

  // confirm: any text once ready (re)sends the review link; ביטול still cancels
  ({ d, calls } = deps());
  const ready = D.newDraft(PHONE, "keyword", T0);
  Object.assign(ready.fields, { city: "חיפה", price: 1500000, rooms: 4 });
  ready.skipped = ["deal", "size_sqm", "floor", "parking", "neighborhood", "description"];
  ready.photos = ["p1", "p2", "p3"];
  t = await turn({ text: "ממשיכים", draft: ready }, d);
  assert.equal(t.status, "confirm", "ממשיכים moves to confirm");
  assert.match(texts(t), new RegExp(`https://review/${PHONE}`));
  t = await turn({ text: "רגע", draft: ready }, d);
  assert.equal(t.status, "confirm", "any other text once ready re-sends the review link too");
  t = await turn({ text: "ביטול", draft: ready }, d);
  assert.deepEqual([t.status, t.del], ["cancelled", true]);

  // ── photos_edited: n8n sends one edited photo per call; offer once at 3 ──
  ({ d, calls } = deps());
  t = await turn({ event: "photos_edited", photos: ["https://fal/1.jpg"] }, d);
  assert.deepEqual([t.handled, t.status, t.draft.status, t.draft.photos.length, t.replies.length],
    [true, "offer_pending:1", "offered", 1, 0], "the first edited photo is stored silently");
  t = await turn({ event: "photos_edited", photos: ["https://fal/2.jpg"], draft: t.draft }, d);
  assert.deepEqual([t.status, t.draft.photos.length, t.replies.length], ["offer_pending:2", 2, 0]);
  t = await turn({ event: "photos_edited", photos: ["https://fal/3.jpg"], draft: t.draft }, d);
  assert.deepEqual([t.status, t.draft.photos.length, t.draft.offer_sent], ["offered", 3, true]);
  assert.deepEqual(t.replies[0].buttons, ["כן", "לא"]);
  assert.match(texts(t), /ערכתי 3 תמונות/);
  const offered = t.draft;
  t = await turn({ event: "photos_edited", photos: ["https://fal/4.jpg"], draft: offered }, d);
  assert.deepEqual([t.status, t.draft.photos.length, t.replies.length], ["offer_pending:4", 4, 0], "the offer is never repeated");
  assert.equal(calls.imported.length, 4, "every edited photo is re-hosted on Forly");
  // a future n8n batch path may send several at once: one call, one offer
  ({ d } = deps());
  t = await turn({ event: "photos_edited", photos: ["https://fal/1.jpg", "https://fal/2.jpg", "https://fal/3.jpg"] }, d);
  assert.deepEqual([t.status, t.draft.photos.length, t.draft.offer_sent], ["offered", 3, true]);
  t = await turn({ text: "בוקר טוב", draft: offered }, d);
  assert.equal(t.handled, false, "an offered draft does not hijack unrelated chat");
  t = await turn({ text: "לא", draft: offered }, d);
  assert.deepEqual([t.status, t.del], ["declined", true]);
  t = await turn({ text: "כן", draft: offered }, d);
  assert.deepEqual([t.status, t.draft.status, t.draft.source], ["asked:city", "active", "photos"]);
  // offer older than 2h is dropped; the message is then judged on its own
  t = await turn({ text: "בוקר טוב", draft: offered, now: new Date(T0.getTime() + D.PAUSE_MS + 1) }, d);
  assert.deepEqual([t.handled, t.del], [false, true]);

  // photos_edited while a draft is active: photos are added, current question repeated
  ({ d } = deps());
  t = await turn({ text: "נכס חדש" }, d); draft = t.draft;
  t = await turn({ event: "photos_edited", photos: ["https://fal/1.jpg"], draft }, d);
  assert.equal(t.draft.photos.length, 1);
  assert.match(texts(t), /שמרתי 1 תמונות/);
  assert.match(texts(t), /באיזו עיר/);

  // ── pause: silent for 2h → ordinary messages are not ours, openers ask resume/new ──
  ({ d } = deps());
  t = await turn({ text: "נכס חדש" }, d); draft = t.draft;
  t = await turn({ text: "חיפה", draft }, d); draft = t.draft;
  const later = new Date(T0.getTime() + D.PAUSE_MS + 1000);
  t = await turn({ text: "1,500,000", draft, now: later }, d);
  assert.equal(t.handled, false, "paused draft does not claim plain text");
  t = await turn({ fileUrl: "https://green/x.jpg", draft, now: later }, d);
  assert.equal(t.handled, false, "paused draft does not claim photos");
  t = await turn({ text: "https://www.yad2.co.il/item/new", draft, now: later }, d);
  assert.deepEqual([t.handled, t.status, t.draft.status], [true, "resume_prompt", "resume_prompt"]);
  assert.deepEqual(t.replies[0].buttons, ["המשך", "חדש"]);
  assert.equal(t.draft.pending_opener.text, "https://www.yad2.co.il/item/new");
  const rp = t.draft;
  t = await turn({ text: "המשך", draft: rp, now: later }, d);
  assert.deepEqual([t.status, t.draft.status, t.draft.fields.city, t.draft.pending_opener], ["asked:price", "active", "חיפה", null]);
  t = await turn({ text: "חדש", draft: rp, now: later }, d);
  assert.deepEqual([t.draft.source, t.draft.fields.city], ["link", "תל אביב"], "new: the pending link is extracted into a fresh draft");
  t = await turn({ text: "מה?", draft: rp, now: later }, d);
  assert.equal(t.status, "resume_prompt", "anything else repeats the question");
  // resume prompt from a photos_edited event; the rest of the batch (one photo
  // per call) piles onto the pending opener silently, the paused draft survives
  t = await turn({ event: "photos_edited", photos: ["https://fal/1.jpg"], draft, now: later }, d);
  assert.equal(t.status, "resume_prompt");
  t = await turn({ event: "photos_edited", photos: ["https://fal/2.jpg"], draft: t.draft, now: later }, d);
  assert.deepEqual([t.status, t.draft.status, t.draft.fields.city, t.replies.length], ["resume_pending:2", "resume_prompt", "חיפה", 0]);
  t = await turn({ event: "photos_edited", photos: ["https://fal/3.jpg"], draft: t.draft, now: later }, d);
  assert.deepEqual([t.status, t.draft.pending_opener.photos.length], ["resume_pending:3", 3]);
  const rpp = t.draft;
  t = await turn({ text: "חדש", draft: rpp, now: later }, d);
  assert.deepEqual([t.draft.status, t.draft.source, t.draft.photos.length, t.draft.offer_sent], ["offered", "photos", 3, true], "new: all edited photos become the offer");
  assert.match(texts(t), /ערכתי 3 תמונות/);
  t = await turn({ text: "המשך", draft: rpp, now: later }, d);
  assert.deepEqual([t.status, t.draft.status, t.draft.fields.city, t.draft.photos.length], ["asked:price", "active", "חיפה", 3], "resume: the edited photos join the paused draft");
  assert.match(texts(t), /שמרתי 3 תמונות/);

  // ── building: only an opener replaces it ──
  ({ d } = deps());
  const bld = { ...ready, status: "building", listing_id: "L9" };
  t = await turn({ text: "תודה", draft: bld }, d);
  assert.equal(t.handled, false);
  t = await turn({ text: "נכס חדש", draft: bld }, d);
  assert.deepEqual([t.handled, t.draft.status, t.draft.listing_id], [true, "active", null]);

  console.log("whatsapp-intake.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
