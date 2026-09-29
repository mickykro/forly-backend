/* WhatsApp chat flows added 2026-09-29 from real conversations (972548018957, 972546582548):
 * intent openers, page updates and their approval, held photos, image replies, stop. */
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
const texts = (t) => t.replies.map((r) => r.text).join("\n");

(async () => {
  let d, t;
  const extracted = (fields) => async () => ({ fields: { ...Object.fromEntries(Object.keys(FIELDS).map((k) => [k, null])), ...fields }, missing: [] });
  // ── intent: the agent's own words open a draft (the 972548018957 loop, 2026-09-29) ──
  let asked = [];
  const intent = (yes) => deps({ classifyIntent: async (txt) => { asked.push(txt); return yes ? "new" : null; },
    parseListing: extracted({ city: "סביון", rooms: 8, price: 32000000 }) });
  ({ d } = intent(true));
  t = await turn({ text: "בוקר טוב אני רוצה לבנותת דף נכס" }, d);
  assert.deepEqual([t.handled, t.status, t.draft.status], [true, "asked:city", "active"]);
  assert.match(texts(t), /מתחילים דף נכס חדש/);
  t = await turn({ text: "סביון, 8 חדרים, 32 מיליון" }, d);
  assert.equal(t.handled, true, "details with no draft open one and fill it");
  assert.deepEqual([t.draft.fields.city, t.draft.fields.rooms, t.draft.fields.price], ["סביון", 8, 32000000]);
  assert.doesNotMatch(texts(t), /באיזו עיר/, "the city it just got is not asked again");

  // an offer for edited photos: an own-words yes takes it
  const offer4 = { ...D.newDraft(PHONE, "photos", T0), status: "offered", offer_sent: true, photos: ["a", "b", "c", "d"] };
  t = await turn({ text: "יאללה תבני מזה דף נכס", draft: offer4 }, d);
  assert.deepEqual([t.handled, t.draft.status, t.draft.photos.length], [true, "active", 4]);

  // no: stays n8n's; nothing about a property: no LLM call at all
  ({ d } = intent(false));
  asked = [];
  t = await turn({ text: "תעשי את החלל הזה אחרי שיפוץ, זה אותו נכס" }, d);
  assert.deepEqual([t.handled, asked.length], [false, 1]);
  t = await turn({ text: "תעשי שהדירה תיראה מוארת" }, d);
  t = await turn({ text: "היי מה שלומך" }, d);
  assert.deepEqual([t.handled, asked.length], [false, 2], "small talk never reaches the intent check");
  ({ d } = deps({ classifyIntent: async () => { throw new Error("down"); } }));
  t = await turn({ text: "רוצה דף נכס בבקשה" }, d);
  assert.equal(t.handled, false, "a failed check falls through to n8n");

  // ── 972546582548, 2026-09-28/29 ──
  // "תראה תצוגה מקדימה" at the preview/create question is preview
  const choosing = { ...D.newDraft(PHONE, "text", T0), fields: { ...FIELDS, description: "d" }, photos: ["a", "b", "c", "d"] };
  t = await turn({ text: "תראה תצוגה מקדימה", draft: choosing }, deps().d);
  assert.deepEqual([t.status, t.draft.mode], ["confirm", "preview"]);
  t = await turn({ text: "תבני את הדף עכשיו", draft: choosing }, deps().d);
  assert.equal(t.draft.mode, "create");

  // pasted listing text is the description: not asked for again
  t = await turn({ text: "למכירה בפלורנטין 3 חדרים 70 מ״ר קומה 2 מחיר 2,200,000 ₪ משופצת" }, deps().d);
  assert.match(t.draft.fields.description, /משופצת/);
  assert.notEqual(t.status, "asked:description");

  // a street with the city: split by the extractor, not saved whole as the city
  let seenPrompt = null;
  ({ d } = deps({ parseListing: async (txt) => { seenPrompt = txt; return extracted({ city: "באר שבע", address: "נחל דליות 35" })(); } }));
  const noCity = { ...D.newDraft(PHONE, "text", T0), fields: { ...D.newDraft(PHONE, "text", T0).fields, rooms: 4, price: 1470000 } };
  t = await turn({ text: "נחל דליות 35 באר שבע", draft: noCity }, d);
  assert.deepEqual([t.draft.fields.city, t.draft.fields.address], ["באר שבע", "נחל דליות 35"]);
  assert.equal(seenPrompt, "נחל דליות 35 באר שבע", "no 'עיר:' label pushing it all into city");

  // updating an existing page: editor link, and the photos after it are held, not edited
  const page = (id, address, city) => ({ page_id: id, property: { title: `4 חד׳ ב${city}`, address, city, neighborhood: null } });
  const pages = [page("P1", "נחשון 74", "באר שבע"), page("P2", "נחל דליות 35", "באר שבע")];
  ({ d } = deps({ classifyIntent: async () => "update", listPages: async () => pages, editUrl: (id) => `https://agent/edit.html?id=${id}` }));
  t = await turn({ text: "תעדכן את התמונות בדף הנכס של דליות 35 ." }, d);
  assert.deepEqual([t.handled, t.status, t.draft.status], [true, "update_link", "updating"]);
  assert.match(texts(t), /edit\.html\?id=P2/);
  assert.doesNotMatch(texts(t), /P1/);
  const updating = t.draft;
  t = await turn({ fileUrls: ["https://green/1.jpg", "https://green/2.jpg"], draft: updating, now: new Date(T0.getTime() + 90000) }, d);
  assert.deepEqual([t.handled, t.status, t.replies.length], [true, "page_photos_held:2", 0], "photos for the page never reach n8n's editing");
  t = await turn({ fileUrl: "https://green/3.jpg", draft: t.draft, now: new Date(T0.getTime() + 100000) }, d);
  assert.deepEqual([t.handled, t.status, t.replies.length], [true, "page_photos_held:3", 0], "the rest of the burst joins silently");
  t = await turn({ fileUrl: "https://green/4.jpg", draft: updating, now: new Date(T0.getTime() + 16 * 60000) }, d);
  assert.deepEqual([t.handled, t.draft.status], [true, "photo_choice"], "the hold ends after 15 quiet minutes: back to the choice");
  ({ d } = deps({ classifyIntent: async () => null, listPages: async () => pages, editUrl: (id) => id }));
  t = await turn({ text: "מה שלומך", draft: updating }, d);
  assert.deepEqual([t.handled, t.del], [false, true], "other talk ends the hold and goes to n8n");
  // no address named: a short list; an offer pending: the update wins over it
  ({ d } = deps({ classifyIntent: async () => "update", listPages: async () => pages, editUrl: (id) => id }));
  t = await turn({ text: "גם תיצור סרטון חדש ?", draft: offer4 }, d);
  assert.deepEqual([t.status, t.draft.links.length], ["update_list", 2]);

  // ── photos with no caption and nothing open: held, one question, only 3/4 edit ──
  ({ d } = deps({ classifyIntent: async () => null }));
  t = await turn({ fileUrls: ["https://green/1.jpg", "https://green/2.jpg"] }, d);
  t = await turn({ fileUrl: "https://green/3.jpg", draft: t.draft }, d);
  t = await turn({ fileUrls: ["https://green/2.jpg", "https://green/4.jpg", "https://green/5.jpg"], draft: t.draft }, d);
  assert.deepEqual([t.status, t.replies.length], ["photo_choice:5", 0], "the burst piles up silently, duplicates skipped");
  const choice = t.draft;
  t = await turn({ event: "photo_timer", draft: choice }, d);
  assert.match(texts(t), /קיבלתי 5 תמונות[\s\S]*1 · דף נכס חדש[\s\S]*4 · לשפר 3 לדוגמה/);
  t = await turn({ text: "3", draft: choice }, d);
  assert.deepEqual([t.handled, t.status, t.edit_photos.length, t.edit_instruction, t.del], [false, "edit_photos", 5, "", true]);
  t = await turn({ text: "4", draft: choice }, d);
  assert.deepEqual(t.edit_photos, ["https://green/1.jpg", "https://green/2.jpg", "https://green/3.jpg"], "a sample of 3");
  t = await turn({ text: "תעשי אותן מוארות", draft: choice }, d);
  assert.deepEqual([t.handled, t.edit_instruction, t.edit_photos.length], [false, "תעשי אותן מוארות", 5], "a typed instruction edits with it");
  t = await turn({ text: "היי", draft: choice }, d);
  assert.deepEqual([t.handled, t.status], [true, "photo_choice_asked"], "one word asks again, nothing is edited");
  t = await turn({ text: "1", draft: choice }, d);
  assert.deepEqual([t.draft.status, t.draft.photos.length, t.status], ["active", 5, "asked:city"], "1: a new page with these photos");
  assert.match(texts(t), /שמרתי 5 תמונות/);
  ({ d } = deps({ classifyIntent: async () => null, listPages: async () => [] }));
  t = await turn({ text: "2", draft: choice }, d);
  assert.match(texts(t), /עוד אין לך דפי נכס/);
  t = await turn({ fileUrl: "https://green/9.jpg", draft: choice, now: new Date(T0.getTime() + 31 * 60000) }, d);
  assert.deepEqual([t.draft.photos.length], [1], "a stale choice is dropped; the new photo starts over");
  t = await turn({ fileUrl: "https://green/1.jpg", text: "תעשי שיפוץ" }, d);
  assert.equal(t.handled, false, "a photo with a caption is an edit request: n8n's");

  // ── text sent together with photos (09-29 10:39: the ad + 7 photos) ──
  ({ d } = deps({ classifyIntent: async () => null }));
  t = await turn({ text: "למכירה בפלורנטין 3 חדרים 70 מ״ר קומה 2 מחיר 2,200,000 ₪ משופצת", fileUrls: ["https://green/a.jpg", "https://green/b.jpg"] }, d);
  assert.deepEqual([t.handled, t.draft.status], [true, "active"], "the ad opens the draft");
  assert.ok(["https://files/a.jpg", "https://files/b.jpg"].every((u) => t.draft.photos.includes(u)), "and the photos sent with it join it");

  // ── stop ──
  let cancelled = null;
  ({ d } = deps({ cancelEdits: async (p) => { cancelled = p; } }));
  t = await turn({ text: "אל תערוך שוב" }, d);
  assert.deepEqual([t.handled, t.status, cancelled], [true, "stopped", PHONE]);
  t = await turn({ text: "די", draft: choice }, d);
  assert.deepEqual([t.status, t.del], ["stopped", true], "stop also drops held photos");

  // ── a reply to an image with a comment edits that image; praise does not ──
  ({ d } = deps());
  t = await turn({ text: "תעשי אותה בהירה יותר", quotedImageUrl: "https://fal/x.jpg" }, d);
  assert.deepEqual([t.handled, t.status, t.edit_photos, t.edit_instruction], [false, "edit_quoted", ["https://fal/x.jpg"], "תעשי אותה בהירה יותר"]);
  t = await turn({ text: "יפה מאוד!", quotedImageUrl: "https://fal/x.jpg" }, d);
  assert.notEqual(t.status, "edit_quoted", "praise is not an edit");
  t = await turn({ text: "כן", quotedImageUrl: "https://fal/x.jpg" }, d);
  assert.notEqual(t.status, "edit_quoted", "a command is not an edit");

  // ── changing a live page's data: proposed, applied only on "כן" ──
  const live = { page_id: "P2", listing_id: "L2", business_phone: PHONE,
    property: { title: "4 חד׳ בפארק", address: "נחל דליות 35", city: "באר שבע", neighborhood: "הפארק", price: 1470000, rooms: 4, listing_type: "sale" } };
  let applied = null;
  ({ d } = deps({ classifyIntent: async () => "update", listPages: async () => [live], editUrl: (id) => `https://agent/edit.html?id=${id}`,
    parseListing: extracted({ price: 1390000, address: "דליות 35" }), updatePageData: async (p) => { applied = p; } }));
  t = await turn({ text: "תעדכן את המחיר בדף של דליות 35 ל-1.39 מיליון" }, d);
  assert.deepEqual([t.status, Object.keys(t.draft.pending_page.changes)], ["page_changes_proposed", ["price"]], "'דליות 35' names the page, it is not a new address");
  assert.match(texts(t), /לעדכן בדף 4 חד׳ בפארק\?\nמחיר ₪1,470,000 ← ₪1,390,000/);
  assert.equal(applied, null, "nothing is written before the agent approves");
  const proposed = t.draft;
  t = await turn({ text: "לא", draft: proposed }, d);
  assert.deepEqual([t.status, applied], ["page_kept", null]);
  t = await turn({ text: "1", draft: { ...proposed, last_buttons: ["כן", "לא"] } }, d);
  assert.equal(t.status, "page_updated");
  assert.deepEqual([applied.pagePatch, applied.listingPatch], [{ "property.price": 1390000 }, { price: 1390000 }]);
  // her city bug, fixed from chat: city and the auto title follow
  ({ d } = deps({ classifyIntent: async () => "update", listPages: async () => [{ ...live, property: { ...live.property, city: "נחל דליות 35 באר שבע", neighborhood: null, title: "4 חד׳ בנחל דליות 35 באר שבע" } }],
    editUrl: (id) => id, parseListing: extracted({ city: "באר שבע" }), updatePageData: async (p) => { applied = p; } }));
  t = await turn({ text: "בדף של דליות 35 העיר צריכה להיות באר שבע" }, d);
  t = await turn({ text: "כן", draft: t.draft }, d);
  assert.deepEqual(applied.pagePatch, { "property.city": "באר שבע", "property.title": "4 חד׳ בבאר שבע" });
  // a page named with nothing to change: just the editor link, as before
  ({ d } = deps({ classifyIntent: async () => "update", listPages: async () => [live], editUrl: (id) => id, parseListing: extracted({}) }));
  t = await turn({ text: "תעדכן את התמונות בדף של דליות 35" }, d);
  assert.equal(t.status, "update_link");

  // ── her 11:22 answers: questions are not answers; "הכתובת : …" asked for floor is the address ──
  ({ d } = deps({ parseListing: extracted({ address: "נחל פרת 10" }) }));
  const noCity2 = { ...D.newDraft(PHONE, "text", T0), fields: { ...D.newDraft(PHONE, "text", T0).fields, rooms: 6, price: 1760000 } };
  t = await turn({ text: "חסרים פרטים ?", draft: noCity2 }, d);
  assert.deepEqual([t.status, t.draft], ["question:city", undefined], "nothing is saved from a question");
  assert.match(texts(t), /עוד חסר: עיר · סוג עסקה[\s\S]*באיזו עיר/);
  const atFloor = { ...noCity2, fields: { ...noCity2.fields, city: "באר שבע", deal: "sale", size_sqm: 136 } };
  t = await turn({ text: "הכתובת : נחל פרת 10", draft: atFloor }, d);
  assert.deepEqual([t.draft.fields.address, t.draft.fields.floor], ["נחל פרת 10", null], "not floor 10");
  // the whole ad pasted as an answer is the description too
  ({ d } = deps({ parseListing: extracted({ rooms: 6, price: 1760000 }) }));
  t = await turn({ text: "נכס חדש" }, d);
  t = await turn({ text: "למכירה בפלורנטין 3 חדרים 70 מ״ר קומה 2 מחיר 2,200,000 ₪ משופצת", draft: t.draft }, d);
  assert.match(t.draft.fields.description || "", /משופצת/);

  // ── the batch edit ends: one event with every edited photo → the offer, right away ──
  ({ d } = deps());
  const stale = { ...D.newDraft(PHONE, "photos", T0), status: "offered", offer_sent: true, photos: ["x1", "x2"] };
  t = await turn({ event: "photos_edited", batchDone: true, photos: ["https://fal/1.jpg", "https://fal/2.jpg", "https://fal/3.jpg"], draft: stale }, d);
  assert.deepEqual([t.status, t.draft.photos.length, t.draft.offer_sent], ["offered", 3, true], "this batch only, even under 4 photos");
  assert.match(texts(t), /ערכתי 3 תמונות ✨ לבנות מהן דף נכס\?/);
  t = await turn({ text: "כן", draft: t.draft }, d);
  assert.deepEqual([t.draft.status, t.draft.photos.length, t.status], ["active", 3, "asked:city"]);

  // ── 972542045280, 09-29 12:26: at the preview/create question ──
  const ready8 = { ...D.newDraft(PHONE, "text", T0), fields: { ...FIELDS, description: "d" }, photos: ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"] };
  ({ d } = deps({ classifyIntent: async () => null }));
  // 2 photos, then "תשנה את התמונות בנכס": replace or add? — asked, not ignored
  t = await turn({ fileUrls: ["https://green/n1.jpg", "https://green/n2.jpg"], draft: ready8 }, d);
  t = await turn({ text: "תשנה את התמונות בנכס", draft: t.draft, now: new Date(T0.getTime() + 4000) }, d);
  assert.equal(t.status, "swap_asked");
  assert.match(texts(t), /להחליף את 8 התמונות הקודמות ב-2 החדשות, או להוסיף אותן\?/);
  const swapAsk = t.draft;
  t = await turn({ text: "1", draft: { ...swapAsk, last_buttons: ["להחליף", "להוסיף"] }, now: new Date(T0.getTime() + 9000) }, d);
  assert.deepEqual(t.draft.photos, ["https://files/n1.jpg", "https://files/n2.jpg"], "replaced");
  t = await turn({ text: "להוסיף", draft: swapAsk, now: new Date(T0.getTime() + 9000) }, d);
  assert.equal(t.draft.photos.length, 10, "kept all");
  // no new photos yet: the next ones replace the old
  t = await turn({ text: "תחליף את התמונות", draft: ready8 }, d);
  assert.equal(t.status, "replace_next");
  t = await turn({ fileUrl: "https://green/r1.jpg", draft: t.draft }, d);
  assert.deepEqual(t.draft.photos, ["https://files/r1.jpg"]);

  // "בנכס שיכון ותיקים אני רוצה לעדכן מחיר": another page — the draft waits and comes back
  const vatikim = { page_id: "V1", listing_id: "LV", business_phone: PHONE, property: { title: "4 חד׳ בותיקים", address: "הרצל 5", city: "באר שבע", neighborhood: "ותיקים", price: 1200000, rooms: 4 } };
  let wrote = null;
  ({ d } = deps({ classifyIntent: async () => "update", listPages: async () => [vatikim], editUrl: (id) => `https://agent/edit.html?id=${id}`,
    parseListing: extracted({ price: 1150000 }), updatePageData: async (p) => { wrote = p; } }));
  t = await turn({ text: "בנכס שיכון ותיקים אני רוצה לעדכן מחיר ל-1,150,000", draft: ready8 }, d);
  assert.deepEqual([t.status, t.draft.status, t.draft.suspended.photos.length], ["page_changes_proposed", "updating", 8]);
  t = await turn({ text: "כן", draft: t.draft }, d);
  assert.deepEqual([t.status, wrote.pagePatch["property.price"], t.draft.status, t.draft.photos.length], ["page_updated", 1150000, "active", 8]);
  assert.match(texts(t), /עדכנתי[\s\S]*חוזרים לנכס שבטיפול[\s\S]*תצוגה מקדימה/);
  // price named without a value: the editor link, and the draft still comes back after
  ({ d } = deps({ classifyIntent: async () => "update", listPages: async () => [vatikim], editUrl: (id) => id, parseListing: extracted({}) }));
  t = await turn({ text: "בנכס שיכון ותיקים אני רוצה לעדכן מחיר", draft: ready8 }, d);
  assert.equal(t.status, "update_link");
  ({ d } = deps({ classifyIntent: async () => null }));
  t = await turn({ text: "תודה", draft: t.draft }, d);
  assert.deepEqual([t.handled, t.draft.status, t.draft.photos.length], [false, "active", 8], "the hold ends; the draft is back");
  t = await turn({ text: "תצוגה מקדימה", draft: { ...t.draft, updated_at: new Date(T0.getTime() - 20 * 60000), status: "updating", suspended: ready8 } }, d);
  assert.equal(t.status, "confirm", "an expired hold gives the draft back too");

  // ── 972547221770: the edit request came first, the 12 photos after, with no caption ──
  ({ d } = deps({ classifyIntent: async () => null }));
  const ask12 = "היי פורלי, אני רוצה להעלות 12 תמונות וננקה אותם מעצמים קטנים, נמחק מלל שכתוב מאחורה";
  t = await turn({ text: ask12 }, d);
  assert.deepEqual([t.handled, t.draft.status], [false, "edit_request"], "n8n answers it; the request is remembered");
  const req = t.draft;
  t = await turn({ fileUrls: ["https://green/1.jpg", "https://green/2.jpg"], draft: req, now: new Date(T0.getTime() + 20000) }, d);
  assert.deepEqual([t.handled, t.status, t.edit_photos.length, t.edit_instruction], [false, "edit_requested", 2, ask12], "edited with his instruction, no 1/2/3/4");
  t = await turn({ fileUrl: "https://green/3.jpg", draft: req, now: new Date(T0.getTime() + 11 * 60000) }, d);
  assert.equal(t.draft.status, "photo_choice", "10 quiet minutes later it's over");
  t = await turn({ text: "היי", draft: req }, d);
  assert.deepEqual([t.handled, t.del], [false, true], "other text ends it");
  t = await turn({ text: "מה שלומך היום" }, d);
  assert.equal(t.draft, undefined, "talk that isn't about editing photos leaves nothing behind");

  // mid-draft, a price update that names no page is the draft's own price
  ({ d } = deps({ classifyIntent: async () => "update", listPages: async () => [vatikim], editUrl: (id) => id, parseListing: extracted({}) }));
  t = await turn({ text: "אני רוצה לעדכן מחיר בנכס", draft: ready8 }, d);
  assert.deepEqual([t.handled, t.status, t.draft], [true, "field_list", undefined], "no live page touched, the draft stays open");
  assert.match(texts(t), /\/מחיר/);

  // 972542045280, 12:49: "עיר באר שבע" while the price is asked corrects the city (after asking)
  ({ d } = deps({ parseListing: extracted({ city: "בר שבע" }) }));
  const atPrice = { ...D.newDraft(PHONE, "keyword", T0), fields: { ...D.newDraft(PHONE, "keyword", T0).fields, city: "בל שבע", rooms: 4, floor: 2 } };
  t = await turn({ text: "עיר באר שבע", draft: atPrice }, d);
  assert.equal(t.status, "confirm_changes", "not 'invalid:price'");
  assert.match(texts(t), /עיר בל שבע ← באר שבע/);
  t = await turn({ text: "כן", draft: t.draft }, d);
  assert.deepEqual([t.draft.fields.city, t.status], ["באר שבע", "asked:price"]);

  // his real timing: 2 photos + "תשנה את התמונות בנכס" 4 s apart = one n8n bundle → still asked
  ({ d } = deps({ classifyIntent: async () => null }));
  t = await turn({ text: "תשנה את התמונות בנכס", fileUrls: ["https://green/z1.jpg", "https://green/z2.jpg"], draft: ready8 }, d);
  assert.match(texts(t), /להחליף את 8 התמונות הקודמות ב-2 החדשות/);
  assert.equal(t.draft.photos.length, 10, "nothing replaced before the answer");

  // staging e2e 09-29: the waiting draft was already at preview (its prompt needs deps.reviewLink)
  const previewing = { ...ready8, mode: "preview" };
  wrote = null;
  ({ d } = deps({ classifyIntent: async () => "update", listPages: async () => [vatikim], editUrl: (id) => id,
    parseListing: extracted({ price: 1150000 }), updatePageData: async (p) => { wrote = p; } }));
  t = await turn({ text: "בנכס שיכון ותיקים אני רוצה לעדכן מחיר ל-1,150,000", draft: previewing }, d);
  const waiting = t.draft;
  t = await turn({ text: "לא", draft: waiting }, d);
  assert.deepEqual([t.status, t.draft.status, wrote], ["page_kept", "active", null]);
  assert.match(texts(t), /חוזרים לנכס שבטיפול[\s\S]*https:\/\/review/);
  t = await turn({ text: "כן", draft: waiting }, d);
  assert.deepEqual([t.status, t.draft.mode, wrote.pagePatch["property.price"]], ["page_updated", "preview", 1150000]);

  // ── 972546582548, 13:02–13:13: after an edit batch, "אני רוצה להעלות נכס חדש…", the ad, "יש תמונות?" ──
  const edited8 = { ...D.newDraft(PHONE, "photos", T0), status: "offered", offer_sent: true, photos: ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"] };
  ({ d } = deps({ classifyIntent: async () => "new", parseListing: extracted({ city: "באר שבע", rooms: 6, price: 1760000, deal: "sale", size_sqm: 136, floor: 2, parking: 2, neighborhood: "הפארק" }) }));
  t = await turn({ text: "אני רוצה להעלות נכס חדש שתיצרי לי דף נכס .", draft: edited8 }, d);
  assert.deepEqual([t.draft.status, t.draft.photos.length, t.draft.offered_photos.length], ["active", 0, 8], "a new property; the edited photos kept on hand");
  t = await turn({ text: "למכירה בפלורנטין 3 חדרים 70 מ״ר קומה 2 מחיר 2,200,000 ₪ משופצת", draft: t.draft }, d);
  assert.match(texts(t), /להשתמש ב-8 התמונות שערכתי קודם לנכס הזה\?/, "at the photos step, asked about them");
  t = await turn({ text: "כן", draft: t.draft }, d);
  assert.deepEqual([t.draft.photos.length, t.status], [8, "choose"]);
  // "כן תיצרי דף נכס" to the offer itself is a yes
  t = await turn({ text: "כן תיצרי דף נכס", draft: edited8 }, d);
  assert.deepEqual([t.draft.status, t.draft.photos.length], ["active", 8]);

  // ── 972546582548, 09-29 10:04: "אני רוצה לעדכן תמונות לנכס בנחל דליות 35", then 10 photos ──
  const dalyot = { page_id: "P2", listing_id: "L2", business_phone: PHONE, gallery: { images: [1, 2, 3, 4].map((i) => ({ url: `old${i}`, caption: "", description: "" })) },
    property: { title: "4 חד׳ בפארק", address: "נחל דליות 35", city: "באר שבע", neighborhood: "הפארק", price: 1470000, rooms: 4 } };
  let gal = null;
  ({ d } = deps({ classifyIntent: async () => "update", listPages: async () => [dalyot], editUrl: (id) => `https://agent/edit.html?id=${id}`,
    parseListing: extracted({}), updatePageData: async (p) => { gal = p; } }));
  t = await turn({ text: "אני רוצה לעדכן תמונות לנכס בנחל דליות 35" }, d);
  assert.match(texts(t), /שלחו כאן את התמונות החדשות/);
  t = await turn({ fileUrls: ["https://green/a.jpg", "https://green/b.jpg"], draft: t.draft }, d);
  assert.deepEqual([t.status, t.replies.length, t.armPhotoTimer, gal], ["page_photos_held:2", 0, true, null], "held silently, never AI-edited");
  t = await turn({ event: "photo_timer", draft: t.draft }, d);
  assert.match(texts(t), /להחליף את 4 התמונות הקיימות ב-2 החדשות, או להוסיף אותן\?/);
  const photosAsked = t.draft;
  t = await turn({ text: "להחליף", draft: structuredClone(photosAsked) }, d);
  assert.deepEqual(gal.pagePatch["gallery.images"].map((i) => i.url), ["https://files/a.jpg", "https://files/b.jpg"]);
  assert.deepEqual(gal.listingPatch.photos_urls, ["https://files/a.jpg", "https://files/b.jpg"]);
  assert.match(texts(t), /בדף יש עכשיו 2 תמונות/);
  t = await turn({ text: "2", draft: { ...structuredClone(photosAsked), last_buttons: ["להחליף", "להוסיף"] } }, d);
  assert.equal(gal.pagePatch["gallery.images"].length, 6, "added after the 4");

  // ── no draft, but the chat has the ad and edited photos: "תעשי איך שנראה לך" builds from them ──
  const nowS = Math.floor(T0.getTime() / 1000);
  const chat = [ // newest first, like Green API
    { type: "outgoing", typeMessage: "textMessage", textMessage: "איזה כותרת תרצה לדף הנכס?", timestamp: nowS - 60 },
    { type: "incoming", typeMessage: "textMessage", textMessage: "למכירה בפלורנטין 3 חדרים 70 מ״ר קומה 2 מחיר 2,200,000 ₪ משופצת", timestamp: nowS - 600 },
    { type: "outgoing", typeMessage: "imageMessage", downloadUrl: "https://fal/e2.jpg", timestamp: nowS - 1200 },
    { type: "outgoing", typeMessage: "imageMessage", downloadUrl: "https://fal/e1.jpg", timestamp: nowS - 1300 },
    { type: "incoming", typeMessage: "imageMessage", downloadUrl: "https://green/o1.jpg", timestamp: nowS - 1500 },
  ];
  let ctxSeen = null;
  ({ d } = deps({ recentChat: async () => chat, resolve: async ({ text }) => ({ source: "text", text, photos: [] }),
    classifyIntent: async (txt, ctx) => { ctxSeen = ctx; return ctx ? "new" : null; } }));
  t = await turn({ text: "תערכי איך שנראה לך לנכון שיהיה אמין" }, d);
  assert.equal(t.status.startsWith("recovered:"), true);
  assert.deepEqual([t.draft.fields.price, t.draft.offered_photos], [2900000, ["https://files/e1.jpg", "https://files/e2.jpg"]], "the ad's fields, the edited photos (not the original)");
  assert.match(ctxSeen, /Forly: איזה כותרת/);
  assert.match(texts(t), /אספתי מהשיחה את פרטי הנכס מהמודעה ו-2 תמונות/);
  // nothing in the chat to build from: no LLM call at all
  let calls = 0;
  ({ d } = deps({ recentChat: async () => [{ type: "incoming", typeMessage: "textMessage", textMessage: "היי", timestamp: nowS - 60 }], classifyIntent: async () => { calls++; return "new"; } }));
  t = await turn({ text: "תעשי איך שנראה לך" }, d);
  assert.deepEqual([t.handled, calls], [false, 0]);

  // 972547221770 answered the offer with "1." — the dot doesn't make it something else
  ({ d } = deps());
  t = await turn({ text: "1.", draft: { ...edited8, last_buttons: ["כן", "לא"] } }, d);
  assert.deepEqual([t.draft.status, t.draft.photos.length], ["active", 8]);
  t = await turn({ text: "3.", draft: choice }, d);
  assert.equal(t.status, "edit_photos");

  console.log("whatsapp-flows.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
