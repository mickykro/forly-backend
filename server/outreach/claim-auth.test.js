const test = require("node:test");
const assert = require("node:assert/strict");
const { createClaimAuth } = require("./claim-auth");
const { createMemoryStore } = require("./store");
function setup() {
  let code;
  const claims = [];
  let time = 1000000;
  const store = createMemoryStore();
  const auth = createClaimAuth({
    store,
    secret: "claim-test-secret",
    now: () => time,
    service: {
      demoForToken: async () => ({ id: "d", status: "active" }),
      active: () => true,
      claimDemo: async (token, input, actor) => claims.push(actor.userId),
    },
    sendCode: async (phone, value) => {
      code = value;
    },
  });
  return {
    auth,
    store,
    claims,
    get code() {
      return code;
    },
    advance: () => (time += 61000),
  };
}
test("new prospect verifies a demo scoped code without general login", async () => {
  const s = setup();
  await s.auth.request("token", { phone: "0501234567" }, "ip");
  await s.auth.verify("token", {
    phone: "0501234567",
    code: s.code,
    acknowledged: true,
  });
  assert.deepEqual(s.claims, ["972501234567"]);
  await assert.rejects(
    s.auth.verify("token", {
      phone: "0501234567",
      code: s.code,
      acknowledged: true,
    }),
    /invalid_code/,
  );
});
test("invalid attempts persist and lock code, challenge contains no phone or OTP", async () => {
  const s = setup();
  await s.auth.request("token", { phone: "0501234567" }, "ip");
  const rows = await s.store.list("challenges");
  assert.ok(!JSON.stringify(rows).includes("0501234567"));
  assert.ok(!JSON.stringify(rows).includes(s.code));
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      s.auth.verify("token", {
        phone: "0501234567",
        code: "wrong",
        acknowledged: true,
      }),
      /invalid_code/,
    );
  await assert.rejects(
    s.auth.verify("token", {
      phone: "0501234567",
      code: s.code,
      acknowledged: true,
    }),
    /invalid_code/,
  );
  assert.equal(s.claims.length, 0);
});
test("sending throttles duplicate requests and bounds IP use", async () => {
  const s = setup();
  await s.auth.request("token", { phone: "0501234567" }, "ip");
  await assert.rejects(
    s.auth.request("token", { phone: "0501234567" }, "ip"),
    /rate_limited/,
  );
});
test("code cannot transfer to another token or phone and requires acknowledgement", async () => {
  const s = setup();
  await s.auth.request("token", { phone: "0501234567" }, "ip");
  await assert.rejects(
    s.auth.verify("other", {
      phone: "0501234567",
      code: s.code,
      acknowledged: true,
    }),
    /invalid_code/,
  );
  await assert.rejects(
    s.auth.verify("token", {
      phone: "0501234568",
      code: s.code,
      acknowledged: true,
    }),
    /invalid_code/,
  );
  await assert.rejects(
    s.auth.verify("token", { phone: "0501234567", code: s.code }),
    /acknowledgement_required/,
  );
});
