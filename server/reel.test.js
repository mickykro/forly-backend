const assert = require("assert");
const { _test } = require("./reel");
const { timeline, buildAss, assTime, assText, falQueueUrl, XF, CARD } = _test;

const near = (a, b) => Math.abs(a - b) < 1e-6;

// a shot lasts max(4 s, line + 0.7 s); a multi-angle clip keeps its angles; shots overlap by XF
const clips = [{ duration: 5 }, { duration: 5 }, { duration: 11, shot_count: 3 }];
const tl = timeline(clips, [5.3, 2.0, 3.0]);
assert.ok(near(tl.shots[0].len, 6.0), "line + 0.7");
assert.ok(near(tl.shots[1].len, 4), "minimum shot");
assert.ok(near(tl.shots[2].len, 10.5), "three angles kept");
assert.ok(tl.shots[0].stretch > 1 && tl.shots[1].stretch === 1, "only a clip shorter than its shot is slowed");
assert.ok(near(tl.shots[1].start, 6.0 - XF) && near(tl.shots[2].start, 6.0 + 4 - 2 * XF));
assert.ok(near(tl.videoEnd, tl.shots[2].start + 10.5));
assert.ok(near(tl.total, tl.videoEnd - XF + CARD));
// a line far longer than its clip is capped at 1.25x slow-down
assert.ok(near(timeline([{ duration: 5 }], [9]).shots[0].len, 6.25));

assert.equal(assTime(0), "0:00:00.00");
assert.equal(assTime(83.456), "0:01:23.46");
{
  const t = assText("a{\\b1}b\\Nc");
  assert.ok(!/[{}]/.test(t) && !/\\b/.test(t) && t.endsWith("b\\Nc"), "ASS overrides stripped, \\N kept");
}

const ass = buildAss(tl, ["בואו תראו\\N3 חדרים", "מטבח", "סלון"], "למכירה · באר שבע",
  { name: "נופר הרוש", brand: "רימקס", phone: "054-658-2548", cta: "לפרטים ותיאום ביקור", facts: "1,350,000 ₪ · 120 מ״ר" });
const styles = ass.split("\n").filter((l) => l.startsWith("Style:"));
assert.equal(styles.length, 6);
assert.ok(styles.every((l) => l.endsWith(",-1")), "Encoding -1 on every style (bidi for Hebrew + digits)");
assert.ok(ass.includes("Heebo"));
assert.equal(ass.split("\n").filter((l) => /,Sub,/.test(l) && l.startsWith("Dialogue")).length, 3);
assert.ok(ass.includes("בואו תראו\\N3 חדרים"));
assert.ok(/Tag,,0,0,0,,\{\\fad\(250,200\)\}למכירה · באר שבע/.test(ass));
assert.ok(ass.includes("Phone,,0,0,0,,{\\fad(300,0)\\pos(360,650)}054-658-2548"));
const noBrand = buildAss(tl, ["a", "b", "c"], "", { name: "x", brand: "", phone: "1", cta: "c", facts: "" });
assert.ok(!/,Tag,/.test(noBrand.split("[Events]")[1]) && (noBrand.match(/Dialogue: 2/g) || []).length === 3, "empty tag/brand/facts are left out");

assert.ok(falQueueUrl("https://queue.fal.run/minimax/h3/requests/abc/status"));
assert.ok(!falQueueUrl("https://evil.example/queue.fal.run/x"), "polling only follows fal's own queue urls");

console.log("reel: all tests passed");
