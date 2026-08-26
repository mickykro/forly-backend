#!/usr/bin/env node

const assert = require("assert");
const { spawnSync } = require("child_process");
const path = require("path");

const script = `
  const assert = require('assert');
  const P = require('./pacing');
  const now = new Date('2026-08-25T09:00:00Z').getTime();
  const posts = Array.from({ length: 40 }, (_, i) => ({
    at: new Date(now - (i + 5) * 5 * 60 * 1000).toISOString(),
    group_url: 'https://www.facebook.com/groups/old-' + i,
    page_id: 'old-' + i,
  }));
  const result = P.canPost({
    first_post_at: new Date(now - 30 * 86400000).toISOString(), posts,
  }, {
    groupUrl: 'https://www.facebook.com/groups/new-target', pageId: 'new-property',
  }, { now });
  assert.equal(P.DAILY_CAP_DISABLED, true);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.daily_cap_disabled, true);
  assert.equal(result.remaining_today, null);
`;

const run = spawnSync(process.execPath, ["-e", script], {
  cwd: __dirname,
  env: { ...process.env, DISTRIBUTION_DISABLE_DAILY_CAP: "true" },
  encoding: "utf8",
});
assert.equal(run.status, 0, run.stderr || run.stdout);

console.log("pacing-development-cap.test.js OK");
