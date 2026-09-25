/* posting-guard.js — one assertion per denial reason, allowed paths for
   dwell without a permission and post with one, and no caching: a switch
   flipped between two calls is seen by the second call. No network: db and
   env are fakes. */
const assert = require("assert");
const { assertAllowed } = require("./posting-guard");

const PHONE = "0500000000";
const PLATFORM = "facebook";

const GRANTED = { enabled: true, platforms: ["facebook"], allows_visible_interactions: true };

function fakeDb({ settings = null, conn = {} } = {}) {
  return {
    settings,
    conn,
    getSetting: async (key) => (key === "posting" ? settings : null),
    getConnection: async () => conn,
  };
}

async function denies(opts, deps, reason) {
  await assert.rejects(
    () => assertAllowed(opts, deps),
    (e) => e.code === "posting_disabled" && e.reason === reason,
    `expected reason ${reason}`,
  );
}

(async () => {
  // ── env_off: the global kill switch, checked before anything else ──
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "dwell" },
    { db: fakeDb(), env: { POSTING_ENABLED: "0" } },
    "env_off",
  );

  // ── global_off: settings/posting.enabled === false ──
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "dwell" },
    { db: fakeDb({ settings: { enabled: false } }), env: {} },
    "global_off",
  );

  // ── platform_off: settings/posting.platforms[platform] === false ──
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "navigate" },
    { db: fakeDb({ settings: { enabled: true, platforms: { facebook: false } } }), env: {} },
    "platform_off",
  );

  // ── visible_off: settings/posting.visible_interactions_enabled === false, only for like/story ──
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "like" },
    { db: fakeDb({ settings: { enabled: true, visible_interactions_enabled: false }, conn: { posting_permission: GRANTED } }), env: {} },
    "visible_off",
  );
  // dwell is not a visible interaction — visible_interactions_enabled: false does not touch it
  assert.strictEqual(
    await assertAllowed(
      { phone: PHONE, platform: PLATFORM, action: "dwell" },
      { db: fakeDb({ settings: { enabled: true, visible_interactions_enabled: false } }), env: {} },
    ),
    true,
  );

  // ── account_disabled: posting_disabled_until_admin === true ──
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "dwell" },
    { db: fakeDb({ conn: { posting_disabled_until_admin: true } }), env: {} },
    "account_disabled",
  );

  // ── account_penalty: posting_penalty_until in the future, action === post only ──
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "post" },
    { db: fakeDb({ conn: { posting_penalty_until: future, posting_permission: GRANTED } }), env: {} },
    "account_penalty",
  );
  // a penalty in the future does not block dwell/navigate/session/retry
  assert.strictEqual(
    await assertAllowed(
      { phone: PHONE, platform: PLATFORM, action: "dwell" },
      { db: fakeDb({ conn: { posting_penalty_until: future } }), env: {} },
    ),
    true,
  );
  // an EXPIRED penalty does not block post either
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  assert.strictEqual(
    await assertAllowed(
      { phone: PHONE, platform: PLATFORM, action: "post" },
      { db: fakeDb({ conn: { posting_penalty_until: past, posting_permission: GRANTED } }), env: {} },
    ),
    true,
  );

  // ── profile_revoked: <platform>_profile_state in revoked|quarantined ──
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "session" },
    { db: fakeDb({ conn: { facebook_profile_state: "revoked" } }), env: {} },
    "profile_revoked",
  );
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "navigate" },
    { db: fakeDb({ conn: { facebook_profile_state: "quarantined" } }), env: {} },
    "profile_revoked",
  );

  // ── no_permission: post/like/story/reserve need a posting_permission that is enabled ──
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "reserve" },
    { db: fakeDb({ conn: {} }), env: {} },
    "no_permission",
  );
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "post" },
    { db: fakeDb({ conn: { posting_permission: { enabled: false, platforms: ["facebook"] } } }), env: {} },
    "no_permission",
  );

  // ── permission_scope: permission enabled but this platform is not included ──
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "post" },
    { db: fakeDb({ conn: { posting_permission: { enabled: true, platforms: ["yad2"] } } }), env: {} },
    "permission_scope",
  );

  // ── visible_not_allowed: permission granted but not for visible interactions ──
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "like" },
    { db: fakeDb({ conn: { posting_permission: { enabled: true, platforms: ["facebook"], allows_visible_interactions: false } } }), env: {} },
    "visible_not_allowed",
  );

  // ── allowed: dwell needs no posting_permission at all ──
  assert.strictEqual(
    await assertAllowed({ phone: PHONE, platform: PLATFORM, action: "dwell" }, { db: fakeDb(), env: {} }),
    true,
  );
  // ── allowed: session/navigate/retry likewise need no permission ──
  for (const action of ["session", "navigate", "retry"]) {
    assert.strictEqual(
      await assertAllowed({ phone: PHONE, platform: PLATFORM, action }, { db: fakeDb(), env: {} }),
      true,
      `${action} should not require posting_permission`,
    );
  }
  // ── allowed: post with a full, scoped permission ──
  assert.strictEqual(
    await assertAllowed(
      { phone: PHONE, platform: PLATFORM, action: "post" },
      { db: fakeDb({ conn: { posting_permission: GRANTED } }), env: {} },
    ),
    true,
  );

  // ── missing settings/posting doc means enabled (default allow) ──
  assert.strictEqual(
    await assertAllowed({ phone: PHONE, platform: PLATFORM, action: "dwell" }, { db: fakeDb({ settings: null }), env: {} }),
    true,
  );

  // ── no caching: a switch flipped between two calls is seen by the second ──
  {
    const settings = { enabled: true };
    const deps = { db: fakeDb({ settings }), env: {} };
    assert.strictEqual(await assertAllowed({ phone: PHONE, platform: PLATFORM, action: "dwell" }, deps), true);
    settings.enabled = false;
    await denies({ phone: PHONE, platform: PLATFORM, action: "dwell" }, deps, "global_off");
  }

  // ── default deps: db defaults to the real module, env to process.env ──
  {
    process.env.POSTING_ENABLED = "0";
    await denies({ phone: PHONE, platform: PLATFORM, action: "dwell" }, {}, "env_off");
    delete process.env.POSTING_ENABLED;
  }

  console.log("posting-guard.test.js ok");
})().catch((err) => { console.error(err); process.exit(1); });
