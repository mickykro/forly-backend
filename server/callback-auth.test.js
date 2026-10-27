const assert = require("assert");
const {
  signCallback,
  createCallbackGuard,
  validateCallbackConfig,
} = require("./callback-auth");
assert.throws(
  () => validateCallbackConfig({ NODE_ENV: "production" }),
  /CALLBACK_HMAC_SECRET/,
);
(async () => {
  const secret = "a".repeat(40),
    now = 1700000000000,
    body = { listing_id: "one" };
  const guard = createCallbackGuard({ secret, now: () => now, maxDaily: 2 });
  const headers = signCallback({
    secret,
    purpose: "page",
    body,
    timestamp: now,
    requestId: "request-12345678",
  });
  async function invoke(headers, payload = body) {
    let result = {};
    const req = {
      headers,
      body: payload,
      get: (n) => headers[n.toLowerCase()],
    };
    const res = {
      status(n) {
        result.status = n;
        return this;
      },
      json(x) {
        result.body = x;
      },
      once() {},
    };
    await guard("page")(req, res, () => {
      result.next = true;
      req.callbackComplete?.();
    });
    return result;
  }
  assert.equal((await invoke(headers)).next, true);
  assert.equal((await invoke(headers)).status, 409);
  assert.equal(
    (
      await invoke(
        signCallback({
          secret,
          purpose: "overlay",
          body,
          timestamp: now,
          requestId: "request-22345678",
        }),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await invoke(
        signCallback({
          secret,
          purpose: "page",
          body,
          timestamp: now - 400000,
          requestId: "request-32345678",
        }),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await invoke(
        signCallback({
          secret,
          purpose: "page",
          body,
          timestamp: now,
          requestId: "request-42345678",
        }),
        { changed: true },
      )
    ).status,
    401,
  );
  assert.throws(
    () =>
      validateCallbackConfig({
        CALLBACK_HMAC_SECRET: secret,
        NADLAN_JWT_SECRET: secret,
      }),
    /purpose-specific/,
  );
  for (const cap of [NaN, 0, -1, Infinity, 1.5])
    assert.throws(
      () => createCallbackGuard({ secret, maxDaily: cap }),
      /invalid_callback_budget/,
    );
  const previousMode = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    assert.throws(() => createCallbackGuard({ secret }), /durable/);
    const memoryLedger = require("./outreach/callback-ledger");
    assert.throws(() => memoryLedger.createCallbackLedger(), /durable/);
  } finally {
    if (previousMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousMode;
  }
  let finishAdmission;
  const admission = new Promise((resolve) => (finishAdmission = resolve));
  let releaseCount = 0;
  const concurrent = createCallbackGuard({
    secret,
    now: () => now,
    maxConcurrent: 1,
    reserve: async () => {
      await admission;
      return { release: async () => releaseCount++ };
    },
  });
  const listeners = {};
  const reqOne = {
    body,
    get: (name) =>
      signCallback({
        secret,
        purpose: "overlay",
        body,
        timestamp: now,
        requestId: "concurrent-first-123",
      })[name],
  };
  const response = {
    once: (event, callback) => (listeners[event] = callback),
    status() {
      return this;
    },
    json() {},
  };
  const first = concurrent("overlay")(reqOne, response, () => {});
  let denied;
  const reqTwo = {
    body,
    get: (name) =>
      signCallback({
        secret,
        purpose: "overlay",
        body,
        timestamp: now,
        requestId: "concurrent-second-123",
      })[name],
  };
  await concurrent("overlay")(
    reqTwo,
    {
      status(code) {
        denied = code;
        return this;
      },
      json() {},
    },
    () => assert.fail("must cap pending reservation"),
  );
  assert.equal(denied, 429);
  finishAdmission();
  await first;
  listeners.close();
  assert.equal(
    releaseCount,
    0,
    "client disconnect must not release ongoing render budget",
  );
  reqOne.callbackComplete();
  reqOne.callbackComplete();
  await Promise.resolve();
  assert.equal(releaseCount, 1);
  console.log("callback auth tests passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
