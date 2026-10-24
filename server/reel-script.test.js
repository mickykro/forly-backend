const assert = require("assert");
const { writeScript, validateScript, fallbackScript, buildPrompt, buildEndCard, tagFor, formatPhone, wrapSubtitle } = require("./reel-script");

const clips = [{ duration: 5, spaces: ["S1"] }, { duration: 11, spaces: ["S2"] }];
const spaces = [
  { id: "S1", type: "balcony", photos: [{ shows: ["railing", "city view"] }] },
  { id: "S2", type: "living_room", photos: [{ shows: ["sofa"] }, { shows: ["hanging chair", "sofa"] }] },
];
const sale = { listing_type: "sale", price: 1350000, rooms: 3, size_sqm: 120, floor: 8, neighborhood: "הפארק", city: "באר שבע" };
const rent = { listing_type: "rent", price: 6500, size_sqm: 182, floor: 9, city: "באר שבע" };

assert.equal(formatPhone("972546582548"), "054-658-2548");
assert.equal(formatPhone("0546582548"), "054-658-2548");
assert.equal(formatPhone("+1 555"), "+1 555");
assert.equal(tagFor(sale), "למכירה · באר שבע");
assert.equal(tagFor(rent), "להשכרה · באר שבע");

const card = buildEndCard(sale, { name: "נופר הרוש", brand_name: "רימקס", phone: "972546582548" });
assert.deepEqual(card, { name: "נופר הרוש", brand: "רימקס", phone: "054-658-2548", cta: "לפרטים ותיאום ביקור", facts: "1,350,000 ₪ · 120 מ״ר · קומה 8" });
assert.equal(buildEndCard(rent, { name: "א", brand_name: "א" }).facts, "6,500 ₪ לחודש · 182 מ״ר · קומה 9", "rent says per month");
assert.equal(buildEndCard(rent, { name: "א", brand_name: "א" }).brand, "", "brand equal to the name is not repeated");

assert.equal(wrapSubtitle("קצר"), "קצר");
assert.ok(/\\N/.test(wrapSubtitle("סלון מואר עם יציאה למרפסת ונוף פתוח לעיר")));

// the prompt carries each clip's spaces, length cap and the listing facts
const p = buildPrompt(clips, spaces, sale);
assert.ok(p.includes("Clip 2 (11s, narration max 110 chars): סלון (sofa, hanging chair)"));
assert.ok(p.includes("for sale") && p.includes("neighborhood: הפארק") && p.includes("exactly 2 lines"));

// validation: count, Hebrew, length, subtitle split
const ok = validateScript({ lines: [{ narration: "בואו תראו את זה", subtitle: "בואו תראו | את זה" }, { narration: "סלון מואר", subtitle: "סלון מואר" }] }, clips);
assert.deepEqual(ok, [{ narration: "בואו תראו את זה", subtitle: "בואו תראו\\Nאת זה" }, { narration: "סלון מואר", subtitle: "סלון מואר" }]);
assert.throws(() => validateScript({ lines: [{ narration: "x", subtitle: "y" }] }, clips), /want 2/);
assert.throws(() => validateScript({ lines: [{ narration: "hello", subtitle: "hi" }, { narration: "סלון", subtitle: "סלון" }] }, clips), /not Hebrew/);
assert.throws(() => validateScript({ lines: [{ narration: "א".repeat(200), subtitle: "א" }, { narration: "סלון", subtitle: "סלון" }] }, clips), (e) => /too long/.test(e.message) && e.tooLong.join() === "1");
assert.equal(validateScript({ lines: [{ narration: "א".repeat(200), subtitle: "א" }, { narration: "סלון", subtitle: "סלון" }] }, clips, { lenient: true })[0].narration.length, 200, "lenient keeps long lines");
assert.ok(!/[{}\\]/.test(validateScript({ lines: [{ narration: "סלון {\\b1}", subtitle: "סלון" }, { narration: "סלון", subtitle: "סלון" }] }, clips)[0].narration), "ASS specials stripped");

const fb = fallbackScript(clips, spaces, sale);
assert.equal(fb.length, 2);
assert.ok(fb[0].narration.startsWith("בואו תראו את זה... 3 חדרים בהפארק, באר שבע"));
assert.ok(fb[1].narration.includes("סלון") && fb[1].narration.includes("הפרטים כאן על המסך"));

(async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test";
  const reply = { lines: [{ narration: "בואו תראו את זה... שלושה חדרים", subtitle: "בואו תראו | 3 חדרים" }, { narration: "סלון מואר. הפרטים כאן על המסך", subtitle: "סלון מואר" }] };
  const good = await writeScript({ clips, spaces, details: sale, agent: { name: "נופר", phone: "0546582548" },
    fetchFn: async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify(reply) }] }) }) });
  assert.equal(good.debug, "ok");
  assert.equal(good.lines[0].subtitle, "בואו תראו\\N3 חדרים");
  assert.equal(good.tag, "למכירה · באר שבע");
  assert.ok(good.music_prompt.length > 20);
  // too long → one rewrite; still too long → kept as is, never the template
  const long = { lines: [{ narration: "א".repeat(90), subtitle: "א" }, { narration: "סלון", subtitle: "סלון" }] };
  const calls = [];
  const replies = [long, reply];
  const fix = await writeScript({ clips, spaces, details: sale,
    fetchFn: async (_u, init) => { calls.push(JSON.parse(init.body).messages); return { ok: true, json: async () => ({ content: [{ text: JSON.stringify(replies.shift()) }] }) }; } });
  assert.equal(fix.debug, "ok_after_rewrite");
  assert.equal(calls.length, 2);
  assert.ok(/line 1: max 50 chars/.test(calls[1][2].content), "the rewrite names the overrun and its budget");
  const stillLong = await writeScript({ clips, spaces, details: sale,
    fetchFn: async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify(long) }] }) }) });
  assert.equal(stillLong.debug, "ok_long_lines");
  assert.equal(stillLong.lines[0].narration.length, 90);
  const bad = await writeScript({ clips, spaces, details: sale, fetchFn: async () => ({ ok: false, status: 500, text: async () => "boom" }) });
  assert.ok(bad.debug.startsWith("fallback"));
  assert.equal(bad.lines.length, 2);
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal((await writeScript({ clips, spaces, details: sale })).debug, "no_api_key");
  if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  console.log("reel-script: all tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
