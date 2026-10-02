/* posting-chain.js — several posts in one browser session, through the real
   tick, store and reservations; the driver is a fake that, like the real one,
   asks deps.next after each post and posts the next on the same "page". */
const assert = require("assert");
const K = require("./posting-testkit");
const C = require("./posting-campaign");
const S = require("./posting-sweeper");

const { store, NOW, MIN, HOUR, base, fakePost } = K;
// The kit caps an account at 1 post a day; these tests are about several.
const setup = async (phone, o = {}) => {
  const r = await K.setup(phone, Object.assign({ config: Object.assign({}, K.cfg, { daily_cap: 10 }) }, o));
  if (o.post && o.post.useClock) o.post.useClock(r.clk);
  return r;
};

// One outer driver call; every chained post runs inside it.
function chainingPost() {
  const one = fakePost();
  let sessions = 0, clk = null;
  const fn = async (args, d) => {
    sessions++;
    let out = await one(args, d), deps = d;
    for (;;) {
      if (typeof deps.next !== "function") return out;
      const prepare = await deps.next(out);
      if (!prepare) return Object.assign({}, out, { chained: true });
      if (clk) clk.t = new Date(clk.t.getTime() + 3 * MIN); // the dwell between posts
      const call = await prepare();
      if (!call) return Object.assign({}, out, { chained: true });
      out = await one(call.args, call.deps); deps = call.deps;
    }
  };
  fn.calls = one.calls;
  fn.sessions = () => sessions;
  fn.useClock = (c) => { clk = c; };
  return fn;
}

(async () => {
  // ── standing: both groups in one session, minutes apart, not 20+ ──
  {
    const post = chainingPost();
    const { deps, at } = await setup(undefined, { post });
    let c = await C.create(base(), deps);
    const t = new Date("2026-09-23T12:00:00+03:00");
    c = await S.tick(c, deps, at(t));
    c = await S.tick(c, deps, at(new Date(c.posts[0].scheduled_at)));
    assert.equal(post.sessions(), 1, "one browser session");
    assert.equal(post.calls.length, 2, "two posts in it");
    assert.deepEqual(c.posts.map((p) => [p.group_id, p.status]), [["111", "posted"], ["222", "posted"]]);
  }

  // ── per-post: a post still waiting for the agent is never taken; one set for later neither ──
  {
    const post = chainingPost();
    const { deps, at } = await setup(undefined, { post });
    let c = await C.create(base({ mode: "per_post" }), deps);
    const t = new Date("2026-09-23T12:00:00+03:00");
    c = await S.tick(c, deps, at(t));
    c = await C.approvePost(c.id, c.posts[0].id, deps);
    c = await S.tick(c, deps, at(new Date(c.posts[0].scheduled_at)));
    assert.equal(post.calls.length, 1, "the next one waits for its approval");
    assert.equal(c.posts[1] && c.posts[1].status, "pending_approval", "the next is planned as usual — and waits for the agent");
  }
  {
    const post = chainingPost();
    const { deps, at } = await setup(undefined, { post });
    await K.db.savePage(K.page("pg2"));
    const c1 = await C.create(base({ mode: "per_post" }), deps);
    const c2 = await C.create(base({ mode: "per_post", page: K.page("pg2") }), deps);
    const t = new Date("2026-09-23T12:00:00+03:00");
    await S.tick(c1, deps, at(t));
    await S.tick(c2, deps, at(new Date(t.getTime() + 30 * MIN)));
    let a = await store.getPostingCampaign(c1.id), b = await store.getPostingCampaign(c2.id);
    await C.approvePost(a.id, a.posts[0].id, deps);
    await C.approvePost(b.id, b.posts[0].id, deps, { at: new Date(t.getTime() + 6 * HOUR) }); // the agent's own time
    a = await store.getPostingCampaign(c1.id);
    await S.tick(a, deps, at(new Date(a.posts[0].scheduled_at)));
    assert.equal(post.calls.length, 1, "the post the agent set for later is not pulled into this session");
    b = await store.getPostingCampaign(c2.id);
    assert.equal(b.posts[0].status, "scheduled");
    assert.ok(b.posts[0].not_before);
  }

  // ── a failed post ends the session: nothing is pushed after it ──
  {
    const inner = fakePost("verified_failed:composer_not_found");
    let asked = 0;
    const post = async (args, d) => { const out = await inner(args, d); if (d.next) { asked++; const p = await d.next(out); assert.equal(p, null); } return out; };
    const { deps, at } = await setup(undefined, { post });
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(new Date("2026-09-23T12:00:00+03:00")));
    c = await S.tick(c, deps, at(new Date(c.posts[0].scheduled_at)));
    assert.equal(asked, 1);
    assert.equal(inner.calls.length, 1);
  }

  // ── POSTING_CHAIN=0: one post per session ──
  {
    const post = chainingPost();
    const { deps, at } = await setup(undefined, { post });
    deps.env = Object.assign({}, deps.env, { POSTING_CHAIN: "0" });
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(new Date("2026-09-23T12:00:00+03:00")));
    c = await S.tick(c, deps, at(new Date(c.posts[0].scheduled_at)));
    assert.equal(post.calls.length, 1);
  }
  console.log("posting-chain.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
