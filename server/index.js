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

// Session/action/OTP signing key. Everything that proves identity is signed
// with this, so a missing or placeholder value means anyone could forge a
// session. Refuse to boot in production without a real secret; in local dev
// fall back to an ephemeral random key (never the old public constant) so the
// app still runs but sessions reset on restart. NADLAN_JWT_SECRET is the
// canonical env var; FORLY_JWT_SECRET is accepted for back-compat.
const PLACEHOLDER_SECRETS = new Set(["", "change-me-in-env", "changeme", "secret"]);
function resolveAuthSecret() {
  const raw = (process.env.NADLAN_JWT_SECRET || process.env.FORLY_JWT_SECRET || "").trim();
  if (!PLACEHOLDER_SECRETS.has(raw)) return raw;
  if (process.env.NODE_ENV === "production") {
    console.error("FATAL: NADLAN_JWT_SECRET is missing or set to a placeholder. " +
      "Refusing to start — set a strong, random NADLAN_JWT_SECRET.");
    process.exit(1);
  }
  const ephemeral = require("crypto").randomBytes(32).toString("base64url");
  console.warn("WARNING: NADLAN_JWT_SECRET not set — using an ephemeral dev key. " +
    "Sessions will not survive a restart. Set NADLAN_JWT_SECRET for stable local auth.");
  return ephemeral;
}
const AUTH_SECRET = resolveAuthSecret();
// Secret for the maintenance/import admin API endpoints (x-admin-secret header).
// Dedicated var so it isn't the session-signing key; falls back to AUTH_SECRET
// for back-compat where only that was configured.
const ADMIN_API_SECRET = (process.env.ADMIN_API_SECRET || "").trim() || AUTH_SECRET;
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
// A number that tries to log in but has no businesses/{phone} doc isn't a
// Forly client yet — self-service signup off the login screen is gone (see
// the issue this shipped with), so the OTP route forwards them here as a
// lead for a human to follow up instead of leaving them stuck.
const SALES_LEAD_PHONE = normalizeAuthPhone(process.env.SALES_LEAD_PHONE || "972548018957");

// ── quotas (what each client paid for; set by hand in the admin panel) ──
// PAYMENT_LINK_URL: the external payment page shown to a client who hit their
// cap. N8N_WEBHOOK_SECRET: shared secret n8n sends (x-forly-secret) to
// /api/quota/consume before an image edit. See server/quota.js.
const PAYMENT_LINK_URL = (process.env.PAYMENT_LINK_URL || "").trim();
const N8N_WEBHOOK_SECRET = (process.env.N8N_WEBHOOK_SECRET || "").trim();
const { createQuota } = require("./quota");
const quota = createQuota({
  db: db.db,
  FieldValue: db.db ? require("firebase-admin").firestore.FieldValue : null,
  sendWhatsApp: (phone, msg) => sendWhatsApp(phone, msg, GREENAPI_INSTANCE, GREENAPI_TOKEN),
  adminPhone: SALES_LEAD_PHONE,
  paymentUrl: PAYMENT_LINK_URL,
});

// ── app ──
const app = express();
// Behind the Cloud Run / hosting proxy: trust X-Forwarded-* so req.secure and
// the rate limiter's client-IP keying are accurate.
app.set("trust proxy", true);

// Security headers on every response (clickjacking, MIME-sniff, referrer, HSTS).
const { securityHeaders, rateLimit } = require("./security");
app.use(securityHeaders);

app.use(express.json({ limit: "2mb" }));

// static files
// App shell always revalidates; the ETag makes an unchanged file a 304.
const revalidate = { index: "index.html", setHeaders: (res, file) => {
  if (/\.(html|js|css)$/.test(file)) res.setHeader("Cache-Control", "no-cache");
} };
app.use(express.static(path.join(__dirname, "..", "public-agent"), revalidate));
app.use(express.static(path.join(__dirname, "..", "public-nadlan"), revalidate));
app.use("/files", express.static(UPLOAD_DIR, { maxAge: "1d", immutable: true }));
app.use("/tpl", express.static(TEMPLATES_DIR));

// ── auth routes ──
// Throttle the OTP send/verify endpoints per IP (abuse / enumeration / SMS-cost
// protection) on top of the per-phone cooldowns enforced inside the router.
// Scoped to /otp and /verify so it never throttles /me polling or /logout.
app.use("/api/auth/otp", rateLimit({ windowMs: 60_000, max: 10 }));
app.use("/api/auth/verify", rateLimit({ windowMs: 60_000, max: 10 }));
app.use("/api/auth", createAuthRouter({
  db: db.db, mem: db.mem,
  sendWhatsApp: (phone, msg) => sendWhatsApp(phone, msg, GREENAPI_INSTANCE, GREENAPI_TOKEN),
  secret: AUTH_SECRET,
  salesLeadPhone: SALES_LEAD_PHONE,
}));

// ── intake routes (uploads, property creation) ──
const createIntakeRouter = require("./routes/intake");
// ── quota routes (n8n consume/status, agent /me) ──
const createQuotaRouter = require("./routes/quota");
app.use("/api/quota", createQuotaRouter({
  quota, requireAuth, authSecret: AUTH_SECRET, n8nSecret: N8N_WEBHOOK_SECRET, normalizeAuthPhone,
}));

app.use("/api", createIntakeRouter({
  requireAuth, normalizeAuthPhone, signSession,
  verifySession, readToken, adminPhones: ADMIN_PHONES, quota,
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
  sendWhatsApp: (phone, message) => sendWhatsApp(phone, message, GREENAPI_INSTANCE, GREENAPI_TOKEN),
  quota,
}));

// ── distribution routes (Meta OAuth, one-tap confirm, publish, groups) ──
const createDistributionRouter = require("./routes/distribution");
const distributionJobs = require("./distribution/jobs");
app.use("/api/distribution", createDistributionRouter({
  requireAuth, verifyActionToken, verifySession, readToken,
  authSecret: AUTH_SECRET,
  adminApiSecret: ADMIN_API_SECRET,
  pageBaseUrl: PAGE_BASE_URL,
  greenInstance: GREENAPI_INSTANCE,
  greenToken: GREENAPI_TOKEN,
}));

// signup redirect at root level
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
  quota,
  // Chat leads WhatsApp the agent directly (the form path relays via n8n).
  greenInstance: GREENAPI_INSTANCE,
  greenToken: GREENAPI_TOKEN,
}));

// Throttle the expensive ffmpeg video-overlay endpoint per IP (resource abuse).
app.use("/api/video-overlay", rateLimit({ windowMs: 60_000, max: 20 }));

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
  adminApiSecret: ADMIN_API_SECRET,
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
  console.log("  agent auth:  enabled");
  // Expiry scheduler retired: property pages no longer expire — the public
  // portal (call4li.com) lists every live page until the agent archives it.
  distributionJobs.startSweeper(distributionJobs.liveDeps({
    greenInstance: GREENAPI_INSTANCE, greenToken: GREENAPI_TOKEN,
    pageBaseUrl: PAGE_BASE_URL, authSecret: AUTH_SECRET,
  }));
});
