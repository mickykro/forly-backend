/* property-draft.js — pure helpers behind the WhatsApp property chat. */
const assert = require("assert");
const D = require("./property-draft");

// ── links, commands, openers ──
assert.equal(D.findUrl("תראה https://www.yad2.co.il/item/abc."), "https://www.yad2.co.il/item/abc");
assert.equal(D.findUrl("(http://madlan.co.il/x?y=1)"), "http://madlan.co.il/x?y=1");
assert.equal(D.findUrl("no link"), null);
assert.equal(D.findUrl(null), null);

assert.equal(D.command(" ביטול "), "cancel");
assert.equal(D.command("דלג"), "skip");
assert.equal(D.command("ממשיכים!"), "continue");
assert.equal(D.command("כן"), "yes");
assert.equal(D.command("לא"), "no");
assert.equal(D.command("המשך"), "resume");
assert.equal(D.command("חדש"), "new");
assert.equal(D.command("כן בבקשה"), null);
assert.equal(D.command("להמשיך אותה"), "resume");
assert.equal(D.command("להמשיך"), "resume");
assert.deepEqual(["עזרה", "הוראות", "מדריך", "איך משתמשים?", "איך זה עובד", "עזרו לי"].map(D.command),
  ["help", "help", "help", "help", "help", "help"], "the words an agent reaches for when lost");
assert.equal(D.command("איך משתמשים במעלית שבת"), null, "a help word inside a sentence is not a help request");
assert.deepEqual(["נכס חדש", "להתחיל נכס חדש", "להתחיל חדש"].map(D.command), ["new", "new", "new"],
  "the longer forms the resume prompt's own question suggests");
assert.deepEqual(["לבטל", "בטל", "לבטל את הטיוטה"].map(D.command), ["cancel", "cancel", "cancel"]);

assert.equal(D.openerKind("https://x.co/1"), "link");
assert.equal(D.openerKind("נכס חדש"), "keyword");
assert.equal(D.openerKind("ליצור נכס"), "keyword");
assert.equal(D.openerKind("ליצור נכס!"), "keyword");
assert.equal(D.openerKind("דף נכס"), "keyword");
assert.equal(D.openerKind("למכירה בפלורנטין 3 חדרים 70 מ״ר קומה 2 מחיר 2,200,000 ₪ משופצת"), "text");
assert.equal(D.openerKind("היי מה שלומך"), null);
assert.equal(D.openerKind("3 חדרים"), null, "too short to be a listing");

// ── answer parsers ──
assert.equal(D.parseAnswer("price", "2,900,000"), 2900000);
assert.equal(D.parseAnswer("price", "2.9M"), 2900000);
assert.equal(D.parseAnswer("price", "2.9 מיליון"), 2900000);
assert.equal(D.parseAnswer("price", "2.9 מליון"), 2900000, "common spelling without the yod");
assert.equal(D.parseAnswer("price", "2.9M"), 2900000);
assert.equal(D.parseAnswer("price", "750 אלפים"), 750000);
assert.equal(D.parseAnswer("price", "890 אלף"), 890000);
assert.equal(D.parseAnswer("price", "12,000 לחודש"), 12000);
assert.equal(D.parseAnswer("price", "לא יודע"), null);
assert.equal(D.parseAnswer("price", "2.9"), null, "bare shorthand is re-asked, not stored as ₪3");
assert.equal(D.parseAnswer("price", "3"), null);
assert.equal(D.parseAnswer("rooms", "3.5"), 3.5);
assert.equal(D.parseAnswer("rooms", "4 חדרים"), 4);
assert.equal(D.parseAnswer("rooms", "הרבה"), null);
assert.equal(D.parseAnswer("size_sqm", "כ-85 מ״ר"), 85);
assert.equal(D.parseAnswer("floor", "קומה 3"), 3);
assert.equal(D.parseAnswer("floor", "קרקע"), 0);
assert.equal(D.parseAnswer("parking", "אין"), 0);
assert.equal(D.parseAnswer("parking", "2"), 2);
assert.equal(D.parseAnswer("deal", "להשכרה"), "rent");
assert.equal(D.parseAnswer("deal", "מכירה"), "sale");
assert.equal(D.parseAnswer("deal", "אולי"), null);
assert.equal(D.parseAnswer("city", "  תל אביב "), "תל אביב");
assert.equal(D.parseAnswer("city", "   "), null);
assert.equal(D.parseAnswer("neighborhood", "x".repeat(100)).length, 60);
assert.equal(D.parseAnswer("description", "y".repeat(3000)).length, 2000);
assert.equal(D.isRequired("city"), true);
assert.equal(D.isRequired("floor"), false);
assert.deepEqual(D.ASK_ORDER, ["city", "price", "rooms", "deal", "size_sqm", "floor", "parking", "neighborhood", "description"], "the design is asked only on the create path");
assert.deepEqual(D.TEMPLATE_KEYS, ["original", "nocturne", "reel", "atelier", "loupe", "orbite"], "same order as create.html's picker");
assert.deepEqual(["בכפר סבא", "ברמת גן", "באר שבע", "בבאר שבע", "בני ברק", "חיפה"].map((t) => D.parseAnswer("city", t)),
  ["כפר סבא", "רמת גן", "באר שבע", "באר שבע", "בני ברק", "חיפה"], "spoken 'in <city>' drops the ב, real ב-cities keep it");
assert.deepEqual([["size_sqm", "100 ו-10."], ["size_sqm", "מאה ועשר"], ["floor", "קומה אחת"], ["floor", "קומה שנייה"], ["rooms", "שלוש וחצי"],
  ["floor", "2 מתוך 6"], ["size_sqm", "ועשר מטר"], ["rooms", "40"]].map(([f, t]) => D.parseAnswer(f, t)),
  [110, 110, 1, 2, 3.5, 2, null, null], "spoken numbers; impossible values are rejected");
assert.equal(D.parseAnswer("template", "2"), "nocturne");
assert.equal(D.parseAnswer("template", "2 נוקטורן"), "nocturne");
assert.equal(D.parseAnswer("template", "קלאסי"), "original");
assert.equal(D.parseAnswer("template", " Reel "), "reel");
assert.equal(D.parseAnswer("template", "לופ"), "loupe");
assert.equal(D.parseAnswer("template", "7"), null);
assert.equal(D.parseAnswer("template", "מודרני"), null);

// ── draft state ──
const t0 = new Date("2026-09-12T10:00:00Z");
const d = D.newDraft("972501234567", "keyword", t0);
assert.equal(d.status, "active");
assert.equal(d.fields.city, null);
assert.equal(d.fields.description, null);
assert.equal(d.offer_sent, false);
assert.ok("elevator" in d.fields, "fields carry every extractor key");
assert.deepEqual(D.nextStep(d), { kind: "ask", field: "city" });

d.fields.city = "חיפה"; d.fields.price = 1500000; d.fields.rooms = 4;
assert.deepEqual(D.nextStep(d), { kind: "ask", field: "deal" });
d.skipped.push("deal", "size_sqm", "floor", "parking", "neighborhood", "description");
assert.deepEqual(D.nextStep(d), { kind: "photos" });
d.photos.push("a", "b");
assert.deepEqual(D.nextStep(d), { kind: "photos" });
d.photos.push("c");
assert.deepEqual(D.nextStep(d), { kind: "photos" });
d.photos.push("d");
assert.deepEqual(D.nextStep(d), { kind: "choose" });
assert.deepEqual(D.nextStep({ ...d, mode: "preview" }), { kind: "confirm" });
assert.deepEqual(D.nextStep({ ...d, mode: "create" }), { kind: "ask", field: "template" });
assert.deepEqual(D.nextStep({ ...d, mode: "create", skipped: [...d.skipped, "template"] }), { kind: "create" });
assert.deepEqual(D.nextStep({ ...d, mode: "create", fields: { ...d.fields, template: "reel" } }), { kind: "create" });
assert.deepEqual([D.command("תצוגה מקדימה"), D.command("ליצור"), D.command("צור")], ["preview", "create", "create"]);
const lb = D.listingBody({ ...d, fields: { ...d.fields, deal: "rent", template: "loupe", sqm_balcony: 12 } });
assert.deepEqual([lb.listing_type, lb.city, lb.price, lb.size_balcony, lb.theme, lb.photos_urls.length], ["rent", "חיפה", 1500000, 12, { template: "loupe" }, 4]);

assert.equal(D.isPaused(d, new Date(t0.getTime() + D.PAUSE_MS - 1)), false);
assert.equal(D.isPaused(d, new Date(t0.getTime() + D.PAUSE_MS + 1)), true);
assert.equal(D.isPaused({ ...d, status: "building" }, new Date(t0.getTime() + D.PAUSE_MS + 1)), false);
assert.equal(D.isExpiredPrompt({ ...d, status: "offered" }, new Date(t0.getTime() + D.PAUSE_MS + 1)), true);
assert.equal(D.isExpiredPrompt({ ...d, status: "offered" }, t0), false);
assert.equal(D.isExpiredPrompt(d, new Date(t0.getTime() + D.PAUSE_MS + 1)), false);

const s = D.summary(d);
assert.deepEqual([s.city, s.price, s.rooms, s.photos], ["חיפה", 1500000, 4, 4]);

const t1 = new Date(t0.getTime() + 1000);
assert.equal(D.touch(d, t1).updated_at, t1);

// A price only one deal type can explain answers "למכירה או להשכרה?" by itself.
const dealOf = (price, deal = null) =>
  D.touch({ ...d, fields: { ...d.fields, price, deal } }).fields.deal;
assert.equal(dealOf(2900000), "sale");
assert.equal(dealOf(8500), "rent");
assert.equal(dealOf(60000), null, "an ambiguous price still asks");
assert.equal(dealOf(2.9), null, "a bare 2.9 is nobody's rent");
assert.equal(dealOf(2900000, "rent"), "rent", "an explicit answer is never overwritten");
const afterPrice = D.touch({ ...d, skipped: [], fields: { ...d.fields, price: 2900000, deal: null } });
assert.notDeepEqual(D.nextStep(afterPrice), { kind: "ask", field: "deal" },
  "deal is not asked once it is inferred");

console.log("property-draft.test.js ok");
