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
// Port precedence: CLI arg (e.g. `npm run local 3111`) → PORT env → default.
const cliPort = Number(process.argv[2]);
const PORT = Number.isInteger(cliPort) && cliPort > 0 && cliPort < 65536 ?
  cliPort : Number(process.env.PORT || 8787);
const BASE_URL = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "data", "uploads");
const PAGE_BASE_URL = (process.env.PAGE_BASE_URL || BASE_URL).replace(/\/+$/, "");
const REMOTE_UPLOAD_BASE = (process.env.REMOTE_UPLOAD_BASE || "").replace(/\/+$/, "");
const UPLOAD_PUBLIC_BASE = REMOTE_UPLOAD_BASE || BASE_URL;
const N8N_WW1_WEBHOOK_URL = process.env.N8N_WW1_WEBHOOK_URL || "";
const N8N_DEV_WEBHOOK_URL = process.env.N8N_DEV_WEBHOOK_URL || "";
const N8N_DEV_PIPELINE_WEBHOOK_URL = process.env.N8N_DEV_PIPELINE_WEBHOOK_URL || "";
const N8N_PIPELINE_WEBHOOK_URL = process.env.N8N_PIPELINE_WEBHOOK_URL || "";
const N8N_LEAD_WEBHOOK_URL = process.env.N8N_LEAD_WEBHOOK_URL || "";
const GREENAPI_INSTANCE = process.env.GREENAPI_INSTANCE || "";
const GREENAPI_TOKEN = process.env.GREENAPI_TOKEN || "";
const AUTH_SECRET = process.env.NADLAN_JWT_SECRET || "change-me-in-env";
// Operator admin panel: comma-separated allowlist of phone numbers permitted to
// see/manage EVERY agent's properties. Empty ⇒ admin panel denies everyone.
const ADMIN_PHONES = (process.env.ADMIN_PHONES || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
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
const { sendWhatsApp } = require("./utils");

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
  n8nWw1Webhook: N8N_DEV_WEBHOOK_URL || N8N_WW1_WEBHOOK_URL,
  n8nPipelineWebhook: N8N_DEV_PIPELINE_WEBHOOK_URL || N8N_PIPELINE_WEBHOOK_URL,
  isDevRun: !!N8N_DEV_WEBHOOK_URL,
  isDevPipelineRun: !!N8N_DEV_PIPELINE_WEBHOOK_URL,
  baseUrl: BASE_URL,
  authSecret: AUTH_SECRET,
  sessionTtl: SESSION_TTL_S,
  pageBaseUrl: PAGE_BASE_URL,
}));

// ── profile onboarding (the 15-field "השלמת פרופיל" form) ──
const createProfileRouter = require("./routes/profile");
app.use("/api", createProfileRouter({ requireAuth, authSecret: AUTH_SECRET }));

// ── dashboard routes (properties list, profile) ──
const createDashboardRouter = require("./routes/dashboard");
app.use("/api", createDashboardRouter({
  requireAuth,
  authSecret: AUTH_SECRET,
  pageBaseUrl: PAGE_BASE_URL,
  uploadDir: UPLOAD_DIR,
  greenInstance: GREENAPI_INSTANCE,
  greenToken: GREENAPI_TOKEN,
}));
// ── admin routes (all-agent property management, allowlist-gated) ──
const createAdminRouter = require("./routes/admin");
app.use("/api/admin", createAdminRouter({
  verifySession, readToken, normalizeAuthPhone,
  authSecret: AUTH_SECRET,
  pageBaseUrl: PAGE_BASE_URL,
  uploadDir: UPLOAD_DIR,
  adminPhones: ADMIN_PHONES,
}));

// ── signup / profile completion ──
// Two different things share the "signup" name: /signup.html registers a new
// agent (OTP), /profile.html completes the 15-field profile of one who already
// has an account. /signup keeps serving whichever the caller needs, so links
// sent out before the split still land somewhere sensible; the dashboard
// banner points straight at /profile.
const agentPage = (name) => path.join(__dirname, "..", "public-agent", name);

app.get("/signup", (req, res) => {
  const session = verifySession(AUTH_SECRET, readToken(req));
  if (session && session.userId) return res.sendFile(agentPage("profile.html"));
  res.sendFile(agentPage("signup.html"));
});

// Direct link to the profile form. Without a session there is nothing to
// complete yet, so send them through login — /api/onboarding would 401 anyway.
app.get("/profile", (req, res) => {
  const session = verifySession(AUTH_SECRET, readToken(req));
  if (session && session.userId) return res.sendFile(agentPage("profile.html"));
  res.redirect("/?next=" + encodeURIComponent("/profile"));
});

// ── portal routes (public buyer-facing catalog + realtime stream) ──
const createPortalRouter = require("./routes/portal");
app.use(createPortalRouter({ pageBaseUrl: PAGE_BASE_URL }));

// ── chat bot (public, gated per agent/page — see server/chatbot-config.js) ──
const createChatRouter = require("./routes/chat");
app.use(createChatRouter({
  // Whichever key the page's model needs — the provider follows the model id.
  apiKeys: {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  },
  ipSalt: process.env.CHATBOT_IP_SALT || AUTH_SECRET,
  // Chat leads WhatsApp the agent directly (the form path relays via n8n).
  greenInstance: GREENAPI_INSTANCE,
  greenToken: GREENAPI_TOKEN,
}));

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
  // page/update ownership check (see server/page-auth.js)
  verifySession, readToken, normalizeAuthPhone,
  adminPhones: ADMIN_PHONES,
}));

// ── start ──
app.listen(PORT, () => {
  console.log(`Forly server on ${BASE_URL} (port ${PORT})`);
  console.log(`  demo form:   ${BASE_URL}/create.html?key=demo`);
  console.log(`  pages served: ${PAGE_BASE_URL}/p/{id}`);
  console.log(`  uploads dir: ${UPLOAD_DIR}`);
  console.log(`  WW1 webhook: ${N8N_DEV_WEBHOOK_URL || N8N_WW1_WEBHOOK_URL || "(not set)"}${N8N_DEV_WEBHOOK_URL ? " [DEV]" : ""}`);
  console.log(`  pipeline webhook: ${N8N_DEV_PIPELINE_WEBHOOK_URL || N8N_PIPELINE_WEBHOOK_URL || "(not set)"}${N8N_DEV_PIPELINE_WEBHOOK_URL ? " [DEV]" : ""}`);
  console.log(`  agent auth:  ${AUTH_SECRET === "change-me-in-env" ? "DISABLED (set NADLAN_JWT_SECRET)" : "enabled"}`);
  // startExpiryScheduler({
  //   pageBaseUrl: PAGE_BASE_URL,
  //   authSecret: AUTH_SECRET,
  //   greenInstance: GREENAPI_INSTANCE,
  //   greenToken: GREENAPI_TOKEN,
  // });
  console.log(`  agent auth:  ${AUTH_SECRET === "change-me-in-env" ? "DISABLED (set FORLY_JWT_SECRET)" : "enabled"}`);
  // Expiry scheduler retired: property pages no longer expire — the public
  // portal (call4li.com) lists every live page until the agent archives it.
});
