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
const serverIndex = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");
const envExample = fs.readFileSync(path.join(root, "server", ".env.example"), "utf8");

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

// The dashboard REPORTS where a listing was published; it never publishes.
// Publishing belongs to publish.html — the in-card controls were removed once
// the workspace took over, and reading status must not smuggle them back.
assert.match(indexHtml, /data-distrow=/);
assert.match(indexHtml, /distribution\/status\?full=1/);
assert.doesNotMatch(indexHtml, /distribution\/publish|data-publish=|data-dist=/);

// Settings contain only Page connection plus manual/default Group links.
assert.match(distributionHtml, /חיבורים וקבוצות/);
assert.match(distributionHtml, /קבוצות ברירת מחדל/);
assert.doesNotMatch(distributionHtml, /stepStrip|מייבא הקבוצות|סנכרון הקבוצות|הקבוצות שלי/);
assert.doesNotMatch(distributionJs, /extension|joined-groups|chrome\.runtime|מייבא הקבוצות/);

// OAuth carries only a server-constructed property workspace return target.
assert.match(routes, /publishWorkspacePath/);
assert.match(routes, /return_to: publishWorkspacePath\(req\.query\.page_id\)/);
assert.doesNotMatch(routes, /\/extension\/|EXTENSION_ID|joined-groups|group_posting/);
assert.doesNotMatch(serverIndex, /extension-cors|EXTENSION_ID|chrome-extension/);
assert.doesNotMatch(envExample, /EXTENSION_ID|chrome-extension/);

console.log("backend-only-share.test.js OK");
