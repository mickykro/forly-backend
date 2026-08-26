#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const route = fs.readFileSync(path.join(__dirname, "..", "routes", "distribution.js"), "utf8");

assert.ok(route.includes('completion: queueSummary.posted ? "posted_complete" : (queueSummary.skipped ? "no_posts_skipped" : "no_targets")'));
assert.ok(route.includes('reason: "no_eligible_groups"'));
assert.ok(route.includes('unavailable: unavailable.slice(0, 20)'));
assert.ok(route.includes('summary: queueSummary'));

console.log("queue-outcomes.test.js OK");
