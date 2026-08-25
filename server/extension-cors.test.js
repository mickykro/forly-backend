#!/usr/bin/env node

const assert = require("node:assert/strict");
const createExtensionCors = require("./extension-cors");

const extensionId = "jnaglgobdgepikfkcjdgninkdfllcmlg";
const allowedOrigin = `chrome-extension://${extensionId}`;

function invoke({ origin, method = "OPTIONS", configuredId = extensionId } = {}) {
  const headers = {};
  let varied = null;
  let nextCalled = false;
  let statusCode = null;
  let ended = false;
  const req = { method, get: (name) => (name === "Origin" ? origin : undefined) };
  const res = {
    set: (patch) => Object.assign(headers, patch),
    vary: (name) => { varied = name; },
    status: (code) => { statusCode = code; return res; },
    end: () => { ended = true; },
  };
  createExtensionCors(configuredId)(req, res, () => { nextCalled = true; });
  return { headers, varied, nextCalled, statusCode, ended };
}

const preflight = invoke({ origin: allowedOrigin, method: "OPTIONS" });
assert.equal(preflight.statusCode, 204);
assert.equal(preflight.ended, true);
assert.equal(preflight.nextCalled, false);
assert.equal(preflight.headers["Access-Control-Allow-Origin"], allowedOrigin);
assert.equal(preflight.headers["Access-Control-Allow-Headers"], "Content-Type, X-Forly-Ext");
assert.equal(preflight.varied, "Origin");

const post = invoke({ origin: allowedOrigin, method: "POST" });
assert.equal(post.nextCalled, true);
assert.equal(post.headers["Access-Control-Allow-Origin"], allowedOrigin);

const otherExtension = invoke({ origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
assert.equal(otherExtension.nextCalled, true);
assert.deepEqual(otherExtension.headers, {});

const noConfiguredId = invoke({ origin: allowedOrigin, configuredId: "" });
assert.equal(noConfiguredId.nextCalled, true);
assert.deepEqual(noConfiguredId.headers, {});

console.log("extension-cors.test.js OK");
