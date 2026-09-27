/* routes/posting.js /act — the signed WhatsApp one-tap link, and
   actionLink() that Task 20 builds it with: the signature covers the
   campaign, the post, the action and the expiry; a tampered, expired or
   mismatched link is a 403 page on GET and POST; the phone is the
   campaign's own. A GET only asks (link previews fetch URLs); the page's
   button POSTs to the same URL, which acts. */
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

  // ── GET only asks: nothing changes, and the page's one button POSTs to the same link ──
  {
    const env = await setup();
    const c = await pendingCampaign(env);
    const before = JSON.stringify(await store.getPostingCampaign(c.id));
    for (const [a, q] of [["stop", "לעצור את הקמפיין?"], ["skip", "לדלג על הפוסט?"], ["approve", "לאשר את הפרסום?"]]) {
      const path = linkFor(c.id, a === "stop" ? "" : "p1", a);
      const r = await call(env.app, "GET", path);
      assert.equal(r.status, 200, a); assert.ok(r.headers["content-type"].startsWith("text/html"));
      assert.ok(r.raw.includes(q), a);
      assert.equal(r.headers["cache-control"], "no-store"); assert.equal(r.headers["referrer-policy"], "no-referrer"); assert.equal(r.headers["x-robots-tag"], "noindex");
      const forms = r.raw.match(/<form id="act" method="post" action="([^"]+)">/g) || [];
      assert.equal(forms.length, 1, a); assert.equal((r.raw.match(/<button/g) || []).length, 1, a);
      const action = forms[0].match(/action="([^"]+)"/)[1].replace(/&amp;/g, "&");
      assert.equal(action, path, "the button posts to the same link");
    }
    assert.equal(JSON.stringify(await store.getPostingCampaign(c.id)), before, "a GET changes nothing");
  }

  // ── GET shows the post: the property's video, the copy as its description, the link as the first comment ──
  {
    const env = await setup();
    const V = "https://cdn.f.ly/files/pg/walkthrough.mp4", PO = "https://cdn.f.ly/files/pg/poster.jpg";
    const c = await pendingCampaign(env, { copy: "דירה בחיפה\n4 חדרים", video_url: V, poster_url: PO });
    const r = await call(env.app, "GET", linkFor(c.id, "p1", "approve"));
    assert.ok(r.raw.includes(`<video controls playsinline preload="metadata" src="${V}" poster="${PO}"`), "the video");
    assert.ok(r.raw.includes("דירה בחיפה\n4 חדרים"), "the copy, line breaks kept");
    assert.ok(r.raw.includes(`/p/${c.page_id}`) && r.raw.includes("תגובה ראשונה"), "the first comment");
    assert.ok(r.raw.indexOf("<video") < r.raw.indexOf("<form"), "the post above the button");
    // A post planned before videos were stored: the page's own video.
    const page = await K.db.getPage(c.page_id);
    await K.db.savePage(Object.assign({}, page, { hero: { video_url: V, poster_url: "javascript:alert(1)" } }));
    const old = await pendingCampaign(env);
    const r2 = await call(env.app, "GET", linkFor(old.id, "p1", "approve"));
    assert.ok(r2.raw.includes(`src="${V}"`) && !r2.raw.includes("javascript:"), "the page's video; no unsafe poster");
    // No video: said so, no player.
    const none = await pendingCampaign(env, { video_url: null });
    const r3 = await call(env.app, "GET", linkFor(none.id, "p1", "skip"));
    assert.ok(!r3.raw.includes("<video") && r3.raw.includes("טקסט בלבד"));
    // Stop has no post to show.
    assert.ok(!(await call(env.app, "GET", linkFor(c.id, "", "stop"))).raw.includes("<video"));
  }

  // ── POST a valid stop link: stopped — with no login, and whatever the switches say ──
  {
    const env = await setup();
    const c = await pendingCampaign(env);
    globalOff();
    const r = await call(R.makeApp({ deps: env.deps, phone: "nobody" }), "POST", linkFor(c.id, "", "stop", env.clk.t));
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
      for (const m of ["GET", "POST"]) {
        const r = await call(env.app, m, path);
        assert.equal(r.status, 403, `${m} ${name}`); assert.ok(r.raw.includes("<html"), name); assert.ok(r.raw.includes("אינו תקף"), name);
        assert.ok(!r.raw.includes("<form"), "no button on a refused link");
      }
    }
    // Expired: the same genuine link, 72 hours and a second later.
    env.clk.t = new Date(K.NOW.getTime() + 72 * K.HOUR + 1000);
    for (const m of ["GET", "POST"]) {
      const exp = await call(env.app, m, pathOf(good.toString()));
      assert.equal(exp.status, 403, m); assert.ok(exp.raw.includes("פג תוקף"));
    }
    const cur = await store.getPostingCampaign(c.id);
    assert.equal(cur.status, "running"); assert.equal(cur.posts[0].status, "pending_approval");
  }

  // ── approve: re-timed and scheduled; refused while posting is off; the page names the group ──
  {
    const env = await setup();
    const c = await pendingCampaign(env);
    globalOff();
    const off = await call(env.app, "POST", linkFor(c.id, "p1", "approve"));
    assert.equal(off.status, 409); assert.ok(off.raw.includes("כבוי"));
    assert.equal((await store.getPostingCampaign(c.id)).posts[0].status, "pending_approval");
    globalOn();
    const ok = await call(env.app, "POST", linkFor(c.id, "p1", "approve"));
    assert.equal(ok.status, 200); assert.ok(ok.raw.includes("אושר")); assert.ok(ok.raw.includes("דירות בחיפה"));
    const p = (await store.getPostingCampaign(c.id)).posts[0];
    assert.equal(p.status, "scheduled"); assert.ok(p.approved_at);
    const twice = await call(env.app, "POST", linkFor(c.id, "p1", "approve"));
    assert.equal(twice.status, 200); assert.ok(twice.raw.includes("כבר לא ממתין"));
    assert.equal((await call(env.app, "POST", linkFor(c.id, "p9", "approve"))).status, 404);
    assert.equal((await call(env.app, "POST", linkFor("f".repeat(32), "p1", "stop"))).status, 404);
  }

  // ── skip: works with posting off; a name is escaped into the page ──
  {
    const env = await setup();
    const c = await pendingCampaign(env, { group_name: "<script>x</script>" });
    globalOff();
    const r = await call(env.app, "POST", linkFor(c.id, "p1", "skip"));
    assert.equal(r.status, 200); assert.ok(r.raw.includes("דילגנו"));
    assert.equal((await store.getPostingCampaign(c.id)).posts[0].status, "skipped");
    globalOn();
    const again = await call(env.app, "POST", linkFor(c.id, "p1", "skip"));
    assert.equal(again.status, 200); assert.ok(again.raw.includes("כבר לא ממתין"));
    const c2 = await pendingCampaign(await setup(), { group_name: "<b>x</b>" });
    const html = await call(env.app, "POST", linkFor(c2.id, "p1", "approve"));
    assert.ok(!html.raw.includes("<b>x</b>") && html.raw.includes("&lt;b&gt;"), "escaped");
  }

  // ── the approval page: the text is editable, and what the agent leaves is what gets posted ──
  {
    const http = require("http");
    const { sha } = require("../posting-campaign");
    const form = (app, path, fields) => new Promise((resolve, reject) => {
      const body = new URLSearchParams(fields).toString();
      const srv = app.listen(0, () => {
        const q = http.request({ port: srv.address().port, path, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } }, (r) => {
          let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { srv.close(); resolve({ status: r.statusCode, raw: d }); });
        });
        q.on("error", reject); q.end(body);
      });
    });
    const env = await setup();
    const c = await pendingCampaign(env);
    const original = (await store.getPostingCampaign(c.id)).posts[0].copy;
    const ask = await call(env.app, "GET", linkFor(c.id, "p1", "approve"));
    assert.match(ask.raw, /<textarea id="copy" name="copy" form="act"/, "approve: an editable text in the form");
    assert.ok(ask.raw.includes("אפשר לערוך את הטקסט"));
    const skipPage = await call(env.app, "GET", linkFor(c.id, "p1", "skip"));
    assert.ok(!skipPage.raw.includes("<textarea"), "skip: read-only");
    // empty or too long → refused, still waiting
    for (const bad of ["   ", "x".repeat(3001)]) {
      const r = await form(env.app, linkFor(c.id, "p1", "approve"), { copy: bad });
      assert.equal(r.status, 400, bad.length);
      assert.equal((await store.getPostingCampaign(c.id)).posts[0].status, "pending_approval");
    }
    const mine = "דירה מדהימה 🏠\r\nכתבו לי בפרטי\u0007";
    const ok = await form(env.app, linkFor(c.id, "p1", "approve"), { copy: mine });
    assert.equal(ok.status, 200); assert.ok(ok.raw.includes("עם הטקסט שערכתם"));
    const p = (await store.getPostingCampaign(c.id)).posts[0];
    assert.deepEqual([p.status, p.copy, p.copy_hash, p.copy_edited, p.base_hash],
      ["scheduled", "דירה מדהימה 🏠\nכתבו לי בפרטי", sha("דירה מדהימה 🏠\nכתבו לי בפרטי"), true, sha(original)], "saved clean, with the text it was edited from");
    // the text left as it was → approved as generated
    const env2 = await setup();
    const c2 = await pendingCampaign(env2);
    const same = (await store.getPostingCampaign(c2.id)).posts[0].copy;
    const ok2 = await form(env2.app, linkFor(c2.id, "p1", "approve"), { copy: same });
    assert.equal(ok2.status, 200); assert.ok(!ok2.raw.includes("עם הטקסט שערכתם"));
    const p2 = (await store.getPostingCampaign(c2.id)).posts[0];
    assert.equal(p2.copy_edited, undefined); assert.equal(p2.copy, same);
  }

  console.log("routes/posting-act.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
