/*
 * payments/cardcom.js — Cardcom LowProfile (hosted payment page), API v11.
 * createPaymentPage() opens a page for one order; getResult() is the server-side
 * check the webhook relies on — the webhook body itself is never trusted.
 */

const BASE = (process.env.CARDCOM_API_BASE || "https://secure.cardcom.solutions/api/v11").replace(/\/+$/, "");

function createCardcom({ terminal, apiName, fetchFn = fetch }) {
  const configured = !!(terminal && apiName);

  async function call(path, body) {
    const r = await fetchFn(`${BASE}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ TerminalNumber: Number(terminal), ApiName: apiName, ...body }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || Number(data.ResponseCode) !== 0) {
      throw new Error(`cardcom ${path} failed: ${data.ResponseCode} ${data.Description || r.status}`);
    }
    return data;
  }

  async function createPaymentPage({ orderId, amount, description, payerName, payerPhone, successUrl, failedUrl, webhookUrl }) {
    const d = await call("LowProfile/Create", {
      Operation: "ChargeOnly", ReturnValue: orderId, Amount: amount, ISOCoinId: 1, Language: "he",
      ProductName: description, SuccessRedirectUrl: successUrl, FailedRedirectUrl: failedUrl, WebHookUrl: webhookUrl,
      Document: {
        DocumentTypeToCreate: "Receipt", Name: payerName || payerPhone, Mobile: payerPhone,
        Products: [{ Description: description, UnitCost: amount, Quantity: 1 }],
      },
    });
    return { lowProfileId: d.LowProfileId, url: d.Url };
  }

  async function getResult(lowProfileId) {
    const d = await call("LowProfile/GetLpResult", { LowProfileId: lowProfileId });
    const t = d.TranzactionInfo;
    return {
      orderId: d.ReturnValue,
      amount: t ? Number(t.Amount) : 0,
      approved: !!t && Number(t.ResponseCode) === 0,
      transactionId: t ? (t.TranzactionId ?? null) : null, // never undefined: Firestore rejects it
    };
  }

  return { configured, createPaymentPage, getResult };
}

module.exports = { createCardcom };
