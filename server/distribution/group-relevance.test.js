#!/usr/bin/env node

const assert = require("assert");
const { classifyGroup, decorateJoinedGroup } = require("./group-relevance");

assert.equal(classifyGroup({ name: "דירות להשכרה בתל אביב" }).relevance, "relevant");
assert.equal(classifyGroup({ name: "Israel Real Estate Investors" }).relevance, "relevant");
assert.equal(classifyGroup({ name: "תל אביב קנייה ומכירה" }).relevance, "review");
assert.equal(classifyGroup({ name: "חובבי טיולים בישראל" }).relevance, "irrelevant");
assert.equal(classifyGroup({ name: "Anything", catalogEntry: { url: "https://example.test" } }).relevance, "relevant");

const auto = decorateJoinedGroup({ url: "https://www.facebook.com/groups/a", name: "דירות להשכרה בתל אביב" });
assert.equal(auto.enabled, true);
assert.equal(auto.relevance_source, "heuristic");

const overridden = decorateJoinedGroup({
  url: "https://www.facebook.com/groups/a",
  name: "דירות להשכרה בתל אביב",
  previous: { enabled: false, relevance_override: "irrelevant" },
});
assert.equal(overridden.enabled, false);
assert.equal(overridden.relevance, "irrelevant");
assert.equal(overridden.relevance_source, "agent");

console.log("group-relevance.test.js OK");
