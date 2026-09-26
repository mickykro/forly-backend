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

// A message is a button payload: every link is a button, none is in the text.
const { textOfButtons } = require("./utils");
function linksIn(m) {
  const out = {};
  for (const b of m.buttons || []) {
    const u = new URL(b.url);
    if (u.pathname === "/api/posting/act") out[u.searchParams.get("a")] = u;
  }
  return out;
}
const T = (m) => textOfButtons(m); // everything the agent can read, links included
function shaped(m, name) {
  assert.ok(m && typeof m === "object", name);
  for (const k of ["header", "body", "footer"]) {
    assert.equal(typeof m[k], "string", `${name}.${k}`);
    assert.ok(!/https?:\/\//.test(m[k]), `${name}: no link in the ${k} — links sit behind buttons`);
  }
  assert.ok(m.header.length <= 60, `${name}: header ≤ 60`);
  assert.ok(m.buttons.length >= 1 && m.buttons.length <= 3, `${name}: 1–3 buttons`);
  for (const b of m.buttons) {
    assert.equal(b.type, "url"); assert.ok(/^https:\/\//.test(b.url), name);
    assert.ok(b.buttonText && b.buttonText.length <= 25, `${name}: button text ≤ 25`);
  }
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
    const m = M.approve(camp, post);
    shaped(m, "approve");
    // The agreed layout: header names the group; the body is when + the exact copy; three buttons.
    assert.equal(m.header, 'פוסט מוכן לקבוצה "דירות בחיפה"');
    assert.ok(m.body.startsWith("יעלה ") && m.body.includes("— אחרי האישור שלכם.\n──────────\n" + post.copy));
    assert.equal(m.footer, "לא מפרסמים בלי האישור שלכם");
    assert.deepEqual(m.buttons.map((b) => b.buttonText), ["לאישור", "לדילוג על הקבוצה", "לעצירת הפרסום"]);
    const approve = T(m);
    assert.ok(approve.includes("דירות בחיפה"), "group name");
    assert.ok(approve.includes(post.copy), "the EXACT copy, unmodified");
    assert.ok(approve.includes("לא מפרסמים בלי האישור שלכם"));
    assert.ok(!/undefined|null/.test(approve), "no undefined/null leaked into the text");
    assert.ok(!/facebook\.com/i.test(approve), "no group URL");

    const links = linksIn(m);
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
    const anon = T(M.approve(camp, Object.assign({}, post, { group_name: "" })));
    assert.ok(anon.includes("קבוצה"));
    assert.ok(!anon.includes("דירות בחיפה"));
  }

  // ── the Page target reads as the Page, not a group ──
  {
    const pagePost = Object.assign({}, post, { target: "page", group_name: "" });
    assert.ok(T(M.approve(camp, pagePost)).includes("הדף העסקי"));
    assert.equal(M.approve(camp, pagePost).buttons[1].buttonText, "לדילוג על הפוסט");
  }

  // ── posted: shows the live post's URL and offers a stop link ──
  {
    const pm = M.posted(camp, Object.assign({}, post, { post_url: "https://www.facebook.com/groups/1/posts/9" }));
    shaped(pm, "posted");
    assert.equal(pm.buttons[0].buttonText, "לצפייה בפוסט"); assert.ok(pm.buttons[0].url.endsWith("posts/9"));
    const links = linksIn(pm);
    assert.ok(links.stop, "stop link present");
    const v = verify(links.stop, "stop");
    assert.equal(v.c, "c1"); assert.equal(v.p, ""); assert.equal(v.a, "stop");
  }
  // posted with no campaign (defensive: haltAccount-style callers may pass null elsewhere, posted always gets a real campaign, but must not throw on a bare id-less one)
  assert.doesNotThrow(() => M.posted({}, post));

  // ── paused: even a pause offers a stop link ──
  {
    const paused = M.paused(camp);
    shaped(paused, "paused");
    const links = linksIn(paused);
    assert.ok(links.stop, "stop link present");
    assert.equal(verify(links.stop, "stop").a, "stop");
  }

  // ── halted: the account-level R5 classes, no vendor code, a stop link when the campaign is known ──
  {
    const cm = M.halted(camp, "checkpoint");
    shaped(cm, "halted");
    const checkpoint = T(cm);
    assert.ok(checkpoint.includes("פייסבוק"));
    assert.ok(!checkpoint.includes("checkpoint"), "no vendor code");
    assert.ok(linksIn(cm).stop, "stop link when campaign known");
    assert.ok(T(M.halted(camp, "captcha")).includes("פייסבוק"));
    assert.ok(T(M.halted(camp, "restricted")).includes("פייסבוק"));
    assert.ok(T(M.halted(camp, "suspected_compromise")).includes("פייסבוק"));
    // haltAccount may call this with no campaign (posting-tick.js:373) — must not throw, no stop link.
    const noCamp = M.halted(null, "checkpoint");
    shaped(noCamp, "halted without campaign");
    assert.ok(T(noCamp).includes("פייסבוק"));
    assert.equal(Object.keys(linksIn(noCamp)).length, 0);
  }

  // ── penalty: the 14-day slowdown, no vendor code ──
  {
    const penalty = T(M.penalty(camp, "rate_limited"));
    assert.ok(penalty.includes("להאט"));
    assert.ok(!penalty.includes("rate_limited"));
    const fb = T(M.penalty(camp, "feature_blocked"));
    assert.ok(fb.includes("להאט") || fb.includes("שבועיים"));
  }

  // ── reconnect: tells the agent to reconnect Facebook ──
  assert.ok(T(M.reconnect(camp, "login_required")).includes("לחבר"));
  assert.equal(M.reconnect(camp).buttons[0].url, "https://f.ly/distribution.html");
  assert.doesNotThrow(() => M.reconnect(null, "login_required"));

  // ── removed: a group admin took the post down ──
  assert.ok(T(M.removed(camp, "confirmed_removed")).includes("הסירו"));

  // ── stopped / completed ──
  assert.ok(T(M.stopped(camp)).includes("נשאר"));
  assert.ok(T(M.completed(camp)).includes("סיימה"));
  for (const k of ["penalty", "reconnect", "removed", "stopped", "completed"]) shaped(M[k](camp, "rate_limited"), k);
  assert.equal(M.stopped(camp).buttons[0].url, "https://f.ly/autopublish.html", "no link in the text: a button to the publishing page");

  // ── no phone, cdpUrl or viewer URL ever appears, in any message ──
  const all = [
    M.approve(camp, post), M.posted(camp, post), M.paused(camp), M.halted(camp, "checkpoint"),
    M.penalty(camp, "rate_limited"), M.reconnect(camp, "login_required"), M.removed(camp, "confirmed_removed"),
    M.stopped(camp), M.completed(camp),
  ].map(T).join("\n");
  assert.ok(!/972\d{8,9}/.test(all), "no full phone number");
  assert.ok(!/wss?:\/\/|viewer\.driver\.dev/i.test(all), "no cdpUrl/viewer URL");

  console.log("posting-messages.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
