/* social-dwell.js — the human routine, against a fake page. What matters: it
   only ever likes a little (and only with explicit permission), never
   comments or follows, avoids the target group and sensitive/sponsored
   content, respects the kill switch at every visible step, and never
   persists anything readable. No network. */
const assert = require("assert");
const SD = require("./social-dwell");
const S = SD.SELECTORS;

const ALLOW_GUARD = { assertAllowed: async () => true };
const denyOn = (deniedAction) => ({
  assertAllowed: async ({ action }) => {
    if (action === deniedAction) { const e = new Error("posting not allowed"); e.code = "posting_disabled"; e.reason = "test"; throw e; }
  },
});

function fakePage(o = {}) {
  const clicked = [], visited = [], typed = [];
  let url = "https://www.facebook.com/";
  const feed = o.feed || [
    { href: "https://www.facebook.com/a/posts/1", author: "Ann", hasVideo: false, group: null, sponsored: false, reactions: 40, text: "" },
    { href: "https://www.facebook.com/groups/999/posts/2", author: "Bob", hasVideo: true, group: "https://www.facebook.com/groups/999", sponsored: false, reactions: 40, text: "" },
    { href: "https://www.facebook.com/c/posts/3", author: "Cat", hasVideo: false, group: null, sponsored: false, reactions: 40, text: "" },
  ];
  const redirects = o.redirects || {};
  const likeState = o.likeState || {}; // href -> "true" | "false" | undefined(=unreadable)
  return {
    clicked, visited, typed,
    goto: async (u) => { visited.push(u); url = redirects[u] || u; },
    url: () => url,
    goBack: async () => { url = "https://www.facebook.com/"; },
    innerText: async (sel) => (o.innerText ? o.innerText(sel) : ""),
    title: async () => "Facebook",
    mouse: { wheel: async () => {} },
    keyboard: { type: async (t) => typed.push(t), press: async () => {} },
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    locator: (sel) => {
      const n = {
        count: async () => {
          if (sel === S.storyTray || sel === S.storyCard) return o.noStories ? 0 : 1;
          if (sel === S.captchaFrame) return o.captchaCount || 0;
          if (sel === S.like) return o.noLikeButton ? 0 : 1;
          if (sel === S.dialog || sel === S.alert) return 0;
          return 0;
        },
        click: async () => clicked.push(sel),
        innerText: async () => "",
        getAttribute: async (attr) => (attr === "aria-pressed" ? (Object.prototype.hasOwnProperty.call(likeState, url) ? likeState[url] : undefined) : null),
        first: () => n, nth: () => n,
      };
      return n;
    },
    $$eval: async (sel) => (sel === S.feedPost ? feed : []),
  };
}

// A cyclic sequence, like a real Math.random but reproducible — exact call
// counts are not something the routine's contract promises, so tests assert
// bounds and invariants instead of exact counts.
const fastWait = { wait: async () => {} };
function cycleRand(seq) { let i = 0; return () => seq[i++ % seq.length]; }

(async () => {
  // ── a full passive+visible routine: scrolls, opens posts, watches the
  // video, likes <= max, views stories, never touches the avoided group ──
  {
    const page = fakePage();
    const rand = cycleRand([0.1, 0.9, 0.2, 0.3, 0.1, 0.2, 0.1, 0.3, 0.2]);
    const log = await SD.dwell(page, { allowVisible: true, avoidGroupUrl: "https://www.facebook.com/groups/999" }, Object.assign({ rand, guard: ALLOW_GUARD }, fastWait));
    const kinds = log.map((l) => l.action);
    assert.ok(kinds.filter((k) => k === "scroll").length >= 3);
    assert.ok(kinds.includes("open_post"));
    assert.ok(kinds.includes("watch_video"), "a video in view gets watched");
    assert.ok(kinds.filter((k) => k === "like").length <= SD.INTERACTION.likes_max);
    assert.ok(!page.visited.includes("https://www.facebook.com/groups/999/posts/2"), "never opens the group we are about to post in");
    assert.equal(page.typed.length, 0, "never types anything");
    assert.ok(!page.clicked.includes(S.commentBox) && !page.clicked.includes(S.follow), "never comments or follows");
  }

  // ── allowVisible=false: passive only, zero like/story actions even at
  // maximum probability ──
  {
    const page = fakePage();
    const rand = () => 0.01; // would trigger a like/story every time if allowed
    const log = await SD.dwell(page, { allowVisible: false }, Object.assign({ rand, guard: ALLOW_GUARD }, fastWait));
    assert.ok(!log.some((l) => l.action === "like" || l.action === "like_uncertain" || l.action === "story"));
    assert.equal(page.clicked.filter((c) => c === S.like).length, 0);
  }

  // ── the guard denying "like" stops before the click, even though the
  // permission and the random draw both say go ──
  {
    const page = fakePage();
    const rand = () => 0.01;
    const log = await SD.dwell(page, { allowVisible: true }, Object.assign({ rand, guard: denyOn("like") }, fastWait));
    assert.ok(!log.some((l) => l.action === "like" || l.action === "like_uncertain"));
    assert.equal(page.clicked.filter((c) => c === S.like).length, 0);
  }

  // ── already-liked (aria-pressed=true) is skipped: no click, nothing logged ──
  {
    const feed = [{ href: "https://www.facebook.com/x/posts/555", author: "Deb", hasVideo: false, group: null, sponsored: false, reactions: 40, text: "" }];
    const page = fakePage({ feed, likeState: { "https://www.facebook.com/x/posts/555": "true" } });
    const rand = () => 0.01;
    const log = await SD.dwell(page, { allowVisible: true }, Object.assign({ rand, guard: ALLOW_GUARD }, fastWait));
    assert.ok(!log.some((l) => l.action === "like" || l.action === "like_uncertain"));
    assert.equal(page.clicked.filter((c) => c === S.like).length, 0);
  }

  // ── a post whose id was liked within the last 30 days (recentlyLikedPostIds) is skipped ──
  {
    const feed = [{ href: "https://www.facebook.com/x/posts/777", author: "Deb", hasVideo: false, group: null, sponsored: false, reactions: 40, text: "" }];
    const page = fakePage({ feed });
    const rand = () => 0.01;
    const log = await SD.dwell(page, { allowVisible: true, recentlyLikedPostIds: ["777"] }, Object.assign({ rand, guard: ALLOW_GUARD }, fastWait));
    assert.ok(!log.some((l) => l.action === "like" || l.action === "like_uncertain"));
    assert.equal(page.clicked.filter((c) => c === S.like).length, 0);
  }

  // ── an uncertain result after clicking is logged once, and never retried
  // or toggled (exactly one click for that post) ──
  {
    const feed = [{ href: "https://www.facebook.com/x/posts/888", author: "Deb", hasVideo: false, group: null, sponsored: false, reactions: 40, text: "" }];
    const page = fakePage({ feed }); // getAttribute("aria-pressed") -> undefined -> unreadable both times
    const rand = () => 0.01;
    const log = await SD.dwell(page, { allowVisible: true }, Object.assign({ rand, guard: ALLOW_GUARD }, fastWait));
    assert.equal(log.filter((l) => l.action === "like_uncertain").length, 1);
    assert.equal(log.filter((l) => l.action === "like").length, 0);
    assert.equal(page.clicked.filter((c) => c === S.like).length, 1, "clicked exactly once, never retried");
  }

  // ── sponsored / sensitive / low-reaction / avoided-group posts are opened
  // (ordinary passive dwell) but never liked ──
  for (const bad of [
    { href: "https://www.facebook.com/x/posts/1", author: "A", hasVideo: false, group: null, sponsored: true, reactions: 40, text: "" },
    { href: "https://www.facebook.com/x/posts/2", author: "A", hasVideo: false, group: null, sponsored: false, reactions: 40, text: "תאונה קשה בכביש" },
    { href: "https://www.facebook.com/x/posts/3", author: "A", hasVideo: false, group: null, sponsored: false, reactions: 2, text: "" },
  ]) {
    const page = fakePage({ feed: [bad] });
    const rand = () => 0.01;
    const log = await SD.dwell(page, { allowVisible: true }, Object.assign({ rand, guard: ALLOW_GUARD }, fastWait));
    assert.ok(!log.some((l) => l.action === "like" || l.action === "like_uncertain"), `never likes: ${JSON.stringify(bad)}`);
    assert.ok(log.some((l) => l.action === "open_post"), "still opens it — passive reading is not gated by the content filter");
  }
  // the group we are about to post in: never even opened
  {
    const feed = [{ href: "https://www.facebook.com/groups/999/posts/9", author: "A", hasVideo: false, group: "https://www.facebook.com/groups/999", sponsored: false, reactions: 40, text: "" }];
    const page = fakePage({ feed });
    const rand = () => 0.01;
    const log = await SD.dwell(page, { allowVisible: true, avoidGroupUrl: "https://www.facebook.com/groups/999" }, Object.assign({ rand, guard: ALLOW_GUARD }, fastWait));
    assert.ok(!log.some((l) => l.action === "open_post" || l.action === "like"));
  }

  // ── no story tray: no story actions, no crash ──
  {
    const log = await SD.dwell(fakePage({ noStories: true }), { allowVisible: true }, Object.assign({ rand: cycleRand([0.1, 0.9, 0.2, 0.3]), guard: ALLOW_GUARD }, fastWait));
    assert.ok(!log.some((l) => l.action === "story"));
  }

  // ── a checkpoint reached mid-session stops the routine right there: no
  // read, no like, no story after it ──
  {
    const feed = [{ href: "https://www.facebook.com/x/posts/321", author: "A", hasVideo: false, group: null, sponsored: false, reactions: 40, text: "" }];
    const redirects = { "https://www.facebook.com/x/posts/321": "https://www.facebook.com/checkpoint/500/" };
    const page = fakePage({ feed, redirects });
    const rand = () => 0.01;
    const log = await SD.dwell(page, { allowVisible: true }, Object.assign({ rand, guard: ALLOW_GUARD }, fastWait));
    assert.ok(log.some((l) => l.action === "halt" && l.detail.signal === "checkpoint"));
    assert.ok(!log.some((l) => l.action === "like" || l.action === "story"));
  }

  // ── the "dwell" guard denies passive browsing too: nothing happens at all ──
  {
    const page = fakePage();
    const log = await SD.dwell(page, { allowVisible: true }, Object.assign({ rand: () => 0.5, guard: denyOn("dwell") }, fastWait));
    assert.equal(log.length, 0);
    assert.equal(page.visited.length, 0);
  }

  // ── browseSession: its own session, saves counts only, updates the
  // connection, and surfaces the signal without acting on it ──
  {
    const savedDocs = [];
    const store = {
      saveDwellSession: async (doc) => { savedDocs.push(doc); return "id1"; },
      listDwellSessionsByPhone: async () => [{ actions_summary: { scroll: 5, open_post: 1 }, likes: 1 }, { actions_summary: { scroll: 4 }, likes: 0 }],
    };
    const setConnCalls = [];
    const conn = { posting_permission: { enabled: true, platforms: ["facebook"], allows_visible_interactions: true } };
    const db = { getConnection: async () => conn, setConnection: async (phone, patch) => setConnCalls.push([phone, patch]) };
    let withPageArgs = null;
    const out = await SD.browseSession({ phone: "972500000009", profileName: "facebook-prod-x", note: "forly-dwell:" }, {
      guard: ALLOW_GUARD, rand: cycleRand([0.1, 0.9, 0.2, 0.3, 0.1, 0.2]),
      withPage: async (opts, fn) => { withPageArgs = opts; return fn(fakePage()); },
      db, store, conn,
    });
    assert.equal(withPageArgs.profile.name, "facebook-prod-x");
    assert.equal(withPageArgs.note, "forly-dwell:");
    assert.equal(out.signal, "ok");
    assert.equal(savedDocs.length, 1);
    const doc = savedDocs[0];
    assert.deepEqual(Object.keys(doc).sort(), ["actions_summary", "at", "halt_related", "likes", "phone", "platform"]);
    assert.equal(doc.phone, "972500000009");
    assert.equal(doc.platform, "facebook");
    assert.equal(doc.halt_related, false);
    assert.ok(Number.isInteger(doc.likes));
    for (const v of Object.values(doc.actions_summary)) assert.ok(Number.isFinite(v));
    // nothing readable leaked into what gets persisted (the phone itself is a
    // whitelisted, expected field of the doc — posting-store.js queries by it)
    const blob = JSON.stringify(Object.assign({}, doc, { phone: undefined }));
    for (const secret of ["facebook.com", "Ann", "Bob", "Cat", "facebook-prod-x"]) {
      assert.ok(!blob.includes(secret), `leaked "${secret}" into the saved dwell session`);
    }
    assert.equal(setConnCalls.length, 1);
    assert.equal(setConnCalls[0][0], "972500000009");
    assert.ok(setConnCalls[0][1].last_browse_at);
    assert.equal(setConnCalls[0][1].dwell_summary_7d.sessions, 2);
    assert.equal(setConnCalls[0][1].dwell_summary_7d.scroll, 9);
    assert.equal(setConnCalls[0][1].dwell_summary_7d.like, 1);
  }

  // ── browseSession: the "session" guard denies -> no session opened, ok signal ──
  {
    let opened = false;
    const out = await SD.browseSession({ phone: "p", profileName: "facebook-prod-x", note: "forly-dwell:" }, {
      guard: denyOn("session"),
      withPage: async () => { opened = true; },
      db: { getConnection: async () => ({}) },
      store: { saveDwellSession: async () => {}, listDwellSessionsByPhone: async () => [] },
    });
    assert.equal(opened, false);
    assert.equal(out.signal, "ok");
  }

  // ── browseSession: a checkpoint hit right at session start is surfaced,
  // and the routine never even starts ──
  {
    const out = await SD.browseSession({ phone: "p", profileName: "facebook-prod-x", note: "forly-dwell:" }, {
      guard: ALLOW_GUARD,
      withPage: async (opts, fn) => fn(fakePage({ redirects: { "https://www.facebook.com/": "https://www.facebook.com/checkpoint/1/" } })),
      db: { getConnection: async () => ({}), setConnection: async () => {} },
      store: { saveDwellSession: async () => {}, listDwellSessionsByPhone: async () => [] },
    });
    assert.equal(out.signal, "checkpoint");
    assert.deepEqual(out.summary, {});
  }

  // ── browseSession: allowVisible follows the connection's own permission,
  // not a default ──
  {
    const savedDocs = [];
    const store = { saveDwellSession: async (d) => savedDocs.push(d), listDwellSessionsByPhone: async () => [] };
    const conn = { posting_permission: { enabled: true, platforms: ["facebook"], allows_visible_interactions: false } };
    const feed = [{ href: "https://www.facebook.com/x/posts/1", author: "A", hasVideo: false, group: null, sponsored: false, reactions: 40, text: "" }];
    await SD.browseSession({ phone: "p", profileName: "facebook-prod-x", note: "forly-dwell:" }, {
      guard: ALLOW_GUARD, rand: () => 0.01,
      withPage: async (opts, fn) => fn(fakePage({ feed })),
      db: { getConnection: async () => conn, setConnection: async () => {} }, store, conn,
    });
    assert.equal(savedDocs[0].likes, 0);
    assert.equal(savedDocs[0].actions_summary.like || 0, 0);
  }

  // ── recheckPost: visible with counts, not_found, or unknown (login wall) ──
  {
    const present = fakePage();
    present.innerText = async (sel) => (sel === S.reactionCount ? "12" : sel === S.commentCount ? "3 תגובות" : "");
    assert.deepEqual(await SD.recheckPost(present, "https://www.facebook.com/groups/1/posts/9"), { state: "visible", reactions: 12, comments: 3 });

    const gone = fakePage();
    gone.innerText = async () => "This content isn't available right now";
    assert.deepEqual(await SD.recheckPost(gone, "https://www.facebook.com/groups/1/posts/9"), { state: "not_found", reactions: null, comments: null });

    const wall = fakePage({ redirects: { "https://www.facebook.com/groups/1/posts/9": "https://www.facebook.com/login.php" } });
    assert.deepEqual(await SD.recheckPost(wall, "https://www.facebook.com/groups/1/posts/9"), { state: "unknown", reactions: null, comments: null });
  }

  console.log("social-dwell.test.js ok");
})();
