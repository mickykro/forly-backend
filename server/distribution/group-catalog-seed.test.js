#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "group-seed.json"), "utf8"));
const urlPattern = /^https:\/\/www\.facebook\.com\/groups\/[A-Za-z0-9._-]+$/;
const urls = seed.map((group) => group.url);
assert.strictEqual(new Set(urls).size, urls.length, "catalog Group URLs must be unique");
assert.ok(urls.every((url) => urlPattern.test(url)), "catalog must contain direct normalized Facebook Group URLs only");

const curated = seed.filter((group) => group.curated_at === "2026-08-26");
assert.strictEqual(curated.length, 200, "must add exactly 200 new curated Group records");
for (const group of curated) {
  assert.strictEqual(group.agent_policy, "explicitly_allowed", `${group.url} must have explicit agent policy`);
  assert.ok(String(group.policy_evidence || "").trim(), `${group.url} must retain public policy evidence`);
  assert.match(String(group.source_url || ""), /^https?:\/\//, `${group.url} must retain a source URL`);
  assert.ok(Array.isArray(group.listing_types) && group.listing_types.length, `${group.url} needs listing types`);
  assert.ok(Array.isArray(group.languages) && group.languages.length, `${group.url} needs languages`);
}

console.log("group-catalog-seed.test.js OK");
