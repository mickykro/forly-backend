/* posting-manual-prep.js: one target made ready in the admin's browser (never
   Post), and the look after the admin moved on. The driver's fake page. */
const assert = require("assert");
const F = require("./posting-driver-fakes");
const PREP = require("./posting-manual-prep");
const S = require("./posting-driver-proof").SELECTORS;

const item = (o) => Object.assign({ campaign_id: "c1", group_id: "111", group_url: F.GROUP_URL, kind: "group", copy: F.COPY }, o);
const FILE = { name: "property.mp4", mimeType: "video/mp4", buffer: Buffer.from("v") };
function page(o = {}) {
  const p = F.fakePage(Object.assign({ counts: Object.assign({ [S.mediaInput]: 1, [S.mediaAttached]: 1, [S.mediaProgress]: 0 }, o.counts) }, o));
  // The manual tab types like a person at the keyboard (routes/admin-manual /type): into the focused editor.
  p.keyboard.insertText = async (t) => { p.st.editor += t; };
  p.keyboard.press = async (k) => { p.st.pressed.push(k); if (k === "Enter") p.st.editor += "\n"; };
  return p;
}

(async () => {
  // ── ready: the group opened, video in, text typed, checks passed — and no Post ──
  {
    const p = page();
    const r = await PREP.prepare(p, item(), F.connOf(), { file: FILE });
    assert.deepEqual(r, { ok: true, pendingBefore: false, seenBefore: [] });
    assert.deepEqual(p.st.visited, [F.GROUP_URL]);
    assert.equal(p.st.files.length, 1, "the video went into the composer");
    assert.equal(p.st.editor, F.COPY, "the text, line by line");
    assert.equal(p.st.submitted, false, "never Post");
    assert.ok(!p.st.clicks.includes(S.submit));
  }
  // ── no video: text only ──
  {
    const p = page();
    assert.equal((await PREP.prepare(p, item(), F.connOf(), {})).ok, true);
    assert.equal(p.st.files, undefined);
  }
  // ── failures name their reason ──
  assert.equal((await PREP.prepare(page({ counts: { [S.joinGroup]: 1 } }), item(), F.connOf(), {})).code, "not_member");
  assert.equal((await PREP.prepare(page({ counts: { [S.composer]: 0 } }), item(), F.connOf(), {})).code, "composer_not_found");
  assert.equal((await PREP.prepare(page({ counts: { [S.mediaInput]: 0 } }), item(), F.connOf(), { file: FILE })).code, "media_not_found");
  // The R3 proof still runs, but a mismatch is a warning on the ready post: the admin looks and decides.
  {
    const r = await PREP.prepare(page(), item(), F.connOf({ facebook_identity_label: "Someone Else" }), {});
    assert.equal(r.ok, true); assert.equal(r.warn, "identity_mismatch"); assert.ok(r.check, "which check, for diagnosis");
  }
  assert.equal((await PREP.prepare(page({ texts: { [S.dialog]: "Your account is restricted" } }), item(), F.connOf(), {})).ok, false, "a warning on the page stops it");
  // ── the admin moved on: stops at the next step, types nothing ──
  {
    const p = page();
    let n = 0;
    const r = await PREP.prepare(p, item(), F.connOf(), { alive: () => ++n < 2 });
    assert.equal(r.code, "cancelled");
    assert.equal(p.st.editor, "");
  }
  // ── cancelled while typing: no further keystroke goes in ──
  {
    const p = page();
    let live = true;
    const insert = p.keyboard.insertText;
    p.keyboard.insertText = async (t) => { await insert(t); live = false; };
    const r = await PREP.prepare(p, item({ copy: "line one\nline two\nline three" }), F.connOf(), { alive: () => live });
    assert.equal(r.code, "cancelled");
    assert.equal(p.st.editor, "line one", "stopped before the second line");
  }

  // ── check(): only looks ──
  {
    const p = page();
    await PREP.prepare(p, item(), F.connOf(), {});
    assert.equal(await PREP.check(p, item(), F.connOf()), "not_posted", "the composer still holds the text");
    // The admin clicked Post: the composer is gone, the post is in the feed.
    const posted = page({ counts: { [S.composerRoot]: 0 }, feed: [{ href: `${F.PERMA}?x=1`, author: F.NAME, text: F.COPY }] });
    assert.equal(await PREP.check(posted, item(), F.connOf(), { seenBefore: [] }), "posted");
    assert.equal(await PREP.check(posted, item(), F.connOf()), "unsure", "no baseline (a failed preparation): the feed proves nothing");
    // An older post of the same copy, already there when prepare() looked: not a new publication.
    const old = { href: `${F.PERMA}?x=1`, author: F.NAME, text: F.COPY };
    const before = await PREP.prepare(page({ feed: [old] }), item(), F.connOf(), {});
    assert.equal(before.seenBefore.length, 1);
    assert.equal(await PREP.check(posted, item(), F.connOf(), { seenBefore: before.seenBefore }), "unsure");
    // A cut text ("… See more") only starts like the copy: never proof.
    const cut = page({ counts: { [S.composerRoot]: 0 }, feed: [{ href: `${F.PERMA}?x=1`, author: F.NAME, text: `${F.COPY.slice(0, 40)}… See more` }] });
    assert.equal(await PREP.check(cut, item(), F.connOf(), { seenBefore: [] }), "unsure");
    const pending = page({ counts: { [S.composerRoot]: 0 }, feed: [], texts: { [S.alert]: "Your post is pending approval" } });
    assert.equal(await PREP.check(pending, item(), F.connOf()), "posted", "held for the group's admins: it went up");
    assert.equal(await PREP.check(pending, item(), F.connOf(), { pendingBefore: true }), "unsure", "a banner that was there before is not ours");
    assert.equal(await PREP.check(page({ counts: { [S.composerRoot]: 0 }, feed: [] }), item(), F.connOf()), "unsure");
    assert.equal(p.st.submitted, false);
  }
  console.log("posting-manual-prep.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
