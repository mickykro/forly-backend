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
// a line far longer than its clip still plays whole: slowed 1.25x, then the last frame holds
{
  const long = timeline([{ duration: 5 }], [9]).shots[0];
  assert.ok(near(long.len, 9.7) && near(long.stretch, 1.25) && near(long.hold, 9.7 - 4.95 * 1.25));
}
// no line ever starts before the previous one has finished (the bug in the first V4 run: 8-9 s lines on 7 s clips)
{
  const vo = [8.6, 8.3, 6.9, 2.1];
  const t = timeline([{ duration: 7, shot_count: 2 }, { duration: 7, shot_count: 2 }, { duration: 7, shot_count: 2 }, { duration: 5 }], vo);
  for (let k = 0; k + 1 < vo.length; k++) assert.ok(t.shots[k + 1].start >= t.shots[k].start + vo[k] + 0.3, `line ${k + 1} overlaps line ${k + 2}`);
}

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

// downloads stop at the cap, even without a content-length (a chunked body is read chunk by chunk)
const { readCapped } = require("./utils");
let pulled = 0;
const endless = () => new Response(new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); } }));
(async () => {
  await assert.rejects(readCapped(endless(), 10 * 1024), /response_too_large/);
  assert.ok(pulled < 20, "stopped near the cap, not after reading on");
  assert.equal((await readCapped(new Response("abc"), 10)).toString(), "abc");
  assert.ok(_test.MAX_DOWNLOAD_BYTES <= 100 * 1024 * 1024);
  console.log("reel: all tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
