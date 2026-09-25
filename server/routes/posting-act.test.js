/* routes/posting.js GET /act — the signed WhatsApp one-tap link, and
   actionLink() that Task 20 builds it with: the signature covers the
   campaign, the post, the action and the expiry; a tampered, expired or
   mismatched link is a 403 page; the phone is the campaign's own. */
const assert = require("assert");
const { signActionToken } = require("../auth");
const R = require("./posting-routes-kit");

const { K, AUTH, setup, call, globalOff, globalOn, pendingCampaign, createRouter } = R;
const { store } = K;
const OPTS = { authSecret: AUTH, pageBaseUrl: "https://f.ly/" };
const pathOf = (link) => link.replace("https://f.ly", "");
const linkFor = (campaignId, postId, action, now = K.NOW) => pathOf(createRouter.actionLink({ campaignId, postId, action, now }, OPTS));

(async () => {
  // ── actionLink: the shape Task 20 sends; 72 hours; signed over [c, p, a, e] ──
  {
    const link = createRouter.actionLink({ campaignId: "c".repeat(32), postId: "p1", action: "approve", now: K.NOW }, OPTS);
    const u = new URL(link);
    assert.equal(u.origin + u.pathname, "https://f.ly/api/posting/act");
    const e = Number(u.searchParams.get("e"));
    assert.equal(e, Math.floor(K.NOW.getTime() / 1000) + 72 * 3600);
    assert.equal(u.searchParams.get("t"), signActionToken(["c".repeat(32), "p1", "approve", String(e)], AUTH));
    assert.equal(new URL(createRouter.actionLink({ campaignId: "abc", action: "stop" }, OPTS)).searchParams.get("p"), "");
    assert.throws(() => createRouter.actionLink({ campaignId: "abc", action: "delete" }, OPTS));
    assert.throws(() => createRouter.actionLink({ campaignId: "a:b", action: "stop" }, OPTS));
    assert.equal(typeof createRouter.CONSENT_VERSION, "string");
  }

  // ── a valid stop link stops the campaign — with no login, and whatever the switches say ──
  {
    const env = await setup();
    const c = await pendingCampaign(env);
    globalOff();
    const r = await call(R.makeApp({ deps: env.deps, phone: "nobody" }), "GET", linkFor(c.id, "", "stop", env.clk.t));
    assert.equal(r.status, 200);
    assert.ok(r.raw.includes("הפרסום נעצר")); assert.ok(r.headers["content-type"].startsWith("text/html"));
    assert.equal(r.headers["cache-control"], "no-store");
    const after = await store.getPostingCampaign(c.id);
    assert.equal(after.status, "stopped"); assert.equal(after.posts[0].status, "skipped");
    globalOn();
  }

  // ── tampered, expired, mismatched or incomplete links: a 403 page, nothing done ──
  {
    const env = await setup();
    const c = await pendingCampaign(env);
    const good = new URL(`https://f.ly${linkFor(c.id, "p1", "approve")}`);
    const variant = (edit) => { const u = new URL(good); edit(u.searchParams); return u.pathname + u.search; };
    const cases = {
      tampered: variant((q) => q.set("t", q.get("t").slice(0, -2) + (q.get("t").endsWith("AA") ? "BB" : "AA"))),
      action_mismatch: variant((q) => q.set("a", "stop")),
      post_mismatch: variant((q) => q.set("p", "p2")),
      extended: variant((q) => q.set("e", String(Number(q.get("e")) + 3600))),
      no_token: variant((q) => q.delete("t")),
      other_secret: pathOf(createRouter.actionLink({ campaignId: c.id, postId: "p1", action: "approve", now: K.NOW }, { authSecret: "other", pageBaseUrl: "https://f.ly" })),
      legacy_three_parts: `/api/posting/act?c=${c.id}&p=p1&a=approve&t=${signActionToken([c.id, "p1", "approve"], AUTH)}`,
    };
    for (const [name, path] of Object.entries(cases)) {
      const r = await call(env.app, "GET", path);
      assert.equal(r.status, 403, name); assert.ok(r.raw.includes("<html"), name); assert.ok(r.raw.includes("אינו תקף"), name);
    }
    // Expired: the same genuine link, 72 hours and a second later.
    env.clk.t = new Date(K.NOW.getTime() + 72 * K.HOUR + 1000);
    const exp = await call(env.app, "GET", pathOf(good.toString()));
    assert.equal(exp.status, 403); assert.ok(exp.raw.includes("פג תוקף"));
    const cur = await store.getPostingCampaign(c.id);
    assert.equal(cur.status, "running"); assert.equal(cur.posts[0].status, "pending_approval");
  }

  // ── approve: re-timed and scheduled; refused while posting is off; the page names the group ──
  {
    const env = await setup();
    const c = await pendingCampaign(env);
    globalOff();
    const off = await call(env.app, "GET", linkFor(c.id, "p1", "approve"));
    assert.equal(off.status, 409); assert.ok(off.raw.includes("כבוי"));
    assert.equal((await store.getPostingCampaign(c.id)).posts[0].status, "pending_approval");
    globalOn();
    const ok = await call(env.app, "GET", linkFor(c.id, "p1", "approve"));
    assert.equal(ok.status, 200); assert.ok(ok.raw.includes("אושר")); assert.ok(ok.raw.includes("דירות בחיפה"));
    const p = (await store.getPostingCampaign(c.id)).posts[0];
    assert.equal(p.status, "scheduled"); assert.ok(p.approved_at);
    const twice = await call(env.app, "GET", linkFor(c.id, "p1", "approve"));
    assert.equal(twice.status, 200); assert.ok(twice.raw.includes("כבר לא ממתין"));
    assert.equal((await call(env.app, "GET", linkFor(c.id, "p9", "approve"))).status, 404);
    assert.equal((await call(env.app, "GET", linkFor("f".repeat(32), "p1", "stop"))).status, 404);
  }

  // ── skip: works with posting off; a name is escaped into the page ──
  {
    const env = await setup();
    const c = await pendingCampaign(env, { group_name: "<script>x</script>" });
    globalOff();
    const r = await call(env.app, "GET", linkFor(c.id, "p1", "skip"));
    assert.equal(r.status, 200); assert.ok(r.raw.includes("דילגנו"));
    assert.equal((await store.getPostingCampaign(c.id)).posts[0].status, "skipped");
    globalOn();
    const again = await call(env.app, "GET", linkFor(c.id, "p1", "skip"));
    assert.equal(again.status, 200); assert.ok(again.raw.includes("כבר לא ממתין"));
    const c2 = await pendingCampaign(await setup(), { group_name: "<b>x</b>" });
    const html = await call(env.app, "GET", linkFor(c2.id, "p1", "approve"));
    assert.ok(!html.raw.includes("<b>x</b>") && html.raw.includes("&lt;b&gt;"), "escaped");
  }

  console.log("routes/posting-act.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
