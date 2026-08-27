/*
 * The dashboard's publishing row, exercised against the real functions pulled
 * out of index.html (same trick as loader.test.js).
 *
 * The invariant under test: a post the agent already made is THEIR result and
 * is reported whatever features.distribution currently says. That flag gates
 * publishing, not looking at what already happened — revoking it, or never
 * granting it after a pilot, must never blank an agent's own numbers.
 *
 * Run: node public-agent/dist-tags.test.js
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const script = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).join("\n");

const grab = (name) => {
  const m = script.match(new RegExp("\\n  function " + name + "\\([\\s\\S]*?\\n  \\}\\n"));
  assert.ok(m, `could not extract ${name}() from index.html — did it get renamed?`);
  return m[0];
};
const src = ["esc", "distTag", "distLink", "statsHtml", "renderDistTags"].map(grab).join("\n");

// Minimal fake DOM: renderDistTags only needs querySelectorAll + dataset + innerHTML.
const rows = new Map();
global.document = { querySelectorAll: () => [...rows.values()] };
const seed = (ids) => {
  rows.clear();
  ids.forEach((id) => rows.set(id, { dataset: { distrow: id }, innerHTML: "" }));
};
const text = (id) => rows.get(id).innerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const raw = (id) => rows.get(id).innerHTML;

eval(src);

const PUBLISHED = { posted: true, post_url: "https://www.facebook.com/1_2", in_flight: false,
  groups: { posted: 3, total: 8 },
  metrics: { likes: 42, comments: 7, shares: 5, reach: null, impressions: null,
    video_views: null, insights: "not_permitted" } };
const UNTOUCHED = { posted: false, post_url: null, in_flight: false,
  groups: { posted: 0, total: 0 }, metrics: null };
const GROUPS_ONLY = { posted: false, post_url: null, in_flight: false,
  groups: { posted: 2, total: 5 }, metrics: null };

// ── the invariant: results survive the feature flag being off ──
for (const entitled of [true, false]) {
  seed(["pub"]);
  renderDistTags({ pub: PUBLISHED }, entitled);
  assert.match(text("pub"), /פורסם בפיד/, `published chip hidden when entitled=${entitled}`);
  assert.match(raw("pub"), /href="https:\/\/www\.facebook\.com\/1_2"/,
    `post link hidden when entitled=${entitled}`);
  assert.match(text("pub"), /❤️ 42/, `engagement hidden when entitled=${entitled}`);
  assert.match(text("pub"), /3\/8/, `group progress hidden when entitled=${entitled}`);
}

// Group work the agent actually did also survives it.
seed(["grp"]);
renderDistTags({ grp: GROUPS_ONLY }, false);
assert.match(text("grp"), /2\/5/, "confirmed group shares are results too");

// ── entitlement decides only the empty, forward-looking states ──
{
  seed(["none"]);
  renderDistTags({ none: UNTOUCHED }, true);
  assert.match(text("none"), /טרם פורסם/, "an agent in the programme sees the to-do");
  assert.match(text("none"), /לא נבחרו קבוצות/);

  seed(["none"]);
  renderDistTags({ none: UNTOUCHED }, false);
  assert.equal(text("none"), "", "nothing happened and no feature ⇒ no noise on the card");
}

// ── a post deleted on Facebook is not still advertised as live ──
{
  const DELETED = { posted: true, post_url: "https://www.facebook.com/999", in_flight: false,
    groups: { posted: 1, total: 3 },
    metrics: { missing: true, error_code: 100, fetched_at: null } };
  seed(["gone"]);
  renderDistTags({ gone: DELETED }, true);
  // Graph's code 100 covers "deleted" AND "not visible to this token", so the
  // card states what we know — we could not read it — and links out so the
  // agent can see which it is.
  assert.match(text("gone"), /לא הצלחנו לקרוא/, "says what we actually know");
  assert.match(raw("gone"), /href="https:\/\/www\.facebook\.com\/999"/,
    "links out so the agent can check whether the post is really gone");
  assert.doesNotMatch(text("gone"), /❤️|💬|🔁/, "no counts — zeroes would read as no engagement");
  assert.match(text("gone"), /1\/3/, "group shares the agent DID make still stand");
}

// ── never a fabricated number, and never a link we did not build ──
{
  seed(["odd"]);
  renderDistTags({ odd: { posted: true, post_url: "javascript:alert(1)", in_flight: false,
    groups: { posted: 0, total: 0 }, metrics: { likes: 1, comments: 0, shares: 0 } } }, true);
  assert.doesNotMatch(raw("odd"), /javascript:/, "only https urls are linkified");
  assert.match(text("odd"), /פורסם בפיד/, "still reported, just not as a link");

  // Every metric keeps its slot so cards line up, but an unreadable one shows
  // "–" rather than 0 — views need read_insights, and 0 would claim nobody
  // watched, which is a different and false statement.
  seed(["noins"]);
  renderDistTags({ noins: PUBLISHED }, true);
  assert.match(text("noins"), /👁 –/, "views slot present, honestly blank");
  assert.doesNotMatch(text("noins"), /👁 0/, "never a fabricated zero");
  assert.match(text("noins"), /❤️ 42/);
}

// ── a listing the batch did not answer for is left alone ──
{
  seed(["absent"]);
  rows.get("absent").innerHTML = "PREVIOUS";
  renderDistTags({ other: PUBLISHED }, true);
  assert.equal(raw("absent"), "PREVIOUS", "rows outside this batch are untouched");
}

console.log("dist-tags.test.js OK");
