const assert = require("assert");
const D = require("./posting-destination");

const page = {
  property: { title: "דירת 4 חדרים בחיפה" },
  agent: { name: "דנה", phone: "0501234567" },
};
const fb = "https://www.facebook.com/dana.nadlan/posts/77/";

assert.equal(D.safeFacebookUrl("javascript:alert(1)"), null);
assert.equal(D.safeFacebookUrl("https://evil.example/facebook.com/posts/1"), null);
assert.equal(D.safeFacebookUrl(fb), fb);
assert.match(D.whatsappUrl(page), /^https:\/\/wa\.me\/972501234567\?text=/);
assert.ok(decodeURIComponent(D.whatsappUrl(page)).includes("דירת 4 חדרים בחיפה"));

const dists = [
  { updated_at: "2026-09-20", targets: { facebook_page: { status: "posted", post_url: "https://www.facebook.com/old/posts/1" } } },
  { updated_at: "2026-09-21", targets: { facebook_page: { status: "failed", post_url: "https://www.facebook.com/failed/posts/2" } } },
  { updated_at: "2026-09-22", targets: { facebook_page: { status: "posted", post_url: fb } } },
];
assert.equal(D.pagePostFrom(dists), fb, "latest real posted Page URL");

// Every post, every group, every round: the property page's own link.
for (let i = 0; i < 20; i++) {
  const args = { page, campaign: { page_id: "pg1" }, target: { target: "group", group_id: String(i), url: `https://www.facebook.com/groups/${i}` }, pagePostUrl: fb, variantRound: i % 3 };
  assert.deepEqual(D.choose(args), { kind: "property", url: null });
}
assert.deepEqual(D.choose({ page, campaign: { page_id: "pg1" }, target: { target: "page", group_id: "555" }, pagePostUrl: fb }), { kind: "property", url: null });

for (const kind of D.KINDS) assert.ok(D.notice(kind).includes("קישור"), `${kind} is explained to the agent`);
assert.equal(D.previewUrl({ kind: "none" }, { pageBaseUrl: "https://f.ly", pageId: "pg1" }), null);
assert.equal(D.previewUrl({ kind: "property" }, { pageBaseUrl: "https://f.ly", pageId: "pg1" }), "https://f.ly/p/pg1");
assert.equal(D.previewUrl({ kind: "facebook_page", url: fb }, {}), fb);
const attempt = { page_id: "pg1", click_id: "abc123" };
assert.equal(D.commentUrl({ link_kind: "property" }, attempt, { pageBaseUrl: "https://f.ly" }), "https://f.ly/p/pg1/abc123");
assert.equal(D.commentUrl({ link_kind: "none" }, attempt, { pageBaseUrl: "https://f.ly" }), null);
assert.match(D.commentUrl({ link_kind: "whatsapp", link_url: D.whatsappUrl(page) }, attempt, {}), /^https:\/\/wa\.me\//);
assert.equal(D.commentUrl({ link_kind: "facebook_page", link_url: fb }, attempt, {}), fb);

console.log("posting-destination.test.js ok");
