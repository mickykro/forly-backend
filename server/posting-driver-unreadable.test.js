/* A page read that throws (navigation mid-read, a selector querySelectorAll
   rejects) must fail closed: never "ok". Controller fix after Task 18's last
   fix round. */
const F = require("./posting-driver-fakes");
const assert = require("assert");
const PD = require("./posting-driver");
const P = require("./posting-driver-proof");
const S = PD.SELECTORS;
const { harness, argsOf, NAME, COPY, PERMA } = F;

const boom = async () => { throw new Error("Execution context was destroyed"); };

(async () => {
  // ── readSignal: a thrown read is "unreadable"; a halting URL still wins ──
  {
    const page = { evaluate: boom, url: () => "https://www.facebook.com/groups/111" };
    assert.equal(await P.readSignal(page, COPY), "unreadable");
    const cp = { evaluate: boom, url: () => "https://www.facebook.com/checkpoint/123/" };
    assert.equal(await P.readSignal(cp, COPY), "checkpoint");
    const bad = { evaluate: async () => ({ nope: true }), url: () => "https://www.facebook.com/groups/111" };
    assert.equal(await P.readSignal(bad, COPY), "unreadable", "a malformed result is not an empty page");
  }
  // ── pre-submit: an unreadable page ends the attempt closed, zero Post clicks ──
  {
    const h = harness();
    h.page.evaluate = boom;
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.equal(out.state, "verified_failed");
    assert.equal(h.transitions[h.transitions.length - 1].d.error_code, "markers_missing");
    assert.equal(h.submits(), 0);
  }
  // ── after the click: unreadable reads are retried, never read as "ok" ──
  {
    // Our post IS in the feed, but every signal read after the click throws:
    // the driver must not record verified_posted off a read that proved nothing.
    const h = harness({ page: { feed: (s) => (s.submitted ? [{ href: PERMA, author: NAME, text: COPY }] : []) } });
    const orig = h.page.evaluate;
    h.page.evaluate = async (fn, arg) => (h.submits() > 0 ? boom() : orig(fn, arg));
    const out = await PD.postToGroup(argsOf(), h.deps);
    assert.equal(h.submits(), 1, "exactly one click");
    assert.equal(out.state, "outcome_unknown");
    assert.ok(!h.states().includes("verified_posted"));
  }
  // ── the three in-page selectors stay plain CSS (querySelectorAll), never Playwright-only syntax ──
  for (const k of ["dialog", "alert", "captchaFrame"]) {
    const sel = P.SELECTORS ? P.SELECTORS[k] : S[k];
    assert.ok(typeof sel === "string" && sel.length > 0, `${k} selector present`);
    assert.ok(!/>>|:has-text|:text|text=|:visible|internal:|xpath=|css=|:nth-match/i.test(sel), `${k} must be plain CSS for querySelectorAll`);
  }
  console.log("posting-driver-unreadable.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
