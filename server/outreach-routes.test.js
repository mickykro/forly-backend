const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createAdminOutreachRouter } = require("./routes/admin-outreach");
const { createOutreachRouter } = require("./routes/outreach");
async function request(app, path, options) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${path}`,
      options,
    );
    return {
      status: response.status,
      headers: response.headers,
      body: await response.text(),
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const admin = (req, res, next) => {
  req.user = { userId: "972500000001" };
  next();
};
test("every admin mutation requires fresh step up before service access", async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/admin/outreach",
    createAdminOutreachRouter({
      service: new Proxy(
        {},
        {
          get: () => () => {
            throw Error("must not call");
          },
        },
      ),
      requireAdmin: admin,
      requireStepUp: (req, res) =>
        res.status(401).json({ error: "stepup_required" }),
    }),
  );
  for (const path of [
    "/leads",
    "/scans",
    "/leads/a/review",
    "/leads/a/corrections",
    "/leads/a/reject",
    "/leads/a/build",
    "/leads/a/delivery-approve",
    "/leads/a/manual-confirm",
    "/leads/a/suppress",
    "/leads/a/verify-claim",
    "/leads/a/payment",
    "/leads/a/upgrade",
  ])
    assert.equal(
      (
        await request(app, "/api/admin/outreach" + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
});
test("public preview escapes facts and never caches token responses", async () => {
  const app = express();
  app.use(
    createOutreachRouter({
      service: {
        getPublicDemo: async () => ({
          status: "active",
          title: "<script>attack</script>",
          expires_at: "2030-01-01T00:00:00Z",
          photos: [],
          source_post_url: "SECRET",
          clean_video_url: "CLEAN_SECRET_MEDIA",
        }),
      },
    }),
  );
  const result = await request(app, "/d/opaque");
  assert.equal(result.status, 200);
  assert.match(result.headers.get("cache-control"), /no-store/);
  assert.match(result.headers.get("x-robots-tag"), /noindex/);
  assert.ok(!result.body.includes("SECRET"));
  assert.ok(!result.body.includes("CLEAN_SECRET_MEDIA"));
  assert.ok(!result.body.includes("<script>attack"));
});
test("expired previews reveal no media or prospect facts", async () => {
  const app = express();
  app.use(
    createOutreachRouter({
      service: {
        getPublicDemo: async () => ({
          status: "expired",
          title: "SECRET",
          photos: ["SECRET"],
        }),
      },
    }),
  );
  const result = await request(app, "/api/outreach/demos/opaque");
  assert.equal(result.status, 410);
  assert.ok(!result.body.includes("SECRET"));
});
test("claim binds verified session identity instead of supplied phone", async () => {
  let received;
  const app = express();
  app.use(express.json());
  app.use(
    createOutreachRouter({
      requireAuth: admin,
      service: {
        claimDemo: async (token, body, actor) => {
          received = { body, actor };
          return { status: "claim_started" };
        },
      },
    }),
  );
  const result = await request(app, "/api/outreach/demos/opaque/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: "attacker", acknowledged: true }),
  });
  assert.equal(result.status, 200);
  assert.equal(received.body.phone, "972500000001");
  assert.equal(received.actor.userId, "972500000001");
});

test("public asset route fails closed on revoked manifests", async () => {
  let checked;
  const app = express();
  app.use(
    createOutreachRouter({
      service: {},
      assets: {
        resolve: async (id, token) => {
          checked = { id, token };
          return null;
        },
      },
    }),
  );
  const result = await request(
    app,
    "/api/outreach/assets/asset-id?token=opaque",
  );
  assert.equal(result.status, 404);
  assert.deepEqual(checked, { id: "asset-id", token: "opaque" });
  assert.match(result.headers.get("cache-control"), /no-store/);
});
test("preview JSON excludes foreign media and sensitive unrecognized fields", async () => {
  const app = express();
  app.use(
    createOutreachRouter({
      service: {
        getPublicDemo: async () => ({
          status: "active",
          title: "Forly",
          photos: [
            "https://external.invalid/private.jpg",
            "/api/outreach/assets/a?token=opaque",
          ],
          video_url: "/files/clean.mp4",
          facts: { phone: "SECRET_PHONE" },
          source_post_url: "SECRET_SOURCE",
        }),
      },
    }),
  );
  const result = await request(app, "/api/outreach/demos/opaque");
  const body = JSON.parse(result.body);
  assert.deepEqual(body.photos, ["/api/outreach/assets/a?token=opaque"]);
  assert.equal(body.video_url, null);
  assert.ok(!result.body.includes("SECRET"));
});
test("outreach detail and list require admin authorization", async () => {
  const app = express();
  app.use(
    "/api/admin/outreach",
    createAdminOutreachRouter({
      service: {},
      requireAdmin: (req, res) => res.status(403).json({ error: "not_admin" }),
      requireStepUp: admin,
    }),
  );
  for (const path of [
    "/leads",
    "/leads/private",
    "/leads/private/delivery-kit",
  ])
    assert.equal(
      (await request(app, "/api/admin/outreach" + path)).status,
      403,
    );
});
test("new prospect OTP routes use dedicated verifier and never return sessions", async () => {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use(
    createOutreachRouter({
      service: {},
      claimAuth: {
        request: async (token, input, ip) => {
          calls.push({ token, phone: input.phone });
          return { status: "code_sent" };
        },
        verify: async () => ({ status: "ownership_review_pending" }),
      },
    }),
  );
  const response = await request(app, "/api/outreach/demos/token/otp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: "0501234567" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ token: "token", phone: "0501234567" }]);
  assert.equal(response.headers.get("set-cookie"), null);
});
test("public preview shows only approved property fact keys with escaped values", async () => {
  const app = express();
  app.use(
    createOutreachRouter({
      service: {
        getPublicDemo: async () => ({
          status: "active",
          title: "Forly",
          photos: [],
          facts: {
            location: "<b>Haifa</b>",
            rooms: 4,
            area: 90,
            listing_type: "sale",
            floor: 0,
            phone: "SECRET_PHONE",
            source: "SECRET_POST",
          },
        }),
      },
    }),
  );
  const result = await request(app, "/d/opaque");
  assert.match(result.body, /Location/);
  assert.match(result.body, /&lt;b&gt;Haifa&lt;\/b&gt;/);
  assert.match(result.body, /<dd>0<\/dd>/);
  assert.ok(!result.body.includes("SECRET"));
});
test("group scans require step up and pass verified admin identity to discovery", async () => {
  let input, actor;
  const app = express();
  app.use(express.json());
  app.use(
    "/api/admin/outreach",
    createAdminOutreachRouter({
      service: {},
      requireAdmin: admin,
      requireStepUp: (req, res, next) => next(),
      discovery: {
        start: async (body, user) => {
          input = body;
          actor = user;
          return { id: "scan", status: "queued" };
        },
        status: async (id) => ({
          id,
          status: "done",
          groups_visited: 2,
          posts_seen: 8,
          selected: 3,
          duplicates: 1,
          reasons: { not_property: 4 },
        }),
      },
    }),
  );
  const result = await request(app, "/api/admin/outreach/scans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      campaign_id: "outreach",
      max_groups: 3,
      max_candidates: 5,
    }),
  });
  assert.equal(result.status, 200);
  assert.equal(input.max_groups, 3);
  assert.equal(actor.userId, "972500000001");
  const status = await request(app, "/api/admin/outreach/scans/scan");
  assert.equal(JSON.parse(status.body).posts_seen, 8);
});
test("latest scan list is admin protected and gracefully handles missing list capability", async () => {
  let options;
  const app = express();
  app.use(
    "/api/admin/outreach",
    createAdminOutreachRouter({
      service: {},
      requireAdmin: admin,
      requireStepUp: admin,
      discovery: {
        list: async (input) => {
          options = input;
          return { scans: [{ id: "running", status: "running" }] };
        },
      },
    }),
  );
  const response = await request(app, "/api/admin/outreach/scans");
  assert.deepEqual(options, { limit: 1 });
  assert.equal(JSON.parse(response.body).scans[0].id, "running");
  const fallback = express();
  fallback.use(
    "/api/admin/outreach",
    createAdminOutreachRouter({
      service: {},
      requireAdmin: admin,
      requireStepUp: admin,
      discovery: {},
    }),
  );
  assert.deepEqual(
    JSON.parse((await request(fallback, "/api/admin/outreach/scans")).body),
    { scans: [], next_cursor: null },
  );
});
