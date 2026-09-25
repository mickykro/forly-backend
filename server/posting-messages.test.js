/* posting-messages.js — the WhatsApp lines. Every one is Hebrew, in Forly's
   voice, and the ones that need a tap carry a Task 19 signed one-tap link.
   Vendor halt codes never appear; no phone, group URL, cdpUrl or profile
   name ever appears; a group is named only when the campaign kept a name. */
const assert = require("assert");
const { readActionLink } = require("./routes/posting-shared");

const OPTS = { pageBaseUrl: "https://f.ly", authSecret: "s" };
const M = require("./posting-messages").build(OPTS);

const camp = { id: "c1" };
const post = { id: "p1", target: "group", group_name: "דירות בחיפה", scheduled_at: "2026-09-24T11:00:00+03:00", copy: "🏠 דירה 4 חדרים בחיפה\nמחיר 1,900,000 ₪" };

// Every extra query param (e, t) allowed after `a=<action>`.
function linksIn(text) {
  const out = {};
  for (const m of text.matchAll(/https:\/\/f\.ly\/api\/posting\/act\?[^\s]+/g)) {
    const u = new URL(m[0]);
    out[u.searchParams.get("a")] = u;
  }
  return out;
}
const verify = (u, action, nowMs = Date.now()) =>
  readActionLink(Object.fromEntries(u.searchParams), OPTS.authSecret, nowMs);

(async () => {
  // ── build() exposes exactly the kinds the call sites use (grep `say(` across posting-*.js) ──
  const KINDS = ["approve", "posted", "paused", "halted", "penalty", "reconnect", "removed", "stopped", "completed"];
  assert.deepEqual(Object.keys(M).sort(), KINDS.sort());
  for (const k of KINDS) assert.equal(typeof M[k], "function", k);

  // ── approve: the exact copy, group name, and three signed links ──
  {
    const approve = M.approve(camp, post);
    assert.ok(approve.includes("דירות בחיפה"), "group name");
    assert.ok(approve.includes(post.copy), "the EXACT copy, unmodified");
    assert.ok(approve.includes("לא מפרסמים בלי האישור שלכם"));
    assert.ok(!/undefined|null/.test(approve), "no undefined/null leaked into the text");
    assert.ok(!/facebook\.com/i.test(approve), "no group URL");

    const links = linksIn(approve);
    for (const a of ["approve", "skip", "stop"]) {
      assert.ok(links[a], `${a} link present`);
      const v = verify(links[a], a);
      assert.equal(v.c, "c1"); assert.equal(v.p, "p1"); assert.equal(v.a, a);
      // Swapping in another action must not verify (the token is signed over the action too).
      const other = a === "approve" ? "stop" : "approve";
      const q2 = Object.fromEntries(links[a].searchParams); q2.a = other;
      assert.equal(readActionLink(q2, OPTS.authSecret, Date.now()).error, "invalid", `${a} link must not verify for ${other}`);
    }
  }

  // ── a group with no kept name shows "קבוצה", never a URL ──
  {
    const anon = M.approve(camp, Object.assign({}, post, { group_name: "" }));
    assert.ok(anon.includes("קבוצה"));
    assert.ok(!anon.includes("דירות בחיפה"));
  }

  // ── the Page target reads as the Page, not a group ──
  {
    const pagePost = Object.assign({}, post, { target: "page", group_name: "" });
    assert.ok(M.approve(camp, pagePost).includes("הדף העסקי"));
  }

  // ── posted: shows the live post's URL and offers a stop link ──
  {
    const posted = M.posted(camp, Object.assign({}, post, { post_url: "https://www.facebook.com/groups/1/posts/9" }));
    assert.ok(posted.includes("posts/9"));
    const links = linksIn(posted);
    assert.ok(links.stop, "stop link present");
    const v = verify(links.stop, "stop");
    assert.equal(v.c, "c1"); assert.equal(v.p, ""); assert.equal(v.a, "stop");
  }
  // posted with no campaign (defensive: haltAccount-style callers may pass null elsewhere, posted always gets a real campaign, but must not throw on a bare id-less one)
  assert.doesNotThrow(() => M.posted({}, post));

  // ── paused: even a pause offers a stop link ──
  {
    const paused = M.paused(camp);
    const links = linksIn(paused);
    assert.ok(links.stop, "stop link present");
    assert.equal(verify(links.stop, "stop").a, "stop");
  }

  // ── halted: the account-level R5 classes, no vendor code, a stop link when the campaign is known ──
  {
    const checkpoint = M.halted(camp, "checkpoint");
    assert.ok(checkpoint.includes("פייסבוק"));
    assert.ok(!checkpoint.includes("checkpoint"), "no vendor code");
    assert.ok(linksIn(checkpoint).stop, "stop link when campaign known");
    assert.ok(M.halted(camp, "captcha").includes("פייסבוק"));
    assert.ok(M.halted(camp, "restricted").includes("פייסבוק"));
    assert.ok(M.halted(camp, "suspected_compromise").includes("פייסבוק"));
    // haltAccount may call this with no campaign (posting-tick.js:373) — must not throw, no link.
    const noCamp = M.halted(null, "checkpoint");
    assert.ok(noCamp.includes("פייסבוק"));
    assert.equal(Object.keys(linksIn(noCamp)).length, 0);
  }

  // ── penalty: the 14-day slowdown, no vendor code ──
  {
    const penalty = M.penalty(camp, "rate_limited");
    assert.ok(penalty.includes("להאט"));
    assert.ok(!penalty.includes("rate_limited"));
    assert.ok(M.penalty(camp, "feature_blocked").includes("להאט") || M.penalty(camp, "feature_blocked").includes("שבועיים"));
  }

  // ── reconnect: tells the agent to reconnect Facebook ──
  assert.ok(M.reconnect(camp, "login_required").includes("לחבר"));
  assert.doesNotThrow(() => M.reconnect(null, "login_required"));

  // ── removed: a group admin took the post down ──
  assert.ok(M.removed(camp, "confirmed_removed").includes("הסירו"));

  // ── stopped / completed ──
  assert.ok(M.stopped(camp).includes("נשאר"));
  assert.ok(M.completed(camp).includes("סיימה"));

  // ── no phone, cdpUrl or viewer URL ever appears, in any message ──
  const all = [
    M.approve(camp, post), M.posted(camp, post), M.paused(camp), M.halted(camp, "checkpoint"),
    M.penalty(camp, "rate_limited"), M.reconnect(camp, "login_required"), M.removed(camp, "confirmed_removed"),
    M.stopped(camp), M.completed(camp),
  ].join("\n");
  assert.ok(!/972\d{8,9}/.test(all), "no full phone number");
  assert.ok(!/wss?:\/\/|viewer\.driver\.dev/i.test(all), "no cdpUrl/viewer URL");

  console.log("posting-messages.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
