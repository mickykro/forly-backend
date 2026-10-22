/* posting-audit.js — counts per "Your content" tab, against a fake page. No network, no Driver. */
process.env.FORLY_ENV = process.env.FORLY_ENV || "local"; // profile names are per environment
const assert = require("assert");
const A = require("./posting-audit");

// counts: { "<group>/<segment>": n }; redirect: segments Facebook sends elsewhere; signal: from the page.
function fakePage({ counts = {}, texts = {}, redirect = [], signalOn = null } = {}) {
  const st = { url: "about:blank", visited: [], clicks: 0 };
  return {
    st,
    goto: async (u) => {
      st.visited.push(u);
      const seg = new URL(u).pathname.split("/")[3];
      st.url = redirect.includes(seg) ? "https://www.facebook.com/groups/" + new URL(u).pathname.split("/")[2] + "/" : u;
    },
    url: () => st.url,
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    mouse: { wheel: async () => {}, click: async () => { st.clicks++; } },
    // countInPage → the card count; any other evaluate (the page's text) → the sidebar text, if given
    evaluate: async (fn) => { const p = new URL(st.url).pathname.split("/"), k = `${p[2]}/${p[3]}`; return fn === A._test.countInPage ? (counts[k] ?? 0) : (texts[k] ?? ""); },
    screenshot: async () => {},
    signalOn,
  };
}

(async () => {
  const groups = [{ group_id: "11", name: "G1" }, { group_id: "22", name: "G2" }];
  const run = async (page) => {
    const seen = {};
    const out = await A.auditGroups({ phone: "972500000000", groups }, {
      db: { getConnection: async () => ({}) },
      readSignal: async (pg) => (pg.signalOn && pg.st.url.includes(pg.signalOn) ? "checkpoint" : "ok"),
      saveShots: false,
      withPage: async (opts, fn, pd) => { Object.assign(seen, { opts, pd }); return fn(page); },
    });
    return { out, seen };
  };

  // ── counts per tab; a redirected tab is null, not 0 ──
  {
    const page = fakePage({ counts: { "11/my_posted_content": 3, "11/my_pending_content": 1, "22/my_declined_content": 2 }, redirect: ["my_removed_content"] });
    const { out, seen } = await run(page);
    assert.deepEqual(out[0], { group_id: "11", name: "G1", published: 3, pending: 1, declined: 0, removed: null });
    assert.deepEqual(out[1], { group_id: "22", name: "G2", published: 0, pending: 0, declined: 2, removed: null });
    assert.equal(page.st.visited.length, 8, "four tabs per group");
    assert.equal(page.st.clicks, 0, "read-only: never clicks");
    assert.equal(seen.opts.profile.persist, false, "the profile is loaded, never saved back");
    assert.equal(seen.pd.phone, "972500000000");
  }
  // ── Facebook's own "Published · N posts" counter wins over the card count ──
  {
    const page = fakePage({ counts: { "11/my_posted_content": 2 }, texts: { "11/my_posted_content": "Your content\nPending\nPublished\n· 6 posts\nDeclined" } });
    const { out } = await run(page);
    assert.equal(out[0].published, 6, "the sidebar counter, not the 2 cards on screen");
    assert.equal(out[1].published, 0, "no counter text: the card count");
  }
  assert.equal(A._test.publishedCounter("Published\n• 1 post"), 1);
  assert.equal(A._test.publishedCounter("פורסמו\n· 4 פוסטים"), 4);
  assert.equal(A._test.publishedCounter("Pending\nDeclined"), null);

  // ── a halting signal stops everything at once ──
  {
    const page = fakePage({ signalOn: "11/my_pending_content" });
    const { out } = await run(page);
    assert.equal(out.length, 1, "the next group is not opened");
    assert.equal(out[0].signal, "checkpoint");
    assert.equal(out[0].published, 0);
    assert.equal(page.st.visited.length, 2);
  }
  {
  const { publishedCounter } = require("./posting-audit")._test || require("./posting-audit");
  if (typeof publishedCounter === "function") {
    assert.equal(publishedCounter("פורסמו\n\u200f• 16 פוסטים"), 16, "direction marks and a dot between");
    assert.equal(publishedCounter("Published\n· 7 posts"), 7);
    assert.equal(publishedCounter("הוסרו"), null);
  }
}
console.log("posting-audit.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
