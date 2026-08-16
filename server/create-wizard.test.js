"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const createPage = fs.readFileSync(path.join(__dirname, "..", "public-agent", "create.html"), "utf8");

[
  'data-wizard-panel="1"',
  'data-wizard-panel="2"',
  'data-wizard-panel="3"',
  'id="nextStage1"',
  'id="nextStage2"',
  'id="prevStage2"',
  'id="prevStage3"',
  "function validateStageOne()",
  "function validateStageTwo()",
  "function setWizardStage(stage, moveFocus)",
  'class="create-hero"',
  'class="stage-nav"',
  'class="creation-grid"',
  'class="preview-column"',
  'id="livePreviewCard"',
  'id="livePreviewImage"',
  'class="deal-toggle"',
  'data-deal="sale"',
  'data-deal="rent"',
  "function updateLivePreview()",
].forEach((marker) => {
  assert.ok(createPage.includes(marker), `missing wizard marker: ${marker}`);
});

assert.ok(createPage.includes('if (photos.length < 4)'), "media-stage validation must retain the four-photo requirement");
assert.ok(createPage.includes('"/api/properties/demo-create"'), "demo creation endpoint must remain available");
assert.ok(createPage.includes('"/api/properties/create"'), "authenticated creation endpoint must remain available");
assert.ok(createPage.includes("data-wizard-step=\"3\""), "progress rail must expose the final design stage");

console.log("create-wizard.test.js ✓");
