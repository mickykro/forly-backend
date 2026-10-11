/*
 * Minimal Whapi.Cloud REST client for the Green API bridge. Base
 * https://gate.whapi.cloud, Authorization: Bearer <channel token>.
 * Errors carry .status and name the call, never the chat id.
 */

const TIMEOUT_MS = 20000;

function createWhapiClient({ token, baseUrl = "https://gate.whapi.cloud", fetchFn = fetch } = {}) {
  const base = String(baseUrl).trim().replace(/\/+$/, "");
  async function call(label, method, path, body) {
    const r = await fetchFn(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(`Whapi ${label} → ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return data;
  }
  return {
    sendText: (to, body, quoted) =>
      call("messages/text", "POST", "/messages/text", { to, body, ...(quoted ? { quoted } : {}) }),
    sendMedia: (kind, to, media, { caption, filename, quoted } = {}) =>
      call(`messages/${kind}`, "POST", `/messages/${kind}`, {
        to, media,
        ...(caption ? { caption } : {}),
        ...(kind === "document" && filename ? { filename } : {}),
        ...(quoted ? { quoted } : {}),
      }),
    listMessages: (chatId, count) =>
      call("messages/list", "GET", `/messages/list/${encodeURIComponent(chatId)}?count=${Number(count) || 100}`),
    getMessage: (id) => call("messages/get", "GET", `/messages/${encodeURIComponent(id)}`),
  };
}

module.exports = { createWhapiClient };
