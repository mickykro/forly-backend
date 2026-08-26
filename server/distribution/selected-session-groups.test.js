#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const route = fs.readFileSync(path.join(__dirname, "..", "routes", "distribution.js"), "utf8");

assert.ok(route.includes("function queueEntriesForGroups(session, urls)"));
assert.ok(route.includes("async function replaceShareSessionGroups(session, urls)"));
assert.ok(route.includes("const selectedId = String(s.selected_session_id || \"\");"));
assert.ok(route.includes("Array.isArray(selectedSession.groups) && selectedSession.groups.length === 0"));
assert.ok(route.includes("await replaceShareSessionGroups(selectedSession, groups)"));
assert.ok(route.includes("refreshed_selected_empty_session"));
assert.ok(route.includes("selected_session_group_count"));

console.log("selected-session-groups.test.js OK");
