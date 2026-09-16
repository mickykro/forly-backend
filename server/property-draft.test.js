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

assert.equal(D.openerKind("https://x.co/1"), "link");
assert.equal(D.openerKind("נכס חדש"), "keyword");
assert.equal(D.openerKind("דף נכס"), "keyword");
assert.equal(D.openerKind("למכירה בפלורנטין 3 חדרים 70 מ״ר קומה 2 מחיר 2,200,000 ₪ משופצת"), "text");
assert.equal(D.openerKind("היי מה שלומך"), null);
assert.equal(D.openerKind("3 חדרים"), null, "too short to be a listing");

// ── answer parsers ──
assert.equal(D.parseAnswer("price", "2,900,000"), 2900000);
assert.equal(D.parseAnswer("price", "2.9M"), 2900000);
assert.equal(D.parseAnswer("price", "2.9 מיליון"), 2900000);
assert.equal(D.parseAnswer("price", "890 אלף"), 890000);
assert.equal(D.parseAnswer("price", "12,000 לחודש"), 12000);
assert.equal(D.parseAnswer("price", "לא יודע"), null);
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
assert.deepEqual(D.ASK_ORDER, ["city", "price", "rooms", "deal", "size_sqm", "floor", "parking", "neighborhood", "description"]);

console.log("property-draft.test.js (parsers) ok");
