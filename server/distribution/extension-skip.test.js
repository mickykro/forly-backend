#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const route = fs.readFileSync(path.join(__dirname, "..", "routes", "distribution.js"), "utf8");
const start = route.indexOf('router.post("/extension/result"');
const end = route.indexOf('// The groups this agent is actually a member of', start);
const resultRoute = route.slice(start, end);

assert.ok(resultRoute.includes('if (status === "skipped")'));
assert.ok(resultRoute.includes('state: "skipped"'));
assert.ok(resultRoute.includes('skipped_at: now'));
assert.ok(resultRoute.includes('advance_immediately: true'));
assert.ok(resultRoute.includes('if (status === "failed")'));
assert.ok(resultRoute.includes('state: "ready"'));
assert.ok(resultRoute.includes('if (status !== "posted")'));
assert.ok(resultRoute.includes('error: "invalid_status"'));
assert.ok(!resultRoute.includes('[`groups.${idx}.state`]'), "extension results must rewrite the groups array safely");

console.log("extension-skip.test.js OK");
