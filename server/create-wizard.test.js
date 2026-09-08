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
  'id="extractBlock"',
  'id="extractInput"',
  'id="extractBtn"',
  'id="extractManual"',
  'id="extractCard"',
  'id="extractCardList"',
  'id="extractShowAll"',
  'id="extractPhotos"',
  'id="manualFields"',
  '<script src="/extract.js"></script>',
  "function runExtract()",
  "function showMissingCard(",
  "function addImportedPhoto(",
  "/api/properties/extract",
  "/api/photos/import-url",
].forEach((marker) => {
  assert.ok(createPage.includes(marker), `missing wizard marker: ${marker}`);
});

assert.ok(createPage.includes('if (photos.length < 4)'), "media-stage validation must retain the four-photo requirement");
assert.ok(createPage.includes('"/api/properties/demo-create"'), "demo creation endpoint must remain available");
assert.ok(createPage.includes('"/api/properties/create"'), "authenticated creation endpoint must remain available");
assert.ok(createPage.includes("data-wizard-step=\"3\""), "progress rail must expose the final design stage");

const intakeRoutes = fs.readFileSync(path.join(__dirname, "routes", "intake.js"), "utf8");
assert.match(intakeRoutes, /require\("\.\.\/upload-store"\)/);
assert.match(intakeRoutes, /storeBuffer\(\{ fname, buffer: req\.body/);

const i18n = fs.readFileSync(path.join(__dirname, "..", "public-agent", "form-i18n.js"), "utf8");
["ext_title", "ext_ph", "ext_btn", "ext_working", "ext_manual", "ext_missing_title", "ext_all_set", "ext_show_all",
 "ext_photos_found", "ext_err_unavailable", "ext_err_unreadable", "ext_err_fb_connect", "ext_err_limit"]
  .forEach((k) => assert.equal((i18n.match(new RegExp(`"${k}":`, "g")) || []).length >= 2, true, `i18n key ${k} in he and en`));

console.log("create-wizard.test.js ✓");
