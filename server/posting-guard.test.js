/* posting-guard.js — one assertion per denial reason, allowed paths for
   dwell without a permission and post with one, and no caching: a switch
   flipped between two calls is seen by the second call. No network: db and
   env are fakes. */
const assert = require("assert");
const { assertAllowed, assertFleetAllowed, postingEnvAllowed } = require("./posting-guard");

const PHONE = "0500000000";
const PLATFORM = "facebook";

const GRANTED = { enabled: true, platforms: ["facebook"], allows_visible_interactions: true };

// Posting is OFF unless switched on (I5): every allowed path below runs with
// the env switch on and a settings/posting doc that says enabled: true.
const ON = { POSTING_ENABLED: "1" };
const ENABLED = { enabled: true };

function fakeDb({ settings = ENABLED, conn = {} } = {}) {
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
    { db: fakeDb({ settings: { enabled: false } }), env: ON },
    "global_off",
  );

  // ── platform_off: settings/posting.platforms[platform] === false ──
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "navigate" },
    { db: fakeDb({ settings: { enabled: true, platforms: { facebook: false } } }), env: ON },
    "platform_off",
  );

  // ── visible_off: settings/posting.visible_interactions_enabled === false, only for like/story ──
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "like" },
    { db: fakeDb({ settings: { enabled: true, visible_interactions_enabled: false }, conn: { posting_permission: GRANTED } }), env: ON },
    "visible_off",
  );
  // dwell is not a visible interaction — visible_interactions_enabled: false does not touch it
  assert.strictEqual(
    await assertAllowed(
      { phone: PHONE, platform: PLATFORM, action: "dwell" },
      { db: fakeDb({ settings: { enabled: true, visible_interactions_enabled: false } }), env: ON },
    ),
    true,
  );

  // ── account_disabled: posting_disabled_until_admin === true ──
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "dwell" },
    { db: fakeDb({ conn: { posting_disabled_until_admin: true } }), env: ON },
    "account_disabled",
  );

  // ── account_disabled also covers an owner-level review (R5: second disabling halt in 30 days) ──
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "reserve" },
    { db: fakeDb({ conn: { posting_owner_review_required: true, posting_permission: GRANTED } }), env: ON },
    "account_disabled",
  );

  // ── account_penalty (R5): only day one of a penalty stops a post — while the
  //    newest penalising halt is under 24 h old; after that the caps are halved
  //    (posting-safety), and the guard lets the post through ──
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const T0 = new Date("2026-09-23T10:00:00Z");
  const halted = (hoursAgo, code = "rate_limited") => ({
    posting_penalty_until: new Date(T0.getTime() + 14 * 86400000).toISOString(),
    posting_halts: [{ at: new Date(T0.getTime() - hoursAgo * 3600000).toISOString(), code }],
    posting_permission: GRANTED,
  });
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "post" },
    { db: fakeDb({ conn: halted(2) }), env: ON, now: T0 },
    "account_penalty",
  );
  assert.strictEqual(
    await assertAllowed({ phone: PHONE, platform: PLATFORM, action: "post" }, { db: fakeDb({ conn: halted(72) }), env: ON, now: T0 }),
    true,
    "3 days into the penalty a post is allowed (caps are halved elsewhere)",
  );
  // the newest PENALISING halt counts — a later login_required does not restart day one
  const mixed = halted(72);
  mixed.posting_halts.push({ at: new Date(T0.getTime() - 3600000).toISOString(), code: "login_required" });
  assert.strictEqual(await assertAllowed({ phone: PHONE, platform: PLATFORM, action: "post" }, { db: fakeDb({ conn: mixed }), env: ON, now: T0 }), true);
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "post" },
    { db: fakeDb({ conn: halted(23, "feature_blocked") }), env: ON, now: T0 },
    "account_penalty",
  );
  // a penalty in the future does not block dwell/navigate/session/retry
  assert.strictEqual(
    await assertAllowed(
      { phone: PHONE, platform: PLATFORM, action: "dwell" },
      { db: fakeDb({ conn: { posting_penalty_until: future } }), env: ON },
    ),
    true,
  );
  // an EXPIRED penalty does not block post either
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  assert.strictEqual(
    await assertAllowed(
      { phone: PHONE, platform: PLATFORM, action: "post" },
      { db: fakeDb({ conn: { posting_penalty_until: past, posting_permission: GRANTED } }), env: ON },
    ),
    true,
  );

  // ── profile_revoked: <platform>_profile_state in revoked|quarantined ──
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "session" },
    { db: fakeDb({ conn: { facebook_profile_state: "revoked" } }), env: ON },
    "profile_revoked",
  );
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "navigate" },
    { db: fakeDb({ conn: { facebook_profile_state: "quarantined" } }), env: ON },
    "profile_revoked",
  );

  // ── no_permission: post/like/story/reserve need a posting_permission that is enabled ──
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "reserve" },
    { db: fakeDb({ conn: {} }), env: ON },
    "no_permission",
  );
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "post" },
    { db: fakeDb({ conn: { posting_permission: { enabled: false, platforms: ["facebook"] } } }), env: ON },
    "no_permission",
  );

  // ── permission_scope: permission enabled but this platform is not included ──
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "post" },
    { db: fakeDb({ conn: { posting_permission: { enabled: true, platforms: ["yad2"] } } }), env: ON },
    "permission_scope",
  );

  // ── visible_not_allowed: permission granted but not for visible interactions ──
  await denies(
    { phone: PHONE, platform: PLATFORM, action: "like" },
    { db: fakeDb({ conn: { posting_permission: { enabled: true, platforms: ["facebook"], allows_visible_interactions: false } } }), env: ON },
    "visible_not_allowed",
  );

  // ── allowed: dwell needs no posting_permission at all ──
  assert.strictEqual(
    await assertAllowed({ phone: PHONE, platform: PLATFORM, action: "dwell" }, { db: fakeDb(), env: ON }),
    true,
  );
  // ── allowed: session/navigate/retry likewise need no permission ──
  for (const action of ["session", "navigate", "retry"]) {
    assert.strictEqual(
      await assertAllowed({ phone: PHONE, platform: PLATFORM, action }, { db: fakeDb(), env: ON }),
      true,
      `${action} should not require posting_permission`,
    );
  }
  // ── allowed: post with a full, scoped permission ──
  assert.strictEqual(
    await assertAllowed(
      { phone: PHONE, platform: PLATFORM, action: "post" },
      { db: fakeDb({ conn: { posting_permission: GRANTED } }), env: ON },
    ),
    true,
  );

  // ── default OFF (I5): a missing settings/posting doc, or enabled not strictly true, is global_off ──
  for (const settings of [null, {}, { enabled: "true" }, { enabled: 1 }, { enabled: null }, { version: 3 }]) {
    await denies({ phone: PHONE, platform: PLATFORM, action: "dwell" }, { db: fakeDb({ settings }), env: ON }, "global_off");
    await assert.rejects(() => assertFleetAllowed({ platform: PLATFORM }, { db: fakeDb({ settings }), env: ON }), (e) => e.reason === "global_off");
  }
  // …and the env must say POSTING_ENABLED=1: unset, "0", "" or anything else is env_off, before the doc is read
  for (const env of [{}, { POSTING_ENABLED: "0" }, { POSTING_ENABLED: "" }, { POSTING_ENABLED: "true" }, { POSTING_ENABLED: "yes" }]) {
    await denies({ phone: PHONE, platform: PLATFORM, action: "dwell" }, { db: fakeDb(), env }, "env_off");
  }
  assert.deepStrictEqual(await assertFleetAllowed({ platform: PLATFORM }, { db: fakeDb(), env: ON }), ENABLED);

  // ── postingEnvAllowed (C1): prod, or POSTING_SWEEPER=1 off staging; never staging ──
  const table = [
    [{ FORLY_ENV: "prod" }, true],
    [{ FORLY_ENV: "prod", POSTING_SWEEPER: "1" }, true],
    [{ FORLY_ENV: "prod", POSTING_SWEEPER: "0" }, true],
    [{ FORLY_ENV: "staging" }, false],
    [{ FORLY_ENV: "staging", POSTING_SWEEPER: "1" }, false],
    [{ FORLY_ENV: "local" }, false],
    [{ FORLY_ENV: "local", POSTING_SWEEPER: "1" }, true],
    [{ FORLY_ENV: "local", POSTING_SWEEPER: "true" }, false],
    [{ POSTING_SWEEPER: "1" }, true],
    [{}, false],
    [{ FORLY_ENV: "production" }, false],
  ];
  for (const [env, want] of table) assert.strictEqual(postingEnvAllowed(env), want, JSON.stringify(env));
  assert.strictEqual(postingEnvAllowed(undefined), false);
  assert.strictEqual(postingEnvAllowed(null), false);

  // ── no caching: a switch flipped between two calls is seen by the second ──
  {
    const settings = { enabled: true };
    const deps = { db: fakeDb({ settings }), env: ON };
    assert.strictEqual(await assertAllowed({ phone: PHONE, platform: PLATFORM, action: "dwell" }, deps), true);
    settings.enabled = false;
    await denies({ phone: PHONE, platform: PLATFORM, action: "dwell" }, deps, "global_off");
  }

  // ── default deps: db defaults to the real module, env to process.env ──
  {
    const saved = process.env.POSTING_ENABLED;
    process.env.POSTING_ENABLED = "0";
    await denies({ phone: PHONE, platform: PLATFORM, action: "dwell" }, {}, "env_off");
    delete process.env.POSTING_ENABLED;
    await denies({ phone: PHONE, platform: PLATFORM, action: "dwell" }, {}, "env_off");
    // env on, and the real db (memory path) holds no settings/posting doc: global_off
    process.env.POSTING_ENABLED = "1";
    await denies({ phone: PHONE, platform: PLATFORM, action: "dwell" }, {}, "global_off");
    if (saved === undefined) delete process.env.POSTING_ENABLED; else process.env.POSTING_ENABLED = saved;
  }

  console.log("posting-guard.test.js ok");
})().catch((err) => { console.error(err); process.exit(1); });
