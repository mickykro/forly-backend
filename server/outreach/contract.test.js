"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MAX_CLIPS, MAX_LINES, MAX_LINE_CHARS } = require("../overlay");
const root = path.join(__dirname, "../../docs/outreach");
const read = (name) =>
  JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const schema = read("render.v1.schema.json");
// Small validator for this checked-in schema's asserted keywords. No network or schema dependency.
function validate(rule, value) {
  if (rule.const !== undefined) assert.deepEqual(value, rule.const);
  if (rule.type) {
    const actual =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    assert.ok([].concat(rule.type).includes(actual), `expected ${rule.type}`);
  }
  if (typeof value === "string") {
    if (rule.pattern) assert.match(value, new RegExp(rule.pattern));
    if (rule.minLength) assert.ok(value.length >= rule.minLength);
    if (rule.maxLength) assert.ok(value.length <= rule.maxLength);
    if (rule.format === "uri") assert.ok(new URL(value));
  }
  if (typeof value === "number" && rule.exclusiveMinimum !== undefined)
    assert.ok(value > rule.exclusiveMinimum);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of rule.required || [])
      assert.ok(Object.hasOwn(value, key), "required " + key);
    if (rule.additionalProperties === false)
      for (const key of Object.keys(value))
        assert.ok(Object.hasOwn(rule.properties, key), "unexpected " + key);
    for (const [key, child] of Object.entries(rule.properties || {}))
      if (Object.hasOwn(value, key)) validate(child, value[key]);
  }
  if (Array.isArray(value)) {
    if (rule.minItems) assert.ok(value.length >= rule.minItems);
    if (rule.maxItems) assert.ok(value.length <= rule.maxItems);
    if (rule.items) for (const item of value) validate(rule.items, item);
    if (rule.contains) {
      const count = value.filter((item) => {
        try {
          validate(rule.contains, item);
          return true;
        } catch {
          return false;
        }
      }).length;
      assert.ok(count >= (rule.minContains || 1));
      if (rule.maxContains) assert.ok(count <= rule.maxContains);
    }
  }
  if (rule.oneOf) {
    let passing = 0;
    for (const child of rule.oneOf) {
      try {
        validate(child, value);
        passing++;
      } catch {}
    }
    assert.equal(passing, 1);
  }
  for (const child of rule.allOf || []) validate(child, value);
}
const pipeline = read("fixtures/pipeline-request.v1.json"),
  request = read("fixtures/overlay-request.v1.json"),
  response = read("fixtures/overlay-response.v1.json");
validate(schema.$defs.pipelineRequest, pipeline);
validate(schema.$defs.overlayRequest, request);
validate(schema.$defs.overlayResponse, response);
assert.equal(
  schema.$defs.overlayRequest.properties.video_urls.maxItems,
  MAX_CLIPS,
);
assert.equal(schema.$defs.overlayRequest.properties.lines.maxItems, MAX_LINES);
assert.equal(
  schema.$defs.overlayRequest.properties.lines.items.maxLength,
  MAX_LINE_CHARS,
);
for (const mutate of [
  (x) => (x.version = 2),
  (x) => (x.brandMode = "clean_paid"),
  (x) => (x.image_requests[0].url = "http://127.0.0.1/private"),
  (x) => (x.image_requests[0].body.demo_id = "x"),
  (x) => (x.image_requests[0].headers["x-forly-signature"] = "invalid"),
]) {
  const bad = structuredClone(pipeline);
  mutate(bad);
  assert.throws(() => validate(schema.$defs.pipelineRequest, bad));
}
for (const mutate of [
  (x) => (x.renditions[1].url = "/files/clean.mp4"),
  (x) => (x.renditions[0].rendition = "clean_paid"),
  (x) => (x.renditions[0].path = "/private/path"),
  (x) => (x.watermark_version = ""),
  (x) => x.renditions.pop(),
]) {
  const bad = structuredClone(response);
  mutate(bad);
  assert.throws(() => validate(schema.$defs.overlayResponse, bad));
}
assert.equal(pipeline.demo_id, request.demo_id);
assert.equal(pipeline.correlation_id, request.correlation_id);
for (const image of pipeline.image_requests)
  assert.equal(image.body.demo_id, pipeline.demo_id);
console.log("outreach v1 render contract fixture tests passed");
