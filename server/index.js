/*
 * Forly server — modular entry point
 * Routes split into: routes/intake.js, routes/dashboard.js, routes/pages.js
 */

const path = require("path");
const fs = require("fs");
const express = require("express");
const auth = require("./auth");

// ── .env loader ──
(function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith("#")) continue;
    const key = m[1];
    const val = m[2].trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = val;
  }
  console.log(`Loaded config from ${envPath}`);
})();

// ── config ──
const PORT = Number(process.env.PORT || 8787);
const BASE_URL = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "data", "uploads");
const PAGE_BASE_URL = (process.env.PAGE_BASE_URL || BASE_URL).replace(/\/+$/, "");
const REMOTE_UPLOAD_BASE = (process.env.REMOTE_UPLOAD_BASE || "").replace(/\/+$/, "");
const UPLOAD_PUBLIC_BASE = REMOTE_UPLOAD_BASE || BASE_URL;
const N8N_WW1_WEBHOOK_URL = process.env.N8N_WW1_WEBHOOK_URL || "";
const N8N_PIPELINE_WEBHOOK_URL = process.env.N8N_PIPELINE_WEBHOOK_URL || "";
const N8N_LEAD_WEBHOOK_URL = process.env.N8N_LEAD_WEBHOOK_URL || "";
const GREENAPI_INSTANCE = process.env.GREENAPI_INSTANCE || "";
const GREENAPI_TOKEN = process.env.GREENAPI_TOKEN || "";
const N8N_BEFORE_AFTER_WEBHOOK_URL = process.env.N8N_BEFORE_AFTER_WEBHOOK_URL || "";
const BA_CALLBACK_SECRET = process.env.BA_CALLBACK_SECRET || "";
const AUTH_SECRET = process.env.FORLY_JWT_SECRET || "change-me-in-env";
const WEB_SIGNUP_BASE = process.env.WEB_SIGNUP_URL || "https://call4li.web.app/signup";
const SESSION_TTL_S = 30 * 24 * 60 * 60;
const TEMPLATES_DIR = path.join(__dirname, "..", "public-nadlan", "templates");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── db init ──
const db = require("./db");
db.init();

// ── auth ──
const createAuthRouter = require("./auth");
const { requireAuth, normalizeAuthPhone, signSession, verifySession, readToken,
        signActionToken, verifyActionToken } = createAuthRouter;
const { sendWhatsApp, sendWhatsAppFile } = require("./utils");
const { startExpiryScheduler } = require("./lifecycle");

// ── app ──
const app = express();
app.use(express.json({ limit: "2mb" }));

// static files
app.use(express.static(path.join(__dirname, "..", "public-agent"), { index: "index.html" }));
app.use(express.static(path.join(__dirname, "..", "public-nadlan")));
app.use("/files", express.static(UPLOAD_DIR, { maxAge: "1d", immutable: true }));
app.use("/tpl", express.static(TEMPLATES_DIR));

// ── auth routes ──
app.use("/api/auth", createAuthRouter({
  db: db.db, mem: db.mem,
  sendWhatsApp: (phone, msg) => sendWhatsApp(phone, msg, GREENAPI_INSTANCE, GREENAPI_TOKEN),
  secret: AUTH_SECRET,
}));

// ── intake routes (uploads, property creation) ──
const createIntakeRouter = require("./routes/intake");
app.use("/api", createIntakeRouter({
  requireAuth, normalizeAuthPhone, signSession,
  uploadDir: UPLOAD_DIR,
  uploadPublicBase: UPLOAD_PUBLIC_BASE,
  remoteUploadBase: REMOTE_UPLOAD_BASE,
  n8nWw1Webhook: N8N_WW1_WEBHOOK_URL,
  n8nPipelineWebhook: N8N_PIPELINE_WEBHOOK_URL,
  authSecret: AUTH_SECRET,
  sessionTtl: SESSION_TTL_S,
  pageBaseUrl: PAGE_BASE_URL,
}));

// ── before/after video generator (generation runs in an n8n workflow) ──
const createBeforeAfterRouter = require("./routes/beforeAfter");
app.use("/api/before-after", createBeforeAfterRouter({
  requireAuth, authSecret: AUTH_SECRET,
  n8nWebhookUrl: N8N_BEFORE_AFTER_WEBHOOK_URL,
  callbackSecret: BA_CALLBACK_SECRET,
  uploadDir: UPLOAD_DIR,
  // Media is re-hosted to and served by THIS server (like pages.js rehosting),
  // so use its own public address, not the (proxy-aware) upload base.
  baseUrl: BASE_URL,
  sendWhatsAppFile: (phone, url, name, caption) =>
    sendWhatsAppFile(phone, url, name, caption, GREENAPI_INSTANCE, GREENAPI_TOKEN),
}));

// ── dashboard routes (properties list, profile) ──
const createDashboardRouter = require("./routes/dashboard");
app.use("/api", createDashboardRouter({
  requireAuth, verifySession, readToken,
  authSecret: AUTH_SECRET,
  pageBaseUrl: PAGE_BASE_URL,
  webSignupBase: WEB_SIGNUP_BASE,
  uploadDir: UPLOAD_DIR,
  greenInstance: GREENAPI_INSTANCE,
  greenToken: GREENAPI_TOKEN,
}));
// signup redirect at root level
app.get("/signup", (req, res) => {
  const session = verifySession(AUTH_SECRET, readToken(req));
  if (session && session.userId) {
    return res.redirect(`${WEB_SIGNUP_BASE}?phone=${encodeURIComponent(session.userId)}`);
  }
  res.sendFile(path.join(__dirname, "..", "public-agent", "signup.html"));
});

// ── pages routes (builder, serving, leads) ──
const createPagesRouter = require("./routes/pages");
app.use(createPagesRouter({
  uploadDir: UPLOAD_DIR,
  baseUrl: BASE_URL,
  pageBaseUrl: PAGE_BASE_URL,
  templatesDir: TEMPLATES_DIR,
  n8nLeadWebhook: N8N_LEAD_WEBHOOK_URL,
  greenInstance: GREENAPI_INSTANCE,
  greenToken: GREENAPI_TOKEN,
  requireAuth, verifyActionToken,
  authSecret: AUTH_SECRET,
}));

// ── start ──
app.listen(PORT, () => {
  console.log(`Forly server on ${BASE_URL} (port ${PORT})`);
  console.log(`  demo form:   ${BASE_URL}/create.html?key=demo`);
  console.log(`  pages served: ${PAGE_BASE_URL}/p/{id}`);
  console.log(`  uploads dir: ${UPLOAD_DIR}`);
  console.log(`  WW1 webhook: ${N8N_WW1_WEBHOOK_URL || "(not set)"}`);
  console.log(`  agent auth:  ${AUTH_SECRET === "change-me-in-env" ? "DISABLED (set FORLY_JWT_SECRET)" : "enabled"}`);
  console.log(`  before/after: ${N8N_BEFORE_AFTER_WEBHOOK_URL ? "enabled" : "DISABLED (set N8N_BEFORE_AFTER_WEBHOOK_URL)"}`);
  startExpiryScheduler({
    pageBaseUrl: PAGE_BASE_URL,
    authSecret: AUTH_SECRET,
    greenInstance: GREENAPI_INSTANCE,
    greenToken: GREENAPI_TOKEN,
  });
});
