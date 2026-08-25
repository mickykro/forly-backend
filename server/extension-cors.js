/*
 * CORS guard for the Forly browser companion.
 *
 * The extension's X-Forly-Ext header triggers a browser preflight. This
 * middleware permits only the configured chrome-extension://<id> origin and
 * only when mounted on the companion's API route.
 */

module.exports = function createExtensionCors(extensionId) {
  const id = String(extensionId || "").trim();
  const expectedOrigin = id ? `chrome-extension://${id}` : "";

  return function allowExtensionCors(req, res, next) {
    const origin = req.get("Origin") || "";
    if (!expectedOrigin || origin !== expectedOrigin) return next();

    res.set({
      "Access-Control-Allow-Origin": expectedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Forly-Ext",
      "Access-Control-Max-Age": "600",
    });
    res.vary("Origin");
    if (req.method === "OPTIONS") return res.status(204).end();
    return next();
  };
};
