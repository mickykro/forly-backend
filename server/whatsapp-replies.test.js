/* whatsapp-replies.js — every reply is a { text, buttons? } with command-word buttons. */
const assert = require("assert");
const R = require("./whatsapp-replies");
const COMMANDS = new Set(["כן", "לא", "ביטול", "דלג", "ממשיכים", "המשך", "חדש", "למכירה", "להשכרה"]);

const sum = { city: "חיפה", neighborhood: null, price: 1500000, rooms: 4, deal: "sale", size_sqm: 90, floor: 3, parking: 1, photos: 5 };
const all = [
  R.offer(4), R.opened("link", { rooms: 3.5, city: "תל אביב", neighborhood: "פלורנטין", price: 2900000 }),
  R.opened("keyword", {}), R.opened("text", { rooms: null, city: null, price: null }),
  ...["city", "price", "rooms", "deal", "size_sqm", "floor", "parking", "neighborhood", "description"].map(R.ask),
  R.invalid("price"), R.required("city"), R.askPhotos(), R.photosProgress(2), R.photosProgress(4), R.photosSaved(1),
  R.confirm(sum), R.building(sum), R.cancelled(), R.declined(), R.resumePrompt(sum),
  ...["page_unreadable", "facebook_not_connected", "extract_unavailable", "whatever"].map((c) => R.sourceError(c, "https://a/create.html")),
  R.extractLimit("https://a/create.html"), R.createFailed("https://a/create.html"), R.noLinkHint("https://a/create.html"),
];
for (const r of all) {
  assert.ok(r && typeof r.text === "string" && r.text.trim(), "every reply has text");
  for (const b of r.buttons || []) {
    assert.ok(COMMANDS.has(b), `button "${b}" must be a command word`);
    assert.ok(b.length <= 25);
  }
  assert.ok(!r.buttons || r.buttons.length <= 3);
}
assert.deepEqual(R.offer(4).buttons, ["כן", "לא"]);
assert.deepEqual(R.confirm(sum).buttons, ["כן", "ביטול"]);
assert.deepEqual(R.resumePrompt(sum).buttons, ["המשך", "חדש"]);
assert.deepEqual(R.photosProgress(4).buttons, ["ממשיכים"]);
assert.equal(R.photosProgress(2).buttons, undefined, "under 3 photos: ask for more, no continue button");
assert.deepEqual(R.ask("deal").buttons, ["למכירה", "להשכרה"]);
assert.match(R.ask("floor").text, /דלג/, "optional questions mention skip");
assert.doesNotMatch(R.ask("city").text, /דלג/, "required questions do not");
assert.match(R.confirm(sum).text, /1,500,000/);
assert.match(R.confirm(sum).text, /5 תמונות/);
assert.match(R.opened("link", { rooms: 3.5, city: "תל אביב", neighborhood: "פלורנטין", price: 2900000 }).text, /3\.5 חד׳ בפלורנטין/);
assert.equal(R.LABELS.size_sqm, "שטח במ״ר");
console.log("whatsapp-replies.test.js ok");
