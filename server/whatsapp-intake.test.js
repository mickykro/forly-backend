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
      photos: [1, 2, 3, 4].map((i) => ({ url: `https://c/${i}.jpg` })) }),
    parseListing: async () => ({ fields: { ...FIELDS }, missing: [] }),
    importPhoto: async (u) => { calls.imported.push(u); return "https://files/" + u.split("/").pop(); },
    createUrl: CREATE,
    extractAllowed: () => true,
    reviewLink: (phone) => `https://review/${phone}`,
    createListing: async (body) => { calls.created = body; return { listing_id: "L1" }; },
    ...over,
  };
  return { d, calls };
}
// handleTurn mutates the draft it is given; clone so a test can branch from one draft.
const turn = (input, d) => handleTurn({ phone: PHONE, now: T0, ...input, draft: input.draft ? structuredClone(input.draft) : null }, d);
// What the agent sees: each reply's text and its link buttons' URLs.
const texts = (t) => t.replies.map((r) => [r.text, ...(r.links || []).map((l) => l.url)].join("\n")).join("\n");

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
  assert.deepEqual(t.draft.photos, ["https://files/1.jpg", "https://files/2.jpg", "https://files/3.jpg", "https://files/4.jpg"]);
  assert.equal(t.draft.fields.description, null, "description is asked, not auto-filled");
  assert.match(texts(t), /קראתי את המודעה: 3\.5 חד׳ בפלורנטין/);
  assert.match(texts(t), /תיאור/);

  // description answered → photos are already 4 → preview or create?
  let draft = t.draft;
  t = await turn({ text: "דירה מהממת", draft }, d);
  assert.equal(t.draft.fields.description, "דירה מהממת");
  assert.equal(t.status, "choose", "fields and photos done: preview or create");
  assert.deepEqual(t.replies[0].buttons, ["תצוגה מקדימה", "ליצור"]);
  draft = t.draft;
  t = await turn({ text: "מה?", draft }, d);
  assert.deepEqual([t.status, t.draft], ["choose", undefined], "anything else repeats the choice");
  // preview: straight to the review link, no design question (it's picked on the page)
  t = await turn({ text: "תצוגה מקדימה", draft }, d);
  assert.deepEqual([t.status, t.draft.mode, t.draft.fields.template], ["confirm", "preview", null]);
  assert.match(texts(t), new RegExp(`https://review/${PHONE}`));
  // create: ask the design, then build from chat
  t = await turn({ text: "ליצור", draft }, d);
  assert.equal(t.status, "asked:template");
  assert.deepEqual(t.replies[0].buttons, ["קלאסי", "נוקטורן", "ריל"]);
  draft = t.draft;
  t = await turn({ text: "2", draft }, d);
  assert.deepEqual([t.status, t.draft.status, t.draft.listing_id], ["building", "building", "L1"]);
  assert.deepEqual([calls.created.theme, calls.created.city, calls.created.photos_urls.length], [{ template: "nocturne" }, "תל אביב", 4]);
  assert.match(texts(t), /אני בונה את דף הנכס/);
  // a failed create keeps the draft so the next message retries
  ({ d } = deps({ createListing: async () => ({ error: "quota", code: 402, message: "המכסה שלך נוצלה. לרכישה: https://pay" }) }));
  t = await turn({ text: "דלג", draft }, d);
  assert.deepEqual([t.status, t.draft.status, t.draft.skipped.includes("template")], ["create_failed:402", "active", true]);
  assert.match(texts(t), /המכסה שלך נוצלה. לרכישה\nhttps:\/\/pay/, "out of quota says so, with the payment link");
  assert.deepEqual(t.replies[t.replies.length - 1].links, [{ text: "לרכישת חבילה", url: "https://pay" }], "the link behind a button");
  ({ d } = deps({ createListing: async () => ({ error: "boom", code: 500 }) }));
  t = await turn({ text: "דלג", draft }, d);
  assert.match(texts(t), /משהו השתבש/);

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
  // ₪1.5M can only be a sale, so the deal question is skipped, not asked.
  assert.equal(draft.fields.deal, "sale");
  assert.equal(t.status, "asked:size_sqm");
  // Someone who really meant rent says so, and gets the price warning.
  t = await turn({ text: "/עסקה להשכרה", draft }, d); draft = t.draft;
  assert.equal(draft.fields.deal, "rent");
  assert.match(texts(t), /נראה חריג לשכירות/);
  t = await turn({ text: "דלג", draft }, d); draft = t.draft;         // size_sqm skipped
  assert.deepEqual(draft.skipped, ["size_sqm"]);
  assert.equal(t.status, "asked:floor");

  // ── text opener with extraction failure keeps an empty draft open ──
  ({ d } = deps({ resolve: async () => { throw fail("page_unreadable"); } }));
  t = await turn({ text: "https://dead.link/1" }, d);
  assert.equal(t.handled, true);
  assert.equal(t.status, "source_error:page_unreadable");
  assert.equal(t.draft.fields.city, null);
  assert.match(texts(t), /אי אפשר לקרוא אוטומטית/);
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
  // Skip whatever optional fields remain — deal answers itself from the price.
  for (let i = 0; i < 8 && t.status.startsWith("asked:"); i++) { t = await turn({ text: "דלג", draft }, d); draft = t.draft; }
  assert.equal(t.status, "photos");
  t = await turn({ fileUrl: "https://green/a.jpg", draft }, d);
  assert.deepEqual([t.handled, t.replies.length, t.armPhotoTimer], [true, 0, true], "a photo is stored silently and arms the timer");
  draft = t.draft;
  assert.deepEqual(draft.photos, ["https://files/a.jpg"]);
  t = await turn({ event: "photo_timer", draft }, d);
  assert.equal(t.status, "photos_progress:1");
  assert.match(texts(t), /יש לי תמונה אחת/);
  assert.equal(t.replies[0].buttons, undefined);
  for (const n of ["b", "c", "d"]) { t = await turn({ fileUrl: `https://green/${n}.jpg`, draft }, d); draft = t.draft; }
  t = await turn({ text: "עוד אחת בדרך", draft }, d);
  assert.equal(t.status, "choose", "enough photos already: any text asks preview or create");
  t = await turn({ text: "ממשיכים", draft }, d);
  assert.equal(t.status, "choose");
  assert.equal(t.draft, undefined, "the choice prompt does not change the draft");

  // failed import is skipped, not counted
  ({ d } = deps({ importPhoto: async () => { throw new Error("404"); } }));
  t = await turn({ fileUrl: "https://green/bad.jpg", draft: { ...draft, photos: [] } }, d);
  assert.equal(t.draft.photos.length, 0);

  // n8n's burst debounce bundles several photos sent together into one webhook
  ({ d } = deps());
  t = await turn({ text: "נכס חדש" }, d); draft = t.draft;
  for (const [f, v] of [["city", "חיפה"], ["price", "1,500,000"], ["rooms", "4"]]) { t = await turn({ text: v, draft }, d); draft = t.draft; }
  for (let i = 0; i < 8 && t.status.startsWith("asked:"); i++) { t = await turn({ text: "דלג", draft }, d); draft = t.draft; }
  t = await turn({ fileUrls: ["https://green/burst1.jpg", "https://green/burst2.jpg", "https://green/burst3.jpg"], draft }, d);
  assert.deepEqual([t.handled, t.replies.length, t.armPhotoTimer], [true, 0, true], "a bundled burst is stored in one turn");
  draft = t.draft;
  assert.deepEqual(draft.photos, ["https://files/burst1.jpg", "https://files/burst2.jpg", "https://files/burst3.jpg"]);
  t = await turn({ fileUrls: ["https://green/burst1.jpg", "https://green/burst2.jpg", "https://green/burst3.jpg"], draft }, d);
  assert.equal(t.draft.photos.length, 3, "the same burst delivered twice is stored once");

  // photo while a question is open: stored, timer prompt says saved + repeats the question
  ({ d } = deps());
  t = await turn({ text: "נכס חדש" }, d); draft = t.draft;
  t = await turn({ fileUrl: "https://green/z.jpg", draft }, d); draft = t.draft;
  assert.equal(draft.photos.length, 1);
  t = await turn({ event: "photo_timer", draft }, d);
  assert.match(texts(t), /שמרתי תמונה אחת/);
  assert.match(texts(t), /באיזו עיר/);

  // confirm: any text once ready (re)sends the review link; ביטול still cancels
  ({ d, calls } = deps());
  const ready = D.newDraft(PHONE, "keyword", T0);
  Object.assign(ready.fields, { city: "חיפה", price: 1500000, rooms: 4 });
  ready.skipped = ["deal", "size_sqm", "floor", "parking", "neighborhood", "description"];
  ready.mode = "preview";
  ready.photos = ["p1", "p2", "p3", "p4"];
  t = await turn({ text: "ממשיכים", draft: ready }, d);
  assert.equal(t.status, "confirm", "ממשיכים moves to confirm");
  assert.match(texts(t), new RegExp(`https://review/${PHONE}`));
  t = await turn({ text: "רגע", draft: ready }, d);
  assert.equal(t.status, "confirm", "any other text once ready re-sends the review link too");
  t = await turn({ text: "ביטול", draft: ready }, d);
  assert.deepEqual([t.status, t.del], ["cancelled", true]);

  // ── photos_edited: n8n sends one edited photo per call; offer once at 4 ──
  ({ d, calls } = deps());
  t = await turn({ event: "photos_edited", photos: ["https://fal/1.jpg"] }, d);
  assert.deepEqual([t.handled, t.status, t.draft.status, t.draft.photos.length, t.replies.length],
    [true, "offer_pending:1", "offered", 1, 0], "the first edited photo is stored silently");
  t = await turn({ event: "photos_edited", photos: ["https://fal/2.jpg"], draft: t.draft }, d);
  assert.deepEqual([t.status, t.draft.photos.length, t.replies.length], ["offer_pending:2", 2, 0]);
  t = await turn({ event: "photos_edited", photos: ["https://fal/3.jpg"], draft: t.draft }, d);
  t = await turn({ event: "photos_edited", photos: ["https://fal/4.jpg"], draft: t.draft }, d);
  assert.deepEqual([t.status, t.draft.photos.length, t.draft.offer_sent], ["offered", 4, true]);
  assert.deepEqual(t.replies[0].buttons, ["כן", "לא"]);
  assert.match(texts(t), /ערכתי 4 תמונות/);
  const offered = t.draft;
  t = await turn({ event: "photos_edited", photos: ["https://fal/5.jpg"], draft: offered }, d);
  assert.deepEqual([t.status, t.draft.photos.length, t.replies.length], ["offer_pending:5", 5, 0], "the offer is never repeated");
  assert.equal(calls.imported.length, 5, "every edited photo is re-hosted on Forly");
  // a future n8n batch path may send several at once: one call, one offer
  ({ d } = deps());
  t = await turn({ event: "photos_edited", photos: ["https://fal/1.jpg", "https://fal/2.jpg", "https://fal/3.jpg", "https://fal/4.jpg"] }, d);
  assert.deepEqual([t.status, t.draft.photos.length, t.draft.offer_sent], ["offered", 4, true]);
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
  assert.match(texts(t), /שמרתי תמונה אחת/);
  assert.match(texts(t), /באיזו עיר/);

  // ── pause: silent for 2h → any message brings the draft back up (המשך / חדש / ביטול) ──
  ({ d } = deps());
  t = await turn({ text: "נכס חדש" }, d); draft = t.draft;
  t = await turn({ text: "חיפה", draft }, d); draft = t.draft;
  const later = new Date(T0.getTime() + D.PAUSE_MS + 1000);
  t = await turn({ text: "1,500,000", draft, now: later }, d);
  assert.deepEqual([t.handled, t.status, t.draft.pending_opener.text], [true, "resume_prompt", "1,500,000"], "plain text too");
  t = await turn({ text: "ביטול", draft: t.draft, now: later }, d);
  assert.deepEqual([t.status, t.del], ["cancelled", true]);
  t = await turn({ fileUrl: "https://green/x.jpg", draft, now: later }, d);
  assert.deepEqual([t.status, t.draft.pending_opener.file_urls], ["resume_prompt", ["https://green/x.jpg"]], "photos too");
  t = await turn({ text: "המשך", draft: t.draft, now: later }, d);
  assert.deepEqual([t.status, t.draft.photos, t.armPhotoTimer], ["photo_stored", ["https://files/x.jpg"], true], "resume keeps the paused photos");
  t = await turn({ text: "https://www.yad2.co.il/item/new", draft, now: later }, d);
  assert.deepEqual([t.handled, t.status, t.draft.status], [true, "resume_prompt", "resume_prompt"]);
  assert.deepEqual(t.replies[0].buttons, ["המשך", "חדש", "ביטול"]);
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
  t = await turn({ event: "photos_edited", photos: ["https://fal/4.jpg"], draft: t.draft, now: later }, d);
  assert.deepEqual([t.status, t.draft.pending_opener.photos.length], ["resume_pending:4", 4]);
  const rpp = t.draft;
  t = await turn({ text: "חדש", draft: rpp, now: later }, d);
  assert.deepEqual([t.draft.status, t.draft.source, t.draft.photos.length, t.draft.offer_sent], ["offered", "photos", 4, true], "new: all edited photos become the offer");
  assert.match(texts(t), /ערכתי 4 תמונות/);
  t = await turn({ text: "המשך", draft: rpp, now: later }, d);
  assert.deepEqual([t.status, t.draft.status, t.draft.fields.city, t.draft.photos.length], ["asked:price", "active", "חיפה", 4], "resume: the edited photos join the paused draft");
  assert.match(texts(t), /שמרתי 4 תמונות/);

  // ── building: only an opener replaces it ──
  ({ d } = deps());
  const bld = { ...ready, status: "building", listing_id: "L9" };
  t = await turn({ text: "תודה", draft: bld }, d);
  assert.equal(t.handled, false);
  t = await turn({ text: "נכס חדש", draft: bld }, d);
  assert.deepEqual([t.handled, t.draft.status, t.draft.listing_id], [true, "active", null]);

  // ── round 2 (docs/superpowers/specs/2026-09-18-whatsapp-chat-round2-design.md) ──
  const keywordAt = async (d, answers) => {
    let x = await turn({ text: "נכס חדש" }, d);
    for (const a of answers) x = await turn({ text: a, draft: x.draft }, d);
    return x;
  };

  // #1 slash corrections: Hebrew name or code, bare "/" lists, unknown name, bad value
  ({ d } = deps());
  t = await keywordAt(d, ["חיפה", "1.5 מיליון"]);                         // now asked:rooms
  t = await turn({ text: "/מחיר 2.1 מיליון", draft: t.draft }, d);
  assert.deepEqual([t.status, t.draft.fields.price], ["corrected:price", 2100000]);
  assert.match(texts(t), /עדכנתי: מחיר ₪2,100,000/);
  assert.match(texts(t), /כמה חדרים/, "the pending question is repeated");
  t = await turn({ text: "/c רמת גן", draft: t.draft }, d);
  assert.equal(t.draft.fields.city, "רמת גן");
  const afterSlash = t.draft;
  t = await turn({ text: "/", draft: afterSlash }, d);
  assert.match(texts(t), /\/מחיר \(\/p\): ₪2,100,000/);
  t = await turn({ text: "/צבע אדום", draft: afterSlash }, d);
  assert.equal(t.status, "field_unknown");
  t = await turn({ text: "/מחיר משהו", draft: afterSlash }, d);
  assert.equal(t.status, "invalid:price");
  t = await turn({ text: "/שכונה כרמל", draft: { ...afterSlash, skipped: ["neighborhood"] } }, d);
  assert.deepEqual([t.draft.fields.neighborhood, t.draft.skipped], ["כרמל", []], "a skipped field can be filled later");

  // #1/#2 smart answers: other-field talk goes through the extractor
  const extracted = (fields) => async () => ({ fields: { ...Object.fromEntries(Object.keys(FIELDS).map((k) => [k, null])), ...fields }, missing: [] });
  ({ d } = deps({ parseListing: extracted({ city: "חיפה", rooms: 3, price: 1900000 }) }));
  t = await turn({ text: "נכס חדש" }, d);
  t = await turn({ text: "חיפה, 3 חדרים, 1.9 מיליון", draft: t.draft }, d);
  assert.deepEqual([t.draft.fields.city, t.draft.fields.rooms, t.draft.fields.price, t.status], ["חיפה", 3, 1900000, "asked:deal"],
    "one message fills several empty fields");
  ({ d } = deps({ parseListing: extracted({ price: 2100000 }) }));
  t = await keywordAt(d, ["חיפה", "1.95 מיליון", "4", "90", "2"]);   // now asked:parking
  t = await turn({ text: "רגע, המחיר 2.1 מיליון", draft: t.draft }, d);
  assert.deepEqual([t.status, t.draft.fields.price, t.draft.pending_changes], ["confirm_changes", 1950000, { price: 2100000 }],
    "a different existing value is proposed, not overwritten");
  assert.deepEqual(t.replies[0].buttons, ["כן", "לא"]);
  const proposed = t.draft;
  t = await turn({ text: "כן", draft: proposed }, d);
  assert.deepEqual([t.draft.fields.price, t.draft.pending_changes, t.status], [2100000, null, "asked:parking"]);
  t = await turn({ text: "לא", draft: proposed }, d);
  assert.deepEqual([t.draft.fields.price, t.status], [1950000, "asked:parking"]);
  assert.match(texts(t), /השארתי כמו שהיה/);

  // the asked place name survives a reply that also talks about the price
  let seen;
  ({ d } = deps({ parseListing: async (txt) => { seen = txt; return extracted({ neighborhood: "הבורסה", price: 2600000 })(); } }));
  t = await keywordAt(d, ["רמת גן", "2.69 מיליון", "4", "100", "4", "1"]);   // asked:neighborhood
  t = await turn({ text: "הבורסה, והמחיר ירד ל-2.6 מיליון", draft: t.draft }, d);
  assert.equal(seen, "שכונה: הבורסה, והמחיר ירד ל-2.6 מיליון", "the question's label gives the extractor context");
  assert.deepEqual([t.draft.fields.neighborhood, t.draft.pending_changes], ["הבורסה", { price: 2600000 }]);
  assert.match(texts(t), /עדכנתי: שכונה הבורסה/);

  // #15 price vs deal
  ({ d } = deps());
  t = await keywordAt(d, ["חיפה", "5,500", "3"]);
  assert.equal(t.draft.fields.deal, "rent", "₪5,500 is a rent, so the deal is not asked");
  t = await turn({ text: "/עסקה למכירה", draft: t.draft }, d);
  assert.match(texts(t), /נראה חריג למכירה/, "insisting on sale at that price still warns");

  // spoken numbers, impossible values, and no word-for-word repeat on a second miss
  ({ d } = deps());
  t = await keywordAt(d, ["כפר סבא", "2.5 מיליון", "ארבעה חדרים"]);   // asked:size_sqm
  assert.equal(t.draft.fields.rooms, 4);
  const atSize = t.draft;
  t = await turn({ text: "100 ו-10.", draft: atSize }, d);
  assert.deepEqual([t.draft.fields.size_sqm, t.status], [110, "asked:floor"]);
  t = await turn({ text: "קומה אחת", draft: t.draft }, d);
  assert.equal(t.draft.fields.floor, 1);
  t = await turn({ text: "ועשר מטר", draft: atSize }, d);
  assert.equal(t.status, "invalid:size_sqm", "10 m² is a mishearing, not an answer");
  assert.match(texts(t), /לא הצלחתי להבין את השטח/);
  t = await turn({ text: "מה זה?", draft: t.draft }, d);
  assert.match(texts(t), /עדיין לא הבנתי 🙏 כתבו רק מספר, למשל 95/);
  assert.match(texts(t), /דלג/, "optional field: skipping is offered");
  t = await turn({ text: "95", draft: t.draft }, d);
  assert.deepEqual([t.draft.fields.size_sqm, t.draft.retry], [95, null]);

  // a new link or "נכס חדש" while a draft is open asks המשך / חדש / ביטול instead of being ignored
  ({ d } = deps());
  t = await turn({ text: "https://www.yad2.co.il/item/other", draft: ready }, d);
  assert.deepEqual([t.status, t.draft.pending_opener.text], ["resume_prompt", "https://www.yad2.co.il/item/other"]);
  t = await turn({ text: "חדש", draft: t.draft }, d);
  assert.deepEqual([t.draft.source, t.draft.fields.city], ["link", "תל אביב"], "new: the link opens a fresh draft");
  t = await turn({ text: "נכס חדש", draft: ready }, d);
  assert.equal(t.status, "resume_prompt");
  t = await turn({ text: "המשך", draft: t.draft }, d);
  assert.equal(t.status, "confirm", "resume: back where the draft was");

  // listing photos that all fail to re-host are reported, not swallowed
  ({ d } = deps({ importPhoto: async () => { throw new Error("relay 401"); } }));
  t = await turn({ text: "https://www.yad2.co.il/item/abc" }, d);
  assert.equal(t.draft.photos.length, 0);
  assert.match(texts(t), /מצאתי תמונות במודעה אבל לא הצלחתי לשמור אותן/);

  // #16 emoji around a command
  assert.equal(D.command("✅ ליצור!"), "create");

  // #5 preview is final: "ליצור" re-sends the link
  ({ d } = deps());
  t = await turn({ text: "ליצור", draft: ready }, d);
  assert.equal(t.status, "preview_only");
  assert.match(texts(t), new RegExp(`https://review/${PHONE}`));

  // #6/#7 photo timer: one bubble with the count and the next question; over-12 reported
  ({ d } = deps());
  t = await turn({ text: "נכס חדש" }, d);
  const twelve = Array.from({ length: 14 }, (_, i) => `https://green/m${i}.jpg`);
  t = await turn({ fileUrls: twelve, draft: t.draft }, d);
  assert.deepEqual([t.draft.photos.length, t.draft.photos_dropped], [12, 2]);
  t = await turn({ event: "photo_timer", draft: t.draft }, d);
  assert.equal(t.replies.length, 1, "one bubble");
  assert.match(texts(t), /שמרתי 12 תמונות לנכס. \(2 לא נשמרו/);
  assert.match(texts(t), /באיזו עיר/);
  assert.equal(t.draft.photos_dropped, 0);

  // #9 documents are refused while a draft is open, ignored otherwise
  t = await turn({ messageType: "documentMessage", draft: ready }, d);
  assert.deepEqual([t.status, t.handled, t.replies.length], ["document", true, 1]);
  assert.match(texts(t), /לא יודעת לקרוא/);
  assert.match(texts(t), new RegExp(`https://review/${PHONE}`), "the pending step follows in the same bubble");
  t = await turn({ messageType: "documentMessage" }, d);
  assert.equal(t.handled, false);

  // #11 voice: transcribed, then handled like text, with what was heard up front
  ({ d } = deps({ transcribe: async () => "נכס חדש" }));
  t = await turn({ audioUrl: "https://green/v.ogg" }, d);
  assert.deepEqual([t.handled, t.status], [true, "asked:city"]);
  assert.match(t.replies[0].text, /^🎙️ שמעתי: ״נכס חדש״/);
  ({ d } = deps({ transcribe: async () => { throw new Error("down"); } }));
  t = await turn({ audioUrl: "https://green/v.ogg", draft: ready }, d);
  assert.equal(t.status, "voice_failed");
  t = await turn({ audioUrl: "https://green/v.ogg" }, d);
  assert.equal(t.handled, false, "no draft: a failed voice note is left to the AI");

  // #11b a mis-heard command still lands, but only where it cannot cost an answer
  const spoken = async (heard, draft) =>
    turn({ audioUrl: "https://green/v.ogg", draft }, deps({ transcribe: async () => heard }).d);
  const atParking = { ...ready, fields: { ...ready.fields, deal: "sale", parking: null },
    skipped: ["size_sqm", "floor"], photos: [] };
  t = await spoken("דליק", atParking);                       // "דלג" mis-heard
  assert.ok(t.draft.skipped.includes("parking"), "a near-miss skip is taken as דלג");
  t = await spoken("לא הבנתי כלום", atParking);
  assert.equal(t.status, "invalid:parking", "unrelated speech is still an invalid answer");
  t = await spoken("תצאו גם מקדימה", ready);                 // "תצוגה מקדימה" mis-heard
  assert.equal(t.status, "confirm");
  assert.match(texts(t), new RegExp(`https://review/${PHONE}`));
  // "חדרה" is two edits from the command "חדש" and must stay a city
  t = await spoken("חדרה", null);
  assert.equal(t.handled, false, "a city name near a command opens nothing on its own");
  ({ d } = deps({ transcribe: async () => "חדרה" }));
  t = await turn({ audioUrl: "https://green/v.ogg", draft: (await turn({ text: "נכס חדש" }, d)).draft }, d);
  assert.deepEqual([t.status, t.draft.fields.city], ["asked:price", "חדרה"], "it answers the city question");

  // own video: stored on the draft, sent as own_video_url so nothing is generated
  ({ d, calls } = deps({ importVideo: async (u) => "https://files/" + u.split("/").pop() }));
  t = await turn({ videoUrl: "https://green/tour.mp4", draft: ready }, d);
  assert.deepEqual([t.status, t.draft.video_url], ["video_stored", "https://files/tour.mp4"]);
  assert.match(texts(t), /קיבלתי את הסרטון/);
  assert.equal(D.listingBody(t.draft).own_video_url, "https://files/tour.mp4");
  assert.equal(D.listingBody(ready).own_video_url, null, "no video: the walkthrough is generated as before");
  ({ d } = deps({ importVideo: async () => { throw new Error("too big"); } }));
  t = await turn({ videoUrl: "https://green/huge.mp4", draft: ready }, d);
  assert.equal(t.status, "video_failed");
  t = await turn({ videoUrl: "https://green/tour.mp4" }, d);
  assert.equal(t.handled, false, "a video with no draft is not the property chat's");

  // #12 the agent's comment next to a link wins; two links → first one, and we say so
  ({ d } = deps({ parseListing: async (txt) => (txt.startsWith("t ") ? { fields: { ...FIELDS }, missing: [] } : extracted({ price: 2500000 })()) }));
  t = await turn({ text: "המחיר ירד ל-2.5 מיליון https://www.yad2.co.il/item/abc https://www.yad2.co.il/item/def" }, d);
  assert.equal(t.draft.fields.price, 2500000);
  assert.match(texts(t), /קראתי את הקישור הראשון/);

  console.log("whatsapp-intake.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
