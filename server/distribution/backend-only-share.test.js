#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const indexHtml = fs.readFileSync(path.join(root, "public-agent", "index.html"), "utf8");
const shareHtml = fs.readFileSync(path.join(root, "public-agent", "share.html"), "utf8");
const publishHtml = fs.readFileSync(path.join(root, "public-agent", "publish.html"), "utf8");
const publishJs = fs.readFileSync(path.join(root, "public-agent", "publish.js"), "utf8");
const distributionHtml = fs.readFileSync(path.join(root, "public-agent", "distribution.html"), "utf8");
const distributionJs = fs.readFileSync(path.join(root, "public-agent", "distribution.js"), "utf8");
const routes = fs.readFileSync(path.join(root, "server", "routes", "distribution.js"), "utf8");

// One selected property opens one combined Page-and-Groups workspace.
assert.match(indexHtml, /\/publish\.html\?page=/);
assert.match(publishJs, /share-session/);
assert.match(publishJs, /\/api\/distribution\/publish/);
assert.match(publishJs, /openConnectDialog/);
assert.match(publishHtml, /פרסום בדף הפייסבוק/);
assert.match(publishHtml, /שיתוף ידני בקבוצות/);
assert.match(publishJs, /העתקת הטקסט/);
assert.match(publishJs, /פתיחת הקבוצה/);
assert.match(publishJs, /✓ פרסמתי/);
assert.match(publishJs, /דילוג/);

// Existing signed links retain their query parameters while migrating.
assert.match(shareHtml, /location\.replace\("\/publish\.html\?"/);

// Distribution is settings-only, never an extension posting surface.
assert.match(distributionHtml, /חיבורים וקבוצות/);
assert.doesNotMatch(distributionHtml, /stepStrip/);
assert.doesNotMatch(distributionHtml, /modeAssist|modeAuto|התחלה בתוסף/);
assert.doesNotMatch(distributionJs, /\/api\/distribution\/extension\/mode/);
assert.doesNotMatch(distributionJs, /התוסף כותב את הפוסט/);
assert.match(distributionJs, /מייבא הקבוצות/);

// OAuth carries only a server-constructed property workspace return target.
assert.match(routes, /publishWorkspacePath/);
assert.match(routes, /return_to: publishWorkspacePath\(req\.query\.page_id\)/);
assert.match(routes, /router\.get\("\/extension\/next"[\s\S]{0,300}status\(410\)\.json\(\{ error: "extension_posting_retired" \}\)/);
assert.match(routes, /router\.post\("\/extension\/result"[\s\S]{0,300}status\(410\)\.json\(\{ error: "extension_posting_retired" \}\)/);

console.log("backend-only-share.test.js OK");
