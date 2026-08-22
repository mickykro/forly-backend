/*
 * Unit tests for distribution/share-kit.js — copy builders + group sanitizer.
 * Run: node server/distribution/share-kit.test.js
 */
const assert = require("assert");
const { MAX_GROUPS, buildPostCopy, sanitizeGroups, sharerLink, buildShareKitMessage } = require("./share-kit");

const page = {
  property: { title: "4 חד׳ בבבלי", neighborhood: "בבלי", city: "תל אביב",
    rooms: 4, size_sqm: 105, floor: 3, price: 4200000, listing_type: "sale" },
  agent: { name: "דנה לוי", phone: "972501234567" },
};
const url = "https://forly.example/p/dana-abc12";

// ── post copy carries the facts, the link, and the agent ──
const copy = buildPostCopy(page, url);
assert.ok(copy.includes("4 חד׳ בבבלי"), "title present");
assert.ok(copy.includes("בבלי, תל אביב"), "location present");
assert.ok(copy.includes("4 חדרים"), "rooms present");
assert.ok(copy.includes("105"), "sqm present");
assert.ok(copy.includes("קומה 3"), "floor present");
assert.ok(copy.includes("₪4,200,000"), "price formatted with separators");
assert.ok(copy.includes(url), "page link present");
assert.ok(copy.includes("דנה לוי"), "agent name present");
assert.ok(copy.includes("0501234567"), "phone shown in local 05x form");

// ── missing fields drop their lines instead of printing zeros ──
const bare = buildPostCopy({ property: { title: "נכס" }, agent: {} }, url);
assert.ok(!bare.includes("קומה"), "no floor line when floor is 0/absent");
assert.ok(!bare.includes("₪"), "no price line when price is 0/absent");
assert.ok(bare.includes(url));

// ── group sanitizer: facebook.com/groups/* only, normalized, deduped, capped ──
assert.deepEqual(sanitizeGroups([
  "https://www.facebook.com/groups/tlvrealestate",
  "https://facebook.com/groups/tlvrealestate/",          // dupe after normalize
  "https://m.facebook.com/groups/dira.bemerkaz",
  "https://www.facebook.com/dana.levy",                  // not a group → dropped
  "https://evil.example/groups/x",                       // wrong host → dropped
  "not a url",
]), [
  "https://www.facebook.com/groups/tlvrealestate",
  "https://www.facebook.com/groups/dira.bemerkaz",
]);
assert.equal(sanitizeGroups(null).length, 0, "non-array ⇒ empty, not a crash");
const many = Array.from({ length: 30 }, (_, i) => `https://www.facebook.com/groups/g${i}`);
assert.equal(sanitizeGroups(many).length, MAX_GROUPS, "capped at MAX_GROUPS");

// ── sharer link URL-encodes the page URL ──
assert.equal(sharerLink("https://x.test/p/a?b=1"),
  "https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent("https://x.test/p/a?b=1"));
// quote rides along so the post text needs no copy-paste
const quoted = new URL(sharerLink(url, { quote: "טקסט מוכן" }));
assert.equal(quoted.searchParams.get("quote"), "טקסט מוכן");
// with an app id the official Share Dialog is used
const dlg = new URL(sharerLink(url, { quote: "q", appId: "123" }));
assert.equal(dlg.origin + dlg.pathname, "https://www.facebook.com/dialog/share");
assert.equal(dlg.searchParams.get("app_id"), "123");
assert.equal(dlg.searchParams.get("href"), url);
assert.equal(dlg.searchParams.get("quote"), "q");

// ── share-kit message: copy between markers, quick-share link, numbered groups ──
const kit = buildShareKitMessage({ copy: "COPYBLOCK", pageUrl: url,
  groups: ["https://www.facebook.com/groups/a", "https://www.facebook.com/groups/b"] });
assert.ok(kit.includes("COPYBLOCK"));
const marker = kit.split("\n").find((l) => /^─+$/.test(l));
assert.ok(marker, "copy is fenced between ── marker lines");
assert.equal(kit.split("\n").filter((l) => l === marker).length, 2, "two marker lines");
assert.ok(kit.includes(sharerLink(url, { quote: "COPYBLOCK" })), "quick-share carries the copy as quote");
assert.ok(kit.includes("1. https://www.facebook.com/groups/a"));
assert.ok(kit.includes("2. https://www.facebook.com/groups/b"));
// appId flips the quick-share to the official dialog
const kitDlg = buildShareKitMessage({ copy: "C", pageUrl: url, groups: [], appId: "123" });
assert.ok(kitDlg.includes("facebook.com/dialog/share"), "dialog link when appId present");

// ── no groups saved yet: honest nudge instead of an empty list ──
const empty = buildShareKitMessage({ copy: "C", pageUrl: url, groups: [] });
assert.ok(!empty.includes("1. "), "no numbered lines");
assert.ok(empty.includes("לא הוגדרו"), "tells the agent no groups are saved yet");

console.log("share-kit.test.js OK");
