const path = require("node:path");
const fs = require("node:fs");
function canonicalPath(value) {
  const resolved = path.resolve(value);
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
  const parent = path.dirname(resolved);
  return parent === resolved
    ? resolved
    : path.join(canonicalPath(parent), path.basename(resolved));
}
function readConfig(env = process.env) {
  const enabled = env.OUTREACH_ENABLED === "true";
  const config = {
    enabled,
    policyApproved: env.OUTREACH_POLICY_APPROVED === "true",
    secret: env.OUTREACH_HMAC_SECRET || "",
    privateDir: canonicalPath(
      env.OUTREACH_PRIVATE_DIR ||
        path.join(__dirname, "../data/outreach-private"),
    ),
    operatorPhone: env.OUTREACH_OPERATOR_PHONE || "",
    webhook: env.OUTREACH_N8N_WEBHOOK_URL || "",
    baseUrl: (env.BASE_URL || "").replace(/\/$/, ""),
    callbackSecret: env.CALLBACK_HMAC_SECRET || "",
  };
  if (!enabled) return config;
  if (config.secret.length < 32)
    throw new Error("OUTREACH_HMAC_SECRET requires at least 32 characters");
  if (
    config.secret === env.NADLAN_JWT_SECRET ||
    config.secret === env.CALLBACK_HMAC_SECRET
  )
    throw new Error("Outreach requires a purpose-specific secret");
  const publicRoot = path.resolve(
    env.UPLOAD_DIR || path.join(__dirname, "../data/uploads"),
  );
  const staticRoots = [
    publicRoot,
    path.join(__dirname, "../../public-agent"),
    path.join(__dirname, "../../public-nadlan"),
  ].map(canonicalPath);
  if (
    staticRoots.some(
      (root) =>
        config.privateDir === root ||
        config.privateDir.startsWith(root + path.sep),
    )
  )
    throw new Error(
      "OUTREACH_PRIVATE_DIR must be outside public static directories",
    );
  if (env.FORLY_ENV === "staging") {
    let credentialProject;
    if (env.GOOGLE_APPLICATION_CREDENTIALS) {
      credentialProject = JSON.parse(
        require("node:fs").readFileSync(
          env.GOOGLE_APPLICATION_CREDENTIALS,
          "utf8",
        ),
      ).project_id;
    }
    const project =
      credentialProject || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT;
    if (
      !env.OUTREACH_PRODUCTION_PROJECT ||
      !env.OUTREACH_FIREBASE_PROJECT ||
      project !== env.OUTREACH_FIREBASE_PROJECT ||
      project === env.OUTREACH_PRODUCTION_PROJECT
    )
      throw new Error(
        "Outreach staging requires isolated Firebase credentials and project",
      );
  }
  if (config.callbackSecret.length < 32)
    throw new Error("CALLBACK_HMAC_SECRET requires at least 32 characters");
  const publicUrl = new URL(config.baseUrl);
  if (
    publicUrl.protocol !== "https:" ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash
  )
    throw new Error("Outreach BASE_URL must be an HTTPS origin");
  if (config.webhook) {
    const webhook = new URL(config.webhook);
    if (webhook.protocol !== "https:" || webhook.username || webhook.password)
      throw new Error("Outreach webhook must use HTTPS");
  }
  return config;
}
module.exports = { readConfig };
