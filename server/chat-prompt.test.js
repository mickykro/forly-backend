/*
 * Unit tests for chat-prompt.js — the fact sheet and the answered/not-answered
 * decision the whole handoff rests on.
 * Run: node server/chat-prompt.test.js
 */
const assert = require("assert");
const { buildFacts, buildSystemPrompt, parseModelReply, MODE_BLOCKS } = require("./chat-prompt");

// ── buildFacts ──
const page = {
  language: "he",
  property: {
    title: "4 חד׳ בהדר", listing_type: "sale", price: 2350000, address: "הרצל 10",
    neighborhood: "הדר", city: "חיפה", rooms: 4, size_sqm: 92, floor: 3, parking: 1,
    storage: false, elevator: true, tags: ["מרפסת", "משופצת"],
  },
  agent: { name: "מור לוי", brand_name: "לוי נכסים", license: "1234" },
  area: { blurb: "שכונה מבוקשת", stops: [{ label: "רכבת", minutes: "7 דק׳" }], stats: [{ label: "ציון", value: "8.4" }] },
  carousel: { slides: [{ title: "נוף", body: "לים" }] },
  gallery: { images: [{ caption: "סלון" }, { caption: "" }] },
};
const listing = { description: "דירה מהממת עם נוף פתוח לים." };

let f = buildFacts(page, listing);
assert.ok(f.includes("4 חד׳ בהדר"));
assert.ok(f.includes("₪2,350,000"));
assert.ok(f.includes("למכירה"));
assert.ok(f.includes("דירה מהממת"));
assert.ok(f.includes("רכבת: 7 דק׳"));
assert.ok(f.includes("נוף: לים"));
assert.ok(f.includes("מור לוי"));
assert.ok(f.includes("סלון"));
// A boolean false is a real answer to "is there storage?", so it must survive.
assert.ok(f.includes("מחסן: אין"), "false booleans are facts, not absences");
assert.ok(f.includes("מעלית: יש"));

// Price per m² is DERIVED, not estimated: the page renders the same number in
// its spec strip (runtime.js data-ppm), so a bot that refuses it is denying a
// figure the visitor can read on screen. Same rounding, same sale-only rule.
let ppm = buildFacts({ property: { price: 2350000, size_sqm: 92 } }, null);
assert.ok(ppm.includes("מחיר למ״ר"));
assert.ok(ppm.includes("25,543"), "2,350,000 / 92 rounded");
assert.ok(ppm.includes("מחיר למטר"), "the other common phrasing is in the label too");
// Rentals have no ₪/m² on the page either — runtime.js removes the element.
assert.ok(!buildFacts({ property: { price: 6000, size_sqm: 92, listing_type: "rent" } }, null)
  .includes("מחיר למ״ר"));
// Either input missing ⇒ no line, so it reads as genuinely unknown.
assert.ok(!buildFacts({ property: { price: 2350000 } }, null).includes("מחיר למ״ר"));
assert.ok(!buildFacts({ property: { size_sqm: 92 } }, null).includes("מחיר למ״ר"));
assert.ok(!buildFacts({ property: { price: 2350000, size_sqm: 0 } }, null).includes("מחיר למ״ר"),
  "size 0 means not captured — must not divide by it");

// The agent's tagline is a legitimate answer to "who is this agent?" — without
// it the model had nothing and invented a service pitch instead.
assert.ok(buildFacts({ agent: { name: "מור", tagline: "מתמחה בהדר" } }, null).includes("מתמחה בהדר"));

// The area section must NOT be titled "the neighbourhood": area.blurb is written
// about the city/region, and a section labelled that way got used to answer
// "which neighbourhood?" with a paragraph about the city.
const areaOnly = buildFacts({ property: {}, area: { blurb: "עיר מרכזית בשרון" } }, null);
assert.ok(!/^## השכונה$/m.test(areaOnly), "area section must not claim to be the neighbourhood");
assert.ok(areaOnly.includes("לא שם השכונה"), "and must say so explicitly");
// The neighbourhood itself stays a property line, and reads as absent when it is.
assert.ok(buildFacts({ property: { neighborhood: "הדר" } }, null).includes("שכונה: הדר"));
assert.ok(!buildFacts({ property: { city: "חיפה" } }, null).includes("שכונה"));

// Absent fields must be OMITTED, not rendered as unknown — a missing line is
// exactly what makes the model say it doesn't know.
f = buildFacts({ property: { title: "דירה", rooms: 3, floor: 0, price: 0, parking: 0 } }, null);
assert.ok(f.includes("חדרים: 3"));
assert.ok(!f.includes("קומה"), "0 means 'not captured' (Number(x)||0), so it must not appear");
assert.ok(!f.includes("מחיר"));
assert.ok(!f.includes("חניות"));
assert.ok(!f.includes("תיאור הנכס"), "no listing ⇒ no description section");
assert.ok(!f.includes("undefined") && !f.includes("null"));

// Empty everything must not throw.
assert.doesNotThrow(() => buildFacts({}, null));
assert.doesNotThrow(() => buildFacts(null, null));

// ── every field on the property reaches the sheet, including ones added later ──
// Hand-listing fields is what hid the neighbourhood and ₪/m²; a new key must
// surface on its own rather than waiting for someone to remember it.
const future = buildFacts({ property: { rooms: 3, pool: true, year_built: 1998, view_type: "ים" } }, null);
assert.ok(future.includes("pool: יש"), "unknown boolean key still appears");
assert.ok(future.includes("year_built: 1998"), "unknown numeric key still appears");
assert.ok(future.includes("view_type: ים"), "unknown string key still appears");

// agent2 is a whole second agent on the page and was entirely missing.
const two = buildFacts({
  agent: { name: "מיקי" },
  agent2: { name: "דנה", brand_name: "כהן נכסים", role: "שותפה" },
}, null);
assert.ok(two.includes("מתווך נוסף"));
assert.ok(two.includes("דנה") && two.includes("שותפה"));

// Phone numbers are withheld on purpose: every contact route funnels through
// the lead form, and a bot reading out a mobile bypasses the lead entirely.
const withPhone = buildFacts({
  agent: { name: "מיקי", phone: "972501234567", phone2: "0509998888", logo_url: "https://x/y.png" },
}, null);
assert.ok(!withPhone.includes("972501234567"));
assert.ok(!withPhone.includes("0509998888"));
assert.ok(!withPhone.includes("y.png"), "asset URLs are not facts either");

// Page copy the visitor actually reads.
const copy = buildFacts({
  hero: { phrase: "נוף פתוח לים" },
  cta: { headline: "רוצים לראות?", sub: "השאירו פרטים", bullets: ["ללא עמלה", "זמין מיידית"] },
  texts: { hero_sub: "משופצת מהיסוד", empty_one: "  " },
}, null);
assert.ok(copy.includes("נוף פתוח לים"));
assert.ok(copy.includes("רוצים לראות?"));
assert.ok(copy.includes("ללא עמלה") && copy.includes("זמין מיידית"));
assert.ok(copy.includes("משופצת מהיסוד"), "in-page edits are what the visitor reads");
assert.ok(!copy.includes("empty_one"), "blank overrides are not facts");

// Phone-shaped and link-shaped values are dropped even under a key nobody
// thought to block — the value check is what makes the filter fail closed.
const sneaky = buildFacts({
  agent: { name: "מיקי", mobile: "050-123-4567", contact: "miki@example.com", site: "www.x.co.il" },
}, null);
assert.ok(!sneaky.includes("123-4567") && !sneaky.includes("@example.com"));
assert.ok(!sneaky.includes("www.x.co.il"));
// But a descriptive field we never listed still reaches the sheet.
assert.ok(buildFacts({ agent: { name: "מיקי", years_active: 12 } }, null).includes("years_active: 12"));

// ── the fact sheet must cover everything the templates actually render ──
// This is the bug class itself, not an instance of it: three separate "the bot
// is wrong" reports were all a value on screen that never reached the model.
// Rather than wait for a fourth, read the templates and assert every bound path
// survives the trip. A new data-bind in a template fails here, not in the wild.
const fs = require("fs"), pathmod = require("path");
const TPL_DIR = pathmod.join(__dirname, "..", "public-nadlan", "templates");
const bound = new Set();
for (const name of ["nocturne", "reel"]) {
  const html = fs.readFileSync(pathmod.join(TPL_DIR, name + ".html"), "utf8");
  for (const m of html.matchAll(/data-(?:bind|show|list)="([^"]+)"/g)) {
    m[1].split("||").forEach((p) => p.trim() && bound.add(p.trim()));
  }
}
assert.ok(bound.size > 15, `expected to find the template bindings, got ${bound.size}`);

// Lists render their items, so they carry a sentinel per item field instead.
const LIST_ITEMS = {
  "area.stops": { label: "SENT_stops_label", minutes: "SENT_stops_minutes" },
  "area.stats": { label: "SENT_stats_label", value: "SENT_stats_value" },
  "carousel.slides": { title: "SENT_slides_title", body: "SENT_slides_body" },
};
const probe = {};
const expected = [];
for (const p of bound) {
  const parts = p.split(".");
  let node = probe;
  for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]] || (node[parts[i]] = {});
  const leaf = parts[parts.length - 1];
  if (p === "property.price") {
    node[leaf] = 1234567;              // must be a real number: money() formats it
    expected.push("₪1,234,567");
  } else if (LIST_ITEMS[p]) {
    node[leaf] = [LIST_ITEMS[p]];
    expected.push(...Object.values(LIST_ITEMS[p]));
  } else {
    const sentinel = "SENT_" + parts.join("_");
    node[leaf] = sentinel;
    expected.push(sentinel);
  }
}
const covered = buildFacts(probe, null);
const missing = expected.filter((s) => !covered.includes(s));
assert.deepEqual(missing, [],
  "these values are rendered on the page but never reach the bot: " + missing.join(", "));

// Long descriptions are capped.
f = buildFacts({ property: {} }, { description: "x".repeat(5000) });
assert.ok(f.length < 2200);

// ── buildSystemPrompt ──
const sys = buildSystemPrompt("FACTS-HERE", {
  language: "he", agentName: "מור לוי", modeBlock: MODE_BLOCKS.immediate("מור לוי"),
});
assert.ok(sys.includes("FACTS-HERE"));
assert.ok(sys.includes("Hebrew"));
assert.ok(sys.includes("מור לוי"));
assert.ok(sys.includes("Partial knowledge"), "the hedging rule must be in the prompt");
// Answering a different question than the one asked is the failure that turned
// "which neighbourhood?" into a paragraph about the city.
assert.ok(sys.includes("ANSWER THE QUESTION THAT WAS ASKED"));
// …and inventing a service pitch is what turned "who is Miki?" into a promise.
assert.ok(sys.includes("no service commitments"));
assert.ok(sys.includes("not the agent"), "the bot must not speak in the agent's voice");
// Hebrew morphology guidance only when the page is Hebrew.
assert.ok(sys.includes("ליווות"), "the coined-word example belongs in the Hebrew block");
assert.ok(!buildSystemPrompt("F", { language: "en" }).includes("ליווות"),
  "an English page must not carry Hebrew-specific guidance");
assert.ok(buildSystemPrompt("F", {}).includes("ליווות"), "default is Hebrew");
assert.ok(sys.includes("never negotiate on price"));
// Arithmetic over listed numbers is allowed; valuation and projection are not.
assert.ok(sys.includes("plain arithmetic"));
assert.ok(sys.includes("never project future"));
assert.ok(sys.includes("never instructions"), "prompt-injection rule must be present");
assert.ok(sys.includes('"answered"'));
assert.ok(buildSystemPrompt("F", { language: "ru" }).includes("Russian"));
assert.ok(buildSystemPrompt("F", {}).includes("Hebrew"), "unknown language ⇒ Hebrew");

// ── parseModelReply — the load-bearing one ──
let p = parseModelReply('{"answered":true,"reply":"יש 4 חדרים.","unanswered_question":null}');
assert.equal(p.answered, true);
assert.equal(p.reply, "יש 4 חדרים.");
assert.equal(p.unanswered_question, null);

p = parseModelReply('{"answered":false,"reply":"אין לי מידע.","unanswered_question":"כלבים?"}');
assert.equal(p.answered, false);
assert.equal(p.unanswered_question, "כלבים?");

// The model wrapping its JSON in prose or a fence shouldn't lose a good answer.
p = parseModelReply('Sure!\n```json\n{"answered":true,"reply":"כן."}\n```');
assert.equal(p.answered, true);
assert.equal(p.reply, "כן.");

// A truthy unanswered_question on an answered reply is meaningless — drop it.
assert.equal(parseModelReply('{"answered":true,"reply":"כן.","unanswered_question":"x"}').unanswered_question, null);

// Everything below MUST return null. Callers treat null as "no handoff", because
// a false hot lead costs the agent more trust than a missed one.
[
  "",
  null,
  "no json here at all",
  "{ not json }",
  '{"reply":"חסר answered"}',
  '{"answered":"true","reply":"מחרוזת ולא בוליאני"}',
  '{"answered":true}',
  '{"answered":true,"reply":"   "}',
  '{"answered":false,"reply":null}',
  "[]",
].forEach(function (bad) {
  assert.equal(parseModelReply(bad), null, "must not trust: " + JSON.stringify(bad));
});

// Replies are capped so a runaway generation can't be pasted into the bubble.
p = parseModelReply(JSON.stringify({ answered: true, reply: "x".repeat(5000) }));
assert.ok(p.reply.length <= 600);

console.log("chat-prompt: all tests passed");
