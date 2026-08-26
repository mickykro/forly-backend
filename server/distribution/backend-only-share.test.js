#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const shareHtml = fs.readFileSync(path.join(root, "public-agent", "share.html"), "utf8");
const shareJs = fs.readFileSync(path.join(root, "public-agent", "share.js"), "utf8");
const distributionHtml = fs.readFileSync(path.join(root, "public-agent", "distribution.html"), "utf8");
const distributionJs = fs.readFileSync(path.join(root, "public-agent", "distribution.js"), "utf8");
const routes = fs.readFileSync(path.join(root, "server", "routes", "distribution.js"), "utf8");

assert.doesNotMatch(shareHtml, /extensionStartCard|startExtension/);
assert.doesNotMatch(shareJs, /startInExtension|previewInExtension|chrome\.runtime\.sendMessage/);
assert.match(shareJs, /העתקת הטקסט/);
assert.match(shareJs, /פתיחת הקבוצה/);
assert.match(shareJs, /✓ פרסמתי/);
assert.match(shareJs, /דילוג/);
assert.doesNotMatch(distributionHtml, /modeAssist|modeAuto|התחלה בתוסף/);
assert.doesNotMatch(distributionJs, /\/api\/distribution\/extension\/mode/);
assert.doesNotMatch(distributionJs, /התוסף כותב את הפוסט/);
assert.match(distributionJs, /מייבא הקבוצות/);
assert.match(routes, /router\.get\("\/extension\/next"[\s\S]{0,300}status\(410\)\.json\(\{ error: "extension_posting_retired" \}\)/);
assert.match(routes, /router\.post\("\/extension\/result"[\s\S]{0,300}status\(410\)\.json\(\{ error: "extension_posting_retired" \}\)/);

console.log("backend-only-share.test.js OK");
