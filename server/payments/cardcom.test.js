/* payments/cardcom.js — request shape and result parsing, with a fake fetch. */
const assert = require("assert");
const { createCardcom } = require("./cardcom");

function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => reply(url) };
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  assert.strictEqual(createCardcom({}).configured, false);

  // create: sends terminal, amount, order id, webhook; returns page url
  const f1 = fakeFetch(() => ({ ResponseCode: 0, LowProfileId: "lp-1", Url: "https://pay/lp-1" }));
  const c1 = createCardcom({ terminal: "1000", apiName: "test", fetchFn: f1 });
  const page = await c1.createPaymentPage({ orderId: "o1", amount: 59, description: "Reel", payerName: "Dana",
    payerPhone: "0501234567", successUrl: "https://x/reel?order=o1", failedUrl: "https://x/reel?order=o1&failed=1",
    webhookUrl: "https://x/api/promo/cardcom/webhook" });
  assert.deepStrictEqual(page, { lowProfileId: "lp-1", url: "https://pay/lp-1" });
  const b = f1.calls[0].body;
  assert.ok(f1.calls[0].url.endsWith("/LowProfile/Create"));
  assert.strictEqual(b.TerminalNumber, 1000);
  assert.strictEqual(b.ReturnValue, "o1");
  assert.strictEqual(b.Amount, 59);
  assert.strictEqual(b.WebHookUrl, "https://x/api/promo/cardcom/webhook");
  assert.strictEqual(b.Document.Products[0].UnitCost, 59);

  // getResult: approved transaction
  const f2 = fakeFetch(() => ({ ResponseCode: 0, ReturnValue: "o1", TranzactionInfo: { ResponseCode: 0, Amount: 59, TranzactionId: 777 } }));
  const r = await createCardcom({ terminal: "1000", apiName: "test", fetchFn: f2 }).getResult("lp-1");
  assert.deepStrictEqual(r, { orderId: "o1", amount: 59, approved: true, transactionId: 777 });

  // getResult: no transaction (page opened, never paid) → not approved
  const f3 = fakeFetch(() => ({ ResponseCode: 0, ReturnValue: "o1" }));
  assert.strictEqual((await createCardcom({ terminal: "1", apiName: "t", fetchFn: f3 }).getResult("lp-1")).approved, false);

  // API error → throws
  const f4 = fakeFetch(() => ({ ResponseCode: 5, Description: "bad terminal" }));
  await assert.rejects(createCardcom({ terminal: "1", apiName: "t", fetchFn: f4 }).getResult("lp-1"), /bad terminal/);

  console.log("cardcom.test.js OK");
})().catch((e) => { console.error(e); process.exit(1); });
